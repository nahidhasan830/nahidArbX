"""Persistent quota/usage store — survives process restarts.

Stores per-provider search usage and per-engine LLM request counts
in a JSON file on disk.  Atomic writes via rename to avoid corruption.

Monthly counters auto-reset on the 1st of each month (except Serper
which has one-time credits).
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Any

log = logging.getLogger("ai-search.quota-store")

# Default location: services/ai-search/.quota_state.json
_DEFAULT_PATH = Path(__file__).resolve().parent.parent / ".quota_state.json"


class QuotaStore:
    """JSON-file-backed usage counter store."""

    def __init__(self, path: Path | str | None = None) -> None:
        self._path = Path(path) if path else _DEFAULT_PATH
        self._data: dict[str, Any] = self._load()

    # ── Public API ──────────────────────────────────────────────────

    def get_search_usage(self, provider_name: str) -> int:
        """Return the stored request count for a search provider."""
        search = self._data.get("search_providers", {})
        return search.get(provider_name, {}).get("requests_used", 0)

    def set_search_usage(self, provider_name: str, requests_used: int) -> None:
        """Update the stored request count for a search provider."""
        search = self._data.setdefault("search_providers", {})
        entry = search.setdefault(provider_name, {})
        entry["requests_used"] = requests_used
        entry["updated_at"] = datetime.now().isoformat()
        self._save()

    def get_llm_usage(self, engine_name: str) -> int:
        """Return the stored request count for an LLM engine."""
        llm = self._data.get("llm_engines", {})
        return llm.get(engine_name, {}).get("total_requests", 0)

    def set_llm_usage(self, engine_name: str, total_requests: int) -> None:
        """Update the stored request count for an LLM engine."""
        llm = self._data.setdefault("llm_engines", {})
        entry = llm.setdefault(engine_name, {})
        entry["total_requests"] = total_requests
        entry["updated_at"] = datetime.now().isoformat()
        self._save()

    def get_month_key(self) -> str:
        """Return current YYYY-MM string for monthly reset tracking."""
        return datetime.now().strftime("%Y-%m")

    def check_monthly_reset(self, exclude: set[str] | None = None) -> bool:
        """Check if we've rolled into a new month; reset counters if so.

        Returns True if a reset was performed.
        Providers in `exclude` (e.g. {"serper"}) keep their counts.
        """
        current_month = self.get_month_key()
        stored_month = self._data.get("current_month", "")
        if stored_month == current_month:
            return False

        log.info("Month rolled from %s → %s — resetting quotas", stored_month, current_month)
        self._data["current_month"] = current_month
        exclude = exclude or set()

        # Reset search providers
        for name, entry in self._data.get("search_providers", {}).items():
            if name not in exclude:
                entry["requests_used"] = 0
                entry["updated_at"] = datetime.now().isoformat()

        # Reset LLM engines
        for name, entry in self._data.get("llm_engines", {}).items():
            entry["total_requests"] = 0
            entry["updated_at"] = datetime.now().isoformat()

        self._save()
        return True

    # ── Internal ─────────────────────────────────────────────────────

    def _load(self) -> dict[str, Any]:
        """Load state from disk, returning empty dict if missing/corrupt."""
        if not self._path.exists():
            return {"current_month": self.get_month_key()}
        try:
            with open(self._path) as f:
                data = json.load(f)
            log.info("Loaded quota state from %s", self._path)
            return data
        except (json.JSONDecodeError, OSError) as exc:
            log.warning("Could not load quota state (%s), starting fresh", exc)
            return {"current_month": self.get_month_key()}

    def _save(self) -> None:
        """Atomically write state to disk."""
        tmp = self._path.with_suffix(".tmp")
        try:
            with open(tmp, "w") as f:
                json.dump(self._data, f, indent=2)
            os.replace(tmp, self._path)
        except OSError as exc:
            log.warning("Could not save quota state: %s", exc)


# Module-level singleton
_store: QuotaStore | None = None


def get_store() -> QuotaStore:
    """Get or create the global QuotaStore singleton."""
    global _store
    if _store is None:
        _store = QuotaStore()
    return _store
