"""Base types and protocol for search providers.

Quota tracking is now live — providers that support server-side quota
(Brave via headers, Tavily via /usage API) populate _server_* fields.
Providers without an API (Serper) fall back to session counters.
DuckDuckGo has no quota concept.

QuotaStore is no longer used for search providers (LLM engines still use it).
"""

from __future__ import annotations

import abc
import logging
from datetime import datetime

from app.models import SearchResult

log = logging.getLogger("ai-search.provider")


class BaseSearchProvider(abc.ABC):
    """Abstract base for all search providers.

    Each provider tracks its own health status and quota.  Providers that
    support live quota from the server populate ``_server_remaining``,
    ``_server_limit``, and ``_server_used``.  Others fall back to a
    session-level request counter.
    """

    name: str
    _healthy: bool
    _enabled: bool
    _last_error: str | None
    _last_used_at: datetime | None
    _unhealthy_until: datetime | None

    def __init__(self, name: str, quota_limit: int | None = None) -> None:
        self.name = name
        self._quota_limit = quota_limit  # fallback/config limit
        self._healthy = True
        self._enabled = True
        self._last_error = None
        self._last_used_at = None
        self._unhealthy_until = None
        self._session_requests = 0  # requests in this process lifetime

        # Server-side quota — populated by subclasses that support live data
        self._server_remaining: int | None = None
        self._server_limit: int | None = None
        self._server_used: int | None = None

    @abc.abstractmethod
    async def _do_search(
        self, query: str, max_results: int
    ) -> list[SearchResult]:
        """Provider-specific search implementation."""
        ...

    async def search(self, query: str, max_results: int = 5) -> list[SearchResult]:
        """Execute a search, track usage, and handle errors.

        Raises on failure so the router can fall through.
        """
        results = await self._do_search(query, max_results)
        self._session_requests += 1
        self._last_used_at = datetime.now()
        self._healthy = True
        self._last_error = None
        return results

    def mark_unhealthy(self, error: str, cooldown_seconds: int = 60) -> None:
        """Mark provider as temporarily unhealthy."""
        self._healthy = False
        self._last_error = error
        self._unhealthy_until = datetime.fromtimestamp(
            datetime.now().timestamp() + cooldown_seconds
        )

    def is_healthy(self) -> bool:
        """Check if provider is available for requests."""
        if not self._healthy and self._unhealthy_until:
            if datetime.now() >= self._unhealthy_until:
                # Cooldown expired — give it another chance
                self._healthy = True
                self._unhealthy_until = None
        return self._healthy

    def has_quota(self) -> bool:
        """Check if provider has remaining quota."""
        if self._server_remaining is not None:
            return self._server_remaining > 0
        if self._quota_limit is None:
            return True
        # No server data, no way to verify — assume yes
        return True

    def remaining_quota(self) -> int | None:
        """Return remaining quota, or None if unlimited."""
        if self._server_remaining is not None:
            return self._server_remaining
        if self._quota_limit is None:
            return None
        # Serper: use config limit minus session requests as best guess
        return max(0, self._quota_limit - self._session_requests)

    @property
    def quota_source(self) -> str:
        """'live' if server data available, 'local' for session tracking, 'none' if unlimited."""
        if self._server_remaining is not None or self._server_used is not None:
            return "live"
        if self._quota_limit is not None:
            return "local"
        return "none"

    def reset_usage(self) -> None:
        """Reset session usage counter."""
        self._session_requests = 0

    def enable(self) -> None:
        """Enable provider for request routing."""
        self._enabled = True

    def disable(self) -> None:
        """Disable provider — skipped by the router until re-enabled."""
        self._enabled = False

    @property
    def enabled(self) -> bool:
        return self._enabled

    def stats(self) -> dict:
        """Return provider stats for the /stats endpoint."""
        # Use server data when available, fall back to session counter
        used = self._server_used if self._server_used is not None else self._session_requests
        limit = self._server_limit if self._server_limit is not None else self._quota_limit
        remaining = self._server_remaining
        if remaining is None and limit is not None and self._server_used is not None:
            remaining = max(0, limit - self._server_used)
        elif remaining is None and self._quota_limit is not None:
            remaining = max(0, self._quota_limit - self._session_requests)

        return {
            "name": self.name,
            "healthy": self.is_healthy(),
            "enabled": self._enabled,
            "requests_used": used,
            "quota_limit": limit,
            "quota_remaining": remaining,
            "quota_source": self.quota_source,
            "last_error": self._last_error,
            "last_used_at": (
                self._last_used_at.isoformat() if self._last_used_at else None
            ),
        }
