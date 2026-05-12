"""FastAPI gateway for the AI search-grounded inference module.

Endpoints:
  GET  /healthz            — LLM status + provider quotas
  POST /search             — raw multi-provider search
  POST /grounded-query     — search + LLM for ad-hoc questions
  POST /entity-match       — sports event pair matching
  POST /verify-settlement  — match result verification
  GET  /stats              — per-provider usage and health
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel as PydanticModel

from app.config import load_config
from app.grounding import GroundedAI
from app.llm.groq_engine import GroqEngine
from app.models import (
    BatchEntityMatchRequest,
    BatchMatchVerdict,
    EntityMatchRequest,
    GroundedAnswer,
    GroundedQueryRequest,
    MatchVerdict,
    SearchRequest,
    SearchResponse,
    SettlementRequest,
    SettlementVerdict,
)
from app.search.router import SearchRouter

log = logging.getLogger("ai-search")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)

# ── Bootstrap ────────────────────────────────────────────────────────

config = load_config()
search_router = SearchRouter(config)

# Build LLM engine chain: HF Router (primary) → Groq (fallback)
from app.llm.hf_engine import HFEngine
from app.llm.fallback import FallbackEngine

engines: list[tuple[str, Any]] = []
if config.hf_api_key:
    engines.append(("huggingface", HFEngine(
        api_key=config.hf_api_key,
        model=config.hf_model,
        routing=config.hf_routing,
    )))
    log.info("LLM: HuggingFace Router %s:%s (primary)", config.hf_model, config.hf_routing)

if config.groq_api_key:
    engines.append(("groq", GroqEngine(
        api_key=config.groq_api_key,
        model=config.groq_model,
    )))
    log.info("LLM: Groq %s (fallback)" if config.hf_api_key else "LLM: Groq %s (sole engine — set HF_API_KEY to use HuggingFace as primary)", config.groq_model)

if not engines:
    raise RuntimeError("At least one LLM provider required (HF_API_KEY recommended as primary, GROQ_API_KEY as fallback)")

llm_engine = FallbackEngine(engines) if len(engines) > 1 else engines[0][1]

grounded_ai = GroundedAI(search_router, llm_engine, config)


# ── Lifespan ──────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Startup: sync live quotas from providers that support it."""
    log.info("Syncing provider quotas on startup...")
    await search_router.sync_quotas()
    log.info("Quota sync complete")
    yield


app = FastAPI(
    title="ai-search",
    version="0.4.0",
    description="Search-grounded AI inference for entity resolution and settlement.",
    lifespan=lifespan,
)


# ── /healthz ─────────────────────────────────────────────────────────


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    llm_healthy = await llm_engine.is_healthy()
    llm_stats = llm_engine.get_usage_stats() if hasattr(llm_engine, 'get_usage_stats') else {}
    stats = search_router.get_stats()
    providers_healthy = sum(1 for p in stats["providers"] if p["healthy"])

    return {
        "status": "ok" if llm_healthy and providers_healthy > 0 else "degraded",
        "llm_engine": {
            **llm_stats,
            "model": llm_engine.model,
            "healthy": llm_healthy,
        },
        "search_providers": {
            "total": len(stats["providers"]),
            "healthy": providers_healthy,
        },
    }


# ── /search ──────────────────────────────────────────────────────────


@app.post("/search", response_model=SearchResponse)
async def search(req: SearchRequest) -> SearchResponse:
    """Raw multi-provider web search."""
    results, provider = await search_router.search(
        req.query,
        max_results=req.max_results,
        preferred_providers=req.providers,
    )
    return SearchResponse(
        query=req.query,
        results=results,
        provider_used=provider,
    )


# ── /providers/{name}/toggle ──────────────────────────────────────────


class ToggleRequest(PydanticModel):
    enabled: bool


@app.post("/providers/{name}/toggle")
async def toggle_provider(name: str, req: ToggleRequest) -> dict[str, bool | str]:
    """Enable or disable a search provider at runtime."""
    found = search_router.toggle_provider(name, req.enabled)
    if not found:
        raise HTTPException(404, f"Provider '{name}' not found")
    return {"name": name, "enabled": req.enabled}


# ── /models ─────────────────────────────────────────────────────────


@app.get("/models")
async def list_models() -> dict[str, Any]:
    """List the configured LLM engine(s) and model."""
    llm_healthy = await llm_engine.is_healthy()
    return {
        "engine": "fallback" if hasattr(llm_engine, '_engines') else "single",
        "model": llm_engine.model,
        "healthy": llm_healthy,
        "usage": llm_engine.get_usage_stats() if hasattr(llm_engine, 'get_usage_stats') else {},
    }


# ── /llm-stats ───────────────────────────────────────────────────────


@app.get("/llm-stats")
async def llm_stats() -> dict[str, Any]:
    """Return LLM engine usage stats (replaces /groq-limits)."""
    return {
        "model": llm_engine.model,
        "usage": llm_engine.get_usage_stats() if hasattr(llm_engine, 'get_usage_stats') else {},
    }


# ── /grounded-query ──────────────────────────────────────────────────


@app.post("/grounded-query", response_model=GroundedAnswer)
async def grounded_query(req: GroundedQueryRequest) -> GroundedAnswer:
    """Search + LLM for ad-hoc questions."""
    await ensure_model_ready()

    return await grounded_ai.query(req.question, req.context, model_override=req.model)


# ── /entity-match ────────────────────────────────────────────────────


@app.post("/entity-match", response_model=MatchVerdict)
async def entity_match(req: EntityMatchRequest) -> MatchVerdict:
    """Determine if two sports events are the same real-world match."""
    await ensure_model_ready()

    return await grounded_ai.entity_match(
        req.event_a, req.event_b, llm_override=req.llm_provider,
    )


# ── /entity-match-batch ───────────────────────────────────────────


@app.post("/entity-match-batch", response_model=BatchMatchVerdict)
async def entity_match_batch(req: BatchEntityMatchRequest) -> BatchMatchVerdict:
    """Batch-match multiple event pairs in a single grounded AI call.

    Deduplicates search queries across all pairs and sends a single
    prompt to the LLM for all verdicts.  Up to 20 pairs per request.
    """
    await ensure_model_ready()

    pairs = [(p.event_a, p.event_b) for p in req.pairs]
    return await grounded_ai.entity_match_batch(pairs)


# ── /verify-settlement ──────────────────────────────────────────────


@app.post("/verify-settlement", response_model=SettlementVerdict)
async def verify_settlement(req: SettlementRequest) -> SettlementVerdict:
    """Verify a match result or statistic for bet settlement."""
    await ensure_model_ready()

    return await grounded_ai.verify_settlement(req.event, req.question)


# ── /stats ───────────────────────────────────────────────────────────


@app.get("/stats")
async def stats() -> dict[str, Any]:
    """Per-provider usage, health, and quota information."""
    router_stats = search_router.get_stats()
    llm_healthy = await llm_engine.is_healthy()

    return {
        **router_stats,
        "llm_engine": llm_engine.model,
        "llm_healthy": llm_healthy,
    }


# ── Helpers ──────────────────────────────────────────────────────────


async def ensure_model_ready() -> None:
    """Raise a precise 503 if the LLM engine is not available."""
    healthy = await llm_engine.is_healthy()
    if healthy:
        return

    raise HTTPException(
        503,
        {
            "message": f"LLM engine ({llm_engine.model}) is not healthy. Check API key or service status.",
        },
    )


# ── Entrypoint ───────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("AI_SEARCH_PORT", "8090"))
    uvicorn.run(app, host="0.0.0.0", port=port)
