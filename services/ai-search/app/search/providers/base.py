"""Base types and protocol for search providers."""

from __future__ import annotations

import abc
import logging
from datetime import datetime

from app.models import SearchResult
from app.quota_store import get_store

log = logging.getLogger("ai-search.provider")


class BaseSearchProvider(abc.ABC):
    """Abstract base for all search providers.

    Each provider tracks its own usage counter, health status, and
    optional quota limit.  The SearchRouter inspects these to decide
    which provider to use next.

    Usage counters are persisted to disk via QuotaStore so they survive
    process restarts.
    """

    name: str
    _requests_used: int
    _quota_limit: int | None
    _healthy: bool
    _enabled: bool
    _last_error: str | None
    _last_used_at: datetime | None
    _unhealthy_until: datetime | None

    def __init__(self, name: str, quota_limit: int | None = None) -> None:
        self.name = name
        self._quota_limit = quota_limit
        self._healthy = True
        self._enabled = True
        self._last_error = None
        self._last_used_at = None
        self._unhealthy_until = None
        # Restore persisted usage count
        self._requests_used = get_store().get_search_usage(name)
        if self._requests_used > 0:
            log.info("Restored %s usage: %d requests", name, self._requests_used)

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
        self._requests_used += 1
        self._last_used_at = datetime.now()
        self._healthy = True
        self._last_error = None
        # Persist updated count
        get_store().set_search_usage(self.name, self._requests_used)
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
        if self._quota_limit is None:
            return True
        return self._requests_used < self._quota_limit

    def remaining_quota(self) -> int | None:
        """Return remaining quota, or None if unlimited."""
        if self._quota_limit is None:
            return None
        return max(0, self._quota_limit - self._requests_used)

    def reset_usage(self) -> None:
        """Reset monthly usage counter."""
        self._requests_used = 0
        get_store().set_search_usage(self.name, 0)

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
        return {
            "name": self.name,
            "healthy": self.is_healthy(),
            "enabled": self._enabled,
            "requests_used": self._requests_used,
            "quota_limit": self._quota_limit,
            "quota_remaining": self.remaining_quota(),
            "last_error": self._last_error,
            "last_used_at": (
                self._last_used_at.isoformat() if self._last_used_at else None
            ),
        }
