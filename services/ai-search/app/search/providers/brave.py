"""Brave Search API provider.

Uses Brave's independent web index.  REST API, returns structured JSON.
Free tier: ~1,000 requests/mo via $5 monthly credit.

Live quota: Parses ``X-RateLimit-Remaining`` and ``X-RateLimit-Limit``
from every response header to show server-authoritative remaining quota.

Docs: https://api.search.brave.com/app/#/documentation
"""

from __future__ import annotations

import logging

import httpx

from app.models import SearchResult
from app.search.providers.base import BaseSearchProvider, QueryValidationError

log = logging.getLogger("ai-search.brave")


class BraveSearchProvider(BaseSearchProvider):
    """Brave Search API — primary provider with live quota from headers."""

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
            if resp.status_code == 422:
                detail = resp.text[:300] if resp.text else "Unprocessable Entity"
                raise QueryValidationError(
                    f"Brave rejected query (422): {detail}"
                )
            resp.raise_for_status()

            # ── Live quota from response headers ─────────────────────
            self._parse_rate_limit_headers(resp.headers)

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

    def _parse_rate_limit_headers(self, headers: httpx.Headers) -> None:
        """Extract monthly quota from Brave rate-limit headers.

        Brave returns:
          X-RateLimit-Limit: 1000
          X-RateLimit-Remaining: 992
          X-RateLimit-Policy: 1;w=1, 1000;w=2592000

        When multiple policies exist (per-second + monthly), we use the
        policy header to identify the monthly limit and only update
        server quota when the limit matches the monthly window.
        """
        remaining_str = headers.get("x-ratelimit-remaining")
        limit_str = headers.get("x-ratelimit-limit")
        policy = headers.get("x-ratelimit-policy", "")

        if remaining_str is None or limit_str is None:
            return

        try:
            remaining = int(remaining_str)
            limit = int(limit_str)
        except (ValueError, TypeError):
            return

        # Find the monthly window limit from the policy header
        # Format: "1;w=1, 1000;w=2592000"
        monthly_limit = self._parse_monthly_limit(policy)

        if monthly_limit is not None:
            # Use the monthly policy limit — the Remaining header is
            # authoritative only when it matches the monthly window
            if limit == monthly_limit:
                self._server_remaining = remaining
                self._server_limit = monthly_limit
                self._server_used = monthly_limit - remaining
                log.debug(
                    "Brave live quota: %d/%d remaining",
                    remaining,
                    monthly_limit,
                )
            # If limit != monthly_limit, headers show per-second window — skip
        elif limit >= 100:
            # No policy header but limit looks like monthly (not per-second)
            self._server_remaining = remaining
            self._server_limit = limit
            self._server_used = limit - remaining

    @staticmethod
    def _parse_monthly_limit(policy: str) -> int | None:
        """Parse the monthly limit from X-RateLimit-Policy.

        Returns the limit value for the window >= 1 day (86400s).
        """
        if not policy:
            return None
        for part in policy.split(","):
            part = part.strip()
            if ";w=" in part:
                try:
                    limit_part, window_part = part.split(";w=", 1)
                    window = int(window_part)
                    if window >= 86400:  # at least 1 day
                        return int(limit_part)
                except (ValueError, IndexError):
                    continue
        return None
