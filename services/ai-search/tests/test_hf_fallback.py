"""Unit tests for HFEngine + FallbackEngine.

Run:  cd services/ai-search && python -m pytest tests/test_hf_fallback.py -v
"""

from __future__ import annotations

import asyncio
import sys
import os
from dataclasses import dataclass
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

# Ensure the app package is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.llm.groq_engine import LLMResponse
from app.llm.hf_engine import HFEngine, CreditsExhaustedError, HF_BASE_URL
from app.llm.fallback import FallbackEngine


# ── Helpers ──────────────────────────────────────────────────────────


class FakeEngine:
    """Minimal engine stub for FallbackEngine tests."""

    def __init__(self, name: str, *, fail: bool = False, exhausted: bool = False):
        self.model = f"fake-{name}"
        self._fail = fail
        self._exhausted = exhausted
        self._calls = 0

    @property
    def is_exhausted(self) -> bool:
        return self._exhausted

    async def generate(self, prompt: str, **kw: Any) -> LLMResponse:
        self._calls += 1
        if self._fail:
            raise RuntimeError(f"{self.model} failed")
        return LLMResponse(text=f"answer from {self.model}", model=self.model)

    async def generate_with_tools(self, prompt: str, **kw: Any) -> LLMResponse:
        return await self.generate(prompt, **kw)

    async def is_healthy(self) -> bool:
        return not self._fail and not self._exhausted

    def get_usage_stats(self) -> dict[str, Any]:
        return {"model": self.model, "calls": self._calls}


# ── HFEngine unit tests ─────────────────────────────────────────────


def test_hf_engine_init():
    """HFEngine initializes with correct base_url and model."""
    engine = HFEngine(api_key="hf_test", model="meta-llama/Llama-3.3-70B-Instruct", routing="fastest")
    assert engine.model == "meta-llama/Llama-3.3-70B-Instruct"
    assert engine._routing == "fastest"
    assert engine._routed_model == "meta-llama/Llama-3.3-70B-Instruct:fastest"
    assert not engine.is_exhausted
    assert engine._client.base_url.host == "router.huggingface.co"


def test_hf_engine_routed_model():
    """Routed model appends routing suffix."""
    engine = HFEngine(api_key="hf_test", model="deepseek-ai/DeepSeek-R1", routing="cheapest")
    assert engine._routed_model == "deepseek-ai/DeepSeek-R1:cheapest"


def test_hf_engine_usage_stats():
    """get_usage_stats returns correct structure."""
    engine = HFEngine(api_key="hf_test")
    stats = engine.get_usage_stats()
    assert stats["provider"] == "huggingface"
    assert stats["credits_exhausted"] is False
    assert stats["total_requests"] == 0


def test_hf_engine_exhaustion_flag():
    """is_exhausted is False by default, True after setting."""
    engine = HFEngine(api_key="hf_test")
    assert not engine.is_exhausted
    engine._credits_exhausted = True
    assert engine.is_exhausted


# ── FallbackEngine unit tests ────────────────────────────────────────


def test_fallback_init_empty_raises():
    """FallbackEngine requires at least one engine."""
    try:
        FallbackEngine([])
        assert False, "Should have raised ValueError"
    except ValueError:
        pass


def test_fallback_model_property():
    """model delegates to first non-exhausted engine."""
    e1 = FakeEngine("primary")
    e2 = FakeEngine("fallback")
    fb = FallbackEngine([("primary", e1), ("fallback", e2)])
    assert fb.model == "fake-primary"

    # Exhaust primary
    e1._exhausted = True
    assert fb.model == "fake-fallback"


def test_fallback_model_setter():
    """model setter targets the active engine."""
    e1 = FakeEngine("primary")
    e2 = FakeEngine("fallback")
    fb = FallbackEngine([("primary", e1), ("fallback", e2)])
    fb.model = "override-model"
    assert e1.model == "override-model"
    assert e2.model == "fake-fallback"  # unchanged


def test_fallback_generate_primary():
    """generate uses primary engine first."""
    e1 = FakeEngine("primary")
    e2 = FakeEngine("fallback")
    fb = FallbackEngine([("primary", e1), ("fallback", e2)])
    resp = asyncio.run(fb.generate("test"))
    assert resp.text == "answer from fake-primary"
    assert e1._calls == 1
    assert e2._calls == 0


def test_fallback_generate_skips_exhausted():
    """generate skips exhausted engines."""
    e1 = FakeEngine("primary", exhausted=True)
    e2 = FakeEngine("fallback")
    fb = FallbackEngine([("primary", e1), ("fallback", e2)])
    resp = asyncio.run(fb.generate("test"))
    assert resp.text == "answer from fake-fallback"
    assert e1._calls == 0
    assert e2._calls == 1


def test_fallback_generate_failover():
    """generate falls back on primary failure."""
    e1 = FakeEngine("primary", fail=True)
    e2 = FakeEngine("fallback")
    fb = FallbackEngine([("primary", e1), ("fallback", e2)])
    resp = asyncio.run(fb.generate("test"))
    assert resp.text == "answer from fake-fallback"


def test_fallback_all_fail():
    """generate raises RuntimeError when all engines fail."""
    e1 = FakeEngine("a", fail=True)
    e2 = FakeEngine("b", fail=True)
    fb = FallbackEngine([("a", e1), ("b", e2)])
    try:
        asyncio.run(fb.generate("test"))
        assert False, "Should have raised RuntimeError"
    except RuntimeError as e:
        assert "All LLM engines failed" in str(e)


def test_fallback_is_healthy():
    """is_healthy returns True if any engine is healthy."""
    e1 = FakeEngine("a", fail=True)
    e2 = FakeEngine("b")
    fb = FallbackEngine([("a", e1), ("b", e2)])
    assert asyncio.run(fb.is_healthy()) is True


def test_fallback_is_healthy_none():
    """is_healthy returns False when all engines unhealthy."""
    e1 = FakeEngine("a", fail=True)
    e2 = FakeEngine("b", exhausted=True)
    fb = FallbackEngine([("a", e1), ("b", e2)])
    assert asyncio.run(fb.is_healthy()) is False


def test_fallback_usage_stats():
    """get_usage_stats includes active engine and per-provider breakdown."""
    e1 = FakeEngine("primary")
    e2 = FakeEngine("fallback")
    fb = FallbackEngine([("primary", e1), ("fallback", e2)])
    stats = fb.get_usage_stats()
    assert stats["active"] == "primary"
    assert "primary" in stats["providers"]
    assert "fallback" in stats["providers"]


def test_fallback_usage_stats_exhausted_primary():
    """active switches when primary is exhausted."""
    e1 = FakeEngine("primary", exhausted=True)
    e2 = FakeEngine("fallback")
    fb = FallbackEngine([("primary", e1), ("fallback", e2)])
    stats = fb.get_usage_stats()
    assert stats["active"] == "fallback"


# ── Config tests ─────────────────────────────────────────────────────


def test_config_hf_fields():
    """Config dataclass has HF fields with correct defaults."""
    from app.config import Config
    cfg = Config()
    assert cfg.hf_api_key == ""
    assert cfg.hf_model == "meta-llama/Llama-3.3-70B-Instruct"
    assert cfg.hf_routing == "fastest"


def test_config_load_hf_from_env():
    """load_config reads HF env vars."""
    from app.config import load_config
    with patch.dict(os.environ, {
        "HF_API_KEY": "hf_test123",
        "HF_MODEL": "custom/model",
        "HF_ROUTING": "cheapest",
    }):
        cfg = load_config()
        assert cfg.hf_api_key == "hf_test123"
        assert cfg.hf_model == "custom/model"
        assert cfg.hf_routing == "cheapest"


# ── Run ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])
