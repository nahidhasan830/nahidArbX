"""Tavily Search API provider.

AI-native search optimised for RAG/LLM workflows.  Returns clean,
citation-ready snippets.  Free tier: 1,000 credits/mo, no CC.

Live quota: Calls ``GET /usage`` endpoint to get server-authoritative
usage and limit data.

Docs: https://docs.tavily.com/
"""

from __future__ import annotations

import logging

import httpx
from tavily import AsyncTavilyClient

from app.models import SearchResult
from app.search.providers.base import BaseSearchProvider

log = logging.getLogger("ai-search.tavily")


class TavilySearchProvider(BaseSearchProvider):
    """Tavily — AI-native search with live quota from /usage API."""

    def __init__(self, api_key: str, monthly_limit: int = 1000) -> None:
        super().__init__("tavily", quota_limit=monthly_limit)
        self._api_key = api_key
        self._client: AsyncTavilyClient | None = None

    def _get_client(self) -> AsyncTavilyClient:
        if self._client is None:
            if not self._api_key:
                raise ValueError("Tavily API key not configured")
            self._client = AsyncTavilyClient(api_key=self._api_key)
        return self._client

    async def _do_search(
        self, query: str, max_results: int
    ) -> list[SearchResult]:
        client = self._get_client()
        response = await client.search(
            query=query,
            max_results=min(max_results, 10),
            search_depth="basic",
            include_answer=False,
        )

        results: list[SearchResult] = []
        for item in response.get("results", []):
            results.append(
                SearchResult(
                    title=item.get("title", ""),
                    url=item.get("url", ""),
                    snippet=item.get("content", ""),
                    source="tavily",
                    score=item.get("score"),
                )
            )

        log.debug("Tavily: %d results for %r", len(results), query)

        # Sync live usage after each search (cheap call, doesn't count against quota)
        await self.sync_usage()

        return results[:max_results]

    async def sync_usage(self) -> None:
        """Fetch real usage from Tavily's GET /usage endpoint.

        Response shape::

            {
              "key": {"usage": 42, "limit": 1000},
              "account": {"plan_usage": 42, "plan_limit": 1000}
            }

        This is a free call that doesn't consume credits.
        """
        if not self._api_key:
            return

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    "https://api.tavily.com/usage",
                    headers={"Authorization": f"Bearer {self._api_key}"},
                )
                resp.raise_for_status()
                data = resp.json()

            key = data.get("key", {})
            used = key.get("usage", 0)
            limit = key.get("limit", self._quota_limit or 1000)

            self._server_used = used
            self._server_limit = limit
            self._server_remaining = max(0, limit - used)

            log.debug(
                "Tavily live quota: %d/%d used (%d remaining)",
                used,
                limit,
                self._server_remaining,
            )
        except Exception as exc:
            log.warning("Failed to sync Tavily usage: %s", str(exc)[:200])
