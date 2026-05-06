"""FallbackEngine — tries a chain of LLM engines in priority order.

Skips engines whose ``is_exhausted`` flag is True (e.g. HF after 402).
On any other failure, logs a warning and tries the next engine.
"""

from __future__ import annotations

import logging
from typing import Any

from app.llm.groq_engine import LLMResponse

log = logging.getLogger("ai-search.fallback")


class FallbackEngine:
    """Chain of (name, engine) tuples — tries in order, returns first success.

    Usage::

        engine = FallbackEngine([
            ("huggingface", hf_engine),
            ("groq", groq_engine),
        ])
        resp = await engine.generate("What is 2+2?")
    """

    def __init__(self, engines: list[tuple[str, Any]]) -> None:
        if not engines:
            raise ValueError("FallbackEngine requires at least one engine")
        self._engines: list[tuple[str, Any]] = engines

    # ── model property ───────────────────────────────────────────────

    @property
    def model(self) -> str:
        """Delegate to the currently active (first non-exhausted) engine."""
        for _name, engine in self._engines:
            if not getattr(engine, "is_exhausted", False):
                return engine.model
        # All exhausted — return first engine's model
        return self._engines[0][1].model

    @model.setter
    def model(self, value: str) -> None:
        """Set model on the currently active engine (needed by GroundedAI.query model_override)."""
        for _name, engine in self._engines:
            if not getattr(engine, "is_exhausted", False):
                engine.model = value
                return
        # All exhausted — set on first
        self._engines[0][1].model = value

    def get_engine_by_name(self, name: str) -> Any | None:
        """Return a specific engine by its registered name, or None."""
        for n, engine in self._engines:
            if n == name:
                return engine
        return None

    # ── generate ─────────────────────────────────────────────────────

    async def generate(self, prompt: str, **kwargs: Any) -> LLMResponse:
        """Try engines in order, skip exhausted, return first success."""
        last_error: Exception | None = None

        for name, engine in self._engines:
            if getattr(engine, "is_exhausted", False):
                log.debug("Skipping exhausted engine: %s", name)
                continue

            try:
                return await engine.generate(prompt, **kwargs)
            except Exception as exc:
                last_error = exc
                log.warning(
                    "Engine '%s' failed: %s — trying next", name, exc
                )

        raise RuntimeError(
            f"All LLM engines failed. Last error: {last_error}"
        )

    # ── generate_with_tools ──────────────────────────────────────────

    async def generate_with_tools(self, prompt: str, **kwargs: Any) -> LLMResponse:
        """Try engines in order for tool-calling, skip exhausted."""
        last_error: Exception | None = None

        for name, engine in self._engines:
            if getattr(engine, "is_exhausted", False):
                log.debug("Skipping exhausted engine: %s", name)
                continue

            try:
                return await engine.generate_with_tools(prompt, **kwargs)
            except Exception as exc:
                last_error = exc
                log.warning(
                    "Engine '%s' tool call failed: %s — trying next",
                    name,
                    exc,
                )

        raise RuntimeError(
            f"All LLM engines failed for tool call. Last error: {last_error}"
        )

    # ── health / stats ───────────────────────────────────────────────

    async def is_healthy(self) -> bool:
        """True if ANY engine is healthy."""
        for _name, engine in self._engines:
            try:
                if await engine.is_healthy():
                    return True
            except Exception:
                pass
        return False

    def get_usage_stats(self) -> dict[str, Any]:
        """Return per-provider stats with active provider highlighted."""
        active_name = None
        provider_stats: dict[str, Any] = {}

        for name, engine in self._engines:
            stats = engine.get_usage_stats() if hasattr(engine, "get_usage_stats") else {"model": engine.model}
            provider_stats[name] = stats
            if active_name is None and not getattr(engine, "is_exhausted", False):
                active_name = name

        return {
            "active": active_name or self._engines[0][0],
            "providers": provider_stats,
        }
