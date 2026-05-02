"""DuckDuckGo search provider — async with retry + backoff.

Uses the ``duckduckgo-search`` library's ``AsyncDDGS`` for non-blocking
operation.  Retries with exponential backoff to handle DDG's aggressive
rate-limiting (which returns 0 results rather than an error).

WARNING: Not an official API.  May break if DDG changes their anti-bot
measures.  Suitable for overflow / fallback only.
"""

from __future__ import annotations

import asyncio
import logging
import time

from duckduckgo_search import DDGS

from app.models import SearchResult
from app.search.providers.base import BaseSearchProvider

log = logging.getLogger("ai-search.ddg")

# Minimum interval between DDG queries (seconds)
_DDG_MIN_INTERVAL = 2.0
_DDG_MAX_RETRIES = 3
_DDG_BASE_DELAY = 1.5  # exponential backoff base


def _sync_ddg_search(query: str, max_results: int) -> list[dict]:
    """Run DDG search synchronously (called via asyncio.to_thread)."""
    with DDGS() as ddgs:
        return list(ddgs.text(query, max_results=min(max_results, 10)))


class DuckDuckGoSearchProvider(BaseSearchProvider):
    """DuckDuckGo — unofficial scraper, fallback provider."""

    def __init__(self) -> None:
        # No quota limit — but rate-limited in practice
        super().__init__("duckduckgo", quota_limit=None)
        self._last_query_at: float = 0.0

    async def _do_search(
        self, query: str, max_results: int
    ) -> list[SearchResult]:
        # Rate limiter: ensure minimum interval between queries
        now = time.monotonic()
        elapsed = now - self._last_query_at
        if elapsed < _DDG_MIN_INTERVAL:
            await asyncio.sleep(_DDG_MIN_INTERVAL - elapsed)

        results: list[SearchResult] = []
        last_exc: Exception | None = None

        for attempt in range(_DDG_MAX_RETRIES):
            try:
                self._last_query_at = time.monotonic()
                raw_results = await asyncio.to_thread(
                    _sync_ddg_search, query, max_results
                )

                results = []
                for item in raw_results:
                    results.append(
                        SearchResult(
                            title=item.get("title", ""),
                            url=item.get("href", ""),
                            snippet=item.get("body", ""),
                            source="duckduckgo",
                        )
                    )

                if results:
                    log.debug(
                        "DDG: %d results for %r (attempt %d)",
                        len(results),
                        query,
                        attempt + 1,
                    )
                    return results[:max_results]

                # 0 results = likely rate-limited, retry with backoff
                if attempt < _DDG_MAX_RETRIES - 1:
                    delay = _DDG_BASE_DELAY * (2**attempt)
                    log.info(
                        "DDG: 0 results for %r, retry in %.1fs (attempt %d/%d)",
                        query[:60],
                        delay,
                        attempt + 1,
                        _DDG_MAX_RETRIES,
                    )
                    await asyncio.sleep(delay)

            except Exception as exc:
                last_exc = exc
                if attempt < _DDG_MAX_RETRIES - 1:
                    delay = _DDG_BASE_DELAY * (2**attempt)
                    log.warning(
                        "DDG error: %s — retry in %.1fs (attempt %d/%d)",
                        str(exc)[:100],
                        delay,
                        attempt + 1,
                        _DDG_MAX_RETRIES,
                    )
                    await asyncio.sleep(delay)
                else:
                    log.error(
                        "DDG failed after %d attempts: %s",
                        _DDG_MAX_RETRIES,
                        str(exc)[:200],
                    )

        # All retries exhausted
        if last_exc and not results:
            raise last_exc

        log.warning(
            "DDG: 0 results after %d attempts for %r",
            _DDG_MAX_RETRIES,
            query[:60],
        )
        return []
