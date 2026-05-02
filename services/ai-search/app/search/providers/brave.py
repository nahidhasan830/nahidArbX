"""Brave Search API provider.

Uses Brave's independent web index.  REST API, returns structured JSON.
Free tier: ~1,000 requests/mo via $5 monthly credit.

Docs: https://api.search.brave.com/app/#/documentation
"""

from __future__ import annotations

import logging

import httpx

from app.models import SearchResult
from app.search.providers.base import BaseSearchProvider

log = logging.getLogger("ai-search.brave")


class BraveSearchProvider(BaseSearchProvider):
    """Brave Search API — primary provider."""

    def __init__(self, api_key: str, monthly_limit: int = 1000) -> None:
        super().__init__("brave", quota_limit=monthly_limit)
        self._api_key = api_key
        self._base_url = "https://api.search.brave.com/res/v1/web/search"

    async def _do_search(
        self, query: str, max_results: int
    ) -> list[SearchResult]:
        if not self._api_key:
            raise ValueError("Brave API key not configured")

        headers = {
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": self._api_key,
        }
        params = {
            "q": query,
            "count": min(max_results, 20),
            "text_decorations": "false",
        }

        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                self._base_url, headers=headers, params=params
            )
            resp.raise_for_status()
            data = resp.json()

        results: list[SearchResult] = []
        for item in data.get("web", {}).get("results", []):
            results.append(
                SearchResult(
                    title=item.get("title", ""),
                    url=item.get("url", ""),
                    snippet=item.get("description", ""),
                    source="brave",
                )
            )

        log.debug("Brave: %d results for %r", len(results), query)
        return results[:max_results]
