"""Persistent quota/usage store — survives process restarts.

Stores per-engine LLM request counts in a JSON file on disk.
Atomic writes via rename to avoid corruption.

Search provider quota is now tracked live from provider APIs
(Brave headers, Tavily /usage endpoint) — no longer persisted here.
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
    """JSON-file-backed LLM usage counter store."""

    def __init__(self, path: Path | str | None = None) -> None:
        self._path = Path(path) if path else _DEFAULT_PATH
        self._data: dict[str, Any] = self._load()

    # ── Public API ──────────────────────────────────────────────────

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

    def get_provider_usage(self, provider_name: str) -> int:
        providers = self._data.get("search_providers", {})
        return providers.get(provider_name, {}).get("total_requests", 0)

    def set_provider_usage(self, provider_name: str, total_requests: int) -> None:
        providers = self._data.setdefault("search_providers", {})
        entry = providers.setdefault(provider_name, {})
        entry["total_requests"] = total_requests
        entry["updated_at"] = datetime.now().isoformat()
        self._save()

    # ── Internal ─────────────────────────────────────────────────────

    def _load(self) -> dict[str, Any]:
        """Load state from disk, returning empty dict if missing/corrupt."""
        if not self._path.exists():
            return {}
        try:
            with open(self._path) as f:
                data = json.load(f)
            log.info("Loaded quota state from %s", self._path)
            return data
        except (json.JSONDecodeError, OSError) as exc:
            log.warning("Could not load quota state (%s), starting fresh", exc)
            return {}

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
