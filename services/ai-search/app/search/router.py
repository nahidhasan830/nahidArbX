"""SearchRouter — load-balanced multi-provider search with failover.

Routes queries across Brave, Tavily, Serper, and DuckDuckGo with:
- Priority-based selection (healthy + has quota)
- Automatic failover on error (marks unhealthy with 60s cooldown)
- Optional fan-out to multiple providers for higher recall
- Result deduplication by URL
- Per-provider usage tracking for /stats
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime

from app.config import Config
from app.models import SearchResult
from app.search.providers.base import BaseSearchProvider
from app.search.providers.brave import BraveSearchProvider
from app.search.providers.duckduckgo import DuckDuckGoSearchProvider
from app.search.providers.serper import SerperSearchProvider
from app.search.providers.tavily import TavilySearchProvider

log = logging.getLogger("ai-search.router")


class SearchRouter:
    """Multi-provider search with automatic failover and quota tracking."""

    def __init__(self, config: Config) -> None:
        self._config = config

        # Build providers in priority order
        self._providers: list[BaseSearchProvider] = []

        if config.brave_api_key:
            self._providers.append(
                BraveSearchProvider(
                    api_key=config.brave_api_key,
                    monthly_limit=config.brave_monthly_limit,
                )
            )
            log.info("Brave Search enabled (limit %d/mo)", config.brave_monthly_limit)
        else:
            log.warning("Brave Search disabled — no API key")

        if config.tavily_api_key:
            self._providers.append(
                TavilySearchProvider(
                    api_key=config.tavily_api_key,
                    monthly_limit=config.tavily_monthly_limit,
                )
            )
            log.info("Tavily enabled (limit %d/mo)", config.tavily_monthly_limit)
        else:
            log.warning("Tavily disabled — no API key")

        if config.serper_api_key:
            self._providers.append(
                SerperSearchProvider(
                    api_key=config.serper_api_key,
                    total_limit=config.serper_total_limit,
                )
            )
            log.info("Serper enabled (limit %d total)", config.serper_total_limit)
        else:
            log.warning("Serper disabled — no API key")

        # DDG is always available (no key needed)
        self._providers.append(DuckDuckGoSearchProvider())
        log.info("DuckDuckGo enabled (fallback, no quota)")

        self._total_searches = 0

    @property
    def providers(self) -> list[BaseSearchProvider]:
        return list(self._providers)

    async def search(
        self,
        query: str,
        *,
        max_results: int = 5,
        fan_out: int = 1,
        dedupe: bool = True,
        preferred_providers: list[str] | None = None,
    ) -> tuple[list[SearchResult], str]:
        """Execute a search with failover.

        Returns (results, provider_name_used).

        If fan_out > 1, queries multiple providers concurrently and
        merges + dedupes results.
        """
        if fan_out > 1:
            return await self._fan_out_search(
                query, max_results=max_results, fan_out=fan_out, dedupe=dedupe
            )

        # Single-provider search with failover
        available = self._get_available_providers(preferred_providers)

        for provider in available:
            try:
                results = await provider.search(query, max_results)
                self._total_searches += 1
                log.info(
                    "Search via %s: %d results for %r",
                    provider.name,
                    len(results),
                    query[:80],
                )
                return results, provider.name
            except Exception as exc:
                log.warning(
                    "Provider %s failed: %s — trying next",
                    provider.name,
                    str(exc)[:200],
                )
                provider.mark_unhealthy(str(exc))
                continue

        log.error("All search providers failed for query: %r", query[:80])
        return [], "none"

    async def _fan_out_search(
        self,
        query: str,
        *,
        max_results: int,
        fan_out: int,
        dedupe: bool,
    ) -> tuple[list[SearchResult], str]:
        """Query multiple providers concurrently, merge results."""
        available = self._get_available_providers()[:fan_out]

        if not available:
            return [], "none"

        tasks = [
            self._safe_search(provider, query, max_results)
            for provider in available
        ]
        results_sets = await asyncio.gather(*tasks)

        # Merge all results
        all_results: list[SearchResult] = []
        providers_used: list[str] = []

        for results, provider_name in results_sets:
            if results:
                all_results.extend(results)
                providers_used.append(provider_name)

        # Deduplicate by URL
        if dedupe:
            seen_urls: set[str] = set()
            deduped: list[SearchResult] = []
            for r in all_results:
                url_key = r.url.rstrip("/").lower()
                if url_key not in seen_urls:
                    seen_urls.add(url_key)
                    deduped.append(r)
            all_results = deduped

        self._total_searches += 1
        provider_label = "+".join(providers_used) or "none"
        log.info(
            "Fan-out search via %s: %d results for %r",
            provider_label,
            len(all_results),
            query[:80],
        )
        return all_results[:max_results * fan_out], provider_label

    async def _safe_search(
        self, provider: BaseSearchProvider, query: str, max_results: int
    ) -> tuple[list[SearchResult], str]:
        """Search with exception swallowing for fan-out."""
        try:
            results = await provider.search(query, max_results)
            return results, provider.name
        except Exception as exc:
            log.warning("Fan-out: %s failed: %s", provider.name, str(exc)[:200])
            provider.mark_unhealthy(str(exc))
            return [], provider.name

    def _get_available_providers(
        self, preferred: list[str] | None = None
    ) -> list[BaseSearchProvider]:
        """Get providers sorted by priority, filtered to healthy + has quota.

        If `preferred` is set, only those providers (if available).
        """
        candidates = self._providers

        if preferred:
            preferred_set = set(p.lower() for p in preferred)
            candidates = [
                p for p in candidates if p.name.lower() in preferred_set
            ]
            # Fall back to all providers if none match
            if not candidates:
                candidates = self._providers

        return [p for p in candidates if p.is_healthy() and p.has_quota() and p.enabled]

    def get_stats(self) -> dict:
        """Return aggregate stats for the /stats endpoint."""
        return {
            "providers": [p.stats() for p in self._providers],
            "total_searches": self._total_searches,
        }

    def toggle_provider(self, name: str, enabled: bool) -> bool:
        """Enable or disable a provider by name. Returns True if found."""
        for p in self._providers:
            if p.name.lower() == name.lower():
                if enabled:
                    p.enable()
                else:
                    p.disable()
                log.info("Provider %s %s", p.name, "enabled" if enabled else "disabled")
                return True
        return False

    def reset_monthly_counters(self) -> None:
        """Reset monthly usage for all providers (except Serper)."""
        for p in self._providers:
            p.reset_usage()
        log.info("Monthly usage counters reset")
