"""Serper.dev — Google SERP API provider.

Returns structured Google search results.  2,500 free one-time credits
(no CC required).  After that, $1/1k requests.

Docs: https://serper.dev/
"""

from __future__ import annotations

import logging

import httpx

from app.models import SearchResult
from app.search.providers.base import BaseSearchProvider

log = logging.getLogger("ai-search.serper")


class SerperSearchProvider(BaseSearchProvider):
    """Serper.dev — Google SERP results, secondary provider."""

    def __init__(self, api_key: str, total_limit: int = 2500) -> None:
        # Serper uses one-time credits, not monthly — but the base class
        # quota tracking still works (just don't reset).
        super().__init__("serper", quota_limit=total_limit)
        self._api_key = api_key
        self._base_url = "https://google.serper.dev/search"

    def reset_usage(self) -> None:
        """Override: Serper credits are one-time, never reset."""
        pass

    async def _do_search(
        self, query: str, max_results: int
    ) -> list[SearchResult]:
        if not self._api_key:
            raise ValueError("Serper API key not configured")

        headers = {
            "X-API-KEY": self._api_key,
            "Content-Type": "application/json",
        }
        payload = {
            "q": query,
            "num": min(max_results, 10),
        }

        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                self._base_url, headers=headers, json=payload
            )
            resp.raise_for_status()
            data = resp.json()

        results: list[SearchResult] = []
        for item in data.get("organic", []):
            results.append(
                SearchResult(
                    title=item.get("title", ""),
                    url=item.get("link", ""),
                    snippet=item.get("snippet", ""),
                    source="serper",
                    score=item.get("position"),
                )
            )

        log.debug("Serper: %d results for %r", len(results), query)
        return results[:max_results]
