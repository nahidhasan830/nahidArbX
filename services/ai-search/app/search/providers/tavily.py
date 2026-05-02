"""Tavily Search API provider.

AI-native search optimised for RAG/LLM workflows.  Returns clean,
citation-ready snippets.  Free tier: 1,000 credits/mo, no CC.

Docs: https://docs.tavily.com/
"""

from __future__ import annotations

import logging

from tavily import AsyncTavilyClient

from app.models import SearchResult
from app.search.providers.base import BaseSearchProvider

log = logging.getLogger("ai-search.tavily")


class TavilySearchProvider(BaseSearchProvider):
    """Tavily — AI-native search, primary provider."""

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
        return results[:max_results]
