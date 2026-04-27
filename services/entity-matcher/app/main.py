"""FastAPI app: /embed, /score, /reload, /healthz + scheduler endpoints.

Inference endpoints (embed, score, reload, healthz) serve the auto-resolver
and playground. Scheduler endpoints let the Next.js UI control the
background ML processing loop that runs inside this same process.

Scheduler endpoints:
  GET  /scheduler/status          → scheduler + config state
  POST /scheduler/run-now         → trigger one batch immediately
  GET  /scheduler/runs            → recent run history from Postgres
  GET  /config                    → current matcher_config row
  POST /config   { ... }         → update config (UI writes here)
"""

from __future__ import annotations

import logging
import os
from typing import Literal, Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text as sa_text

from .conformal import get_calibrator, reload_calibrator
from .models import (
    EMBEDDING_DIM,
    cross_score,
    embed_many,
    embed_one,
    get_bi_encoder,
    get_cross_encoder,
)

log = logging.getLogger("entity-matcher")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="entity-matcher", version="0.2.0")


# ─────────────────────────── /healthz ──────────────────────────────────


@app.get("/healthz")
def healthz() -> dict:
    from .scheduler import get_scheduler_status

    return {
        "status": "ok",
        "embedding_dim": EMBEDDING_DIM,
        "calibrator_version": get_calibrator().model_version,
        "scheduler": get_scheduler_status(),
    }


# ─────────────────────────── /embed ────────────────────────────────────


class EmbedRequest(BaseModel):
    text: str


class EmbedResponse(BaseModel):
    embedding: list[float]


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest) -> EmbedResponse:
    if not req.text or not req.text.strip():
        raise HTTPException(400, "text is required")
    vec = embed_one(req.text)
    return EmbedResponse(embedding=vec.tolist())


class EmbedBatchRequest(BaseModel):
    texts: list[str]


class EmbedBatchResponse(BaseModel):
    embeddings: list[list[float]]


@app.post("/embed-batch", response_model=EmbedBatchResponse)
def embed_batch(req: EmbedBatchRequest) -> EmbedBatchResponse:
    if not req.texts:
        return EmbedBatchResponse(embeddings=[])
    arr = embed_many(req.texts)
    return EmbedBatchResponse(embeddings=arr.tolist())


# ─────────────────────────── /score ────────────────────────────────────


Stage = Literal["bi-encoder", "cross-encoder"]


class ScoreContext(BaseModel):
    provider: Optional[str] = None
    competition_canonical: Optional[str] = None


class ScoreRequest(BaseModel):
    name_a: str = Field(..., min_length=1)
    name_b: str = Field(..., min_length=1)
    stage: Stage = "cross-encoder"
    context: Optional[ScoreContext] = None


class ScoreResponse(BaseModel):
    score: float
    pvalue: Optional[float] = None
    stage_used: Stage
    model_version: str


@app.post("/score", response_model=ScoreResponse)
def score(req: ScoreRequest) -> ScoreResponse:
    if req.stage == "bi-encoder":
        vecs = embed_many([req.name_a, req.name_b])
        cos = float(np.dot(vecs[0], vecs[1]))
        return ScoreResponse(
            score=cos,
            pvalue=None,
            stage_used="bi-encoder",
            model_version=get_calibrator().model_version,
        )

    raw = float(cross_score([(req.name_a, req.name_b)])[0])
    cal = get_calibrator().predict(raw)
    return ScoreResponse(
        score=cal.score,
        pvalue=cal.pvalue,
        stage_used="cross-encoder",
        model_version=cal.model_version,
    )


# ─────────────────────────── /reload ───────────────────────────────────


class ReloadResponse(BaseModel):
    reloaded: bool
    calibrator_version: str


@app.post("/reload", response_model=ReloadResponse)
def reload() -> ReloadResponse:
    cal = reload_calibrator()
    return ReloadResponse(reloaded=True, calibrator_version=cal.model_version)


# ─────────────────────── scheduler endpoints ───────────────────────────


@app.get("/scheduler/status")
def scheduler_status() -> dict:
    from .scheduler import get_scheduler_status
    return get_scheduler_status()


class RunNowRequest(BaseModel):
    pairIds: Optional[list[str]] = None

@app.post("/scheduler/run-now")
async def scheduler_run_now(req: Optional[RunNowRequest] = None) -> dict:
    import asyncio
    from .scheduler import process_batch
    pair_ids = req.pairIds if req else None
    result = await asyncio.to_thread(process_batch, "manual", pair_ids)
    return result


@app.post("/scheduler/cron")
async def scheduler_cron() -> dict:
    import asyncio
    from .scheduler import process_batch
    # Called by Next.js every 60s. Passes "scheduler" trigger so
    # process_batch will check if the matcher is actually enabled.
    result = await asyncio.to_thread(process_batch, "scheduler")
    return result


@app.get("/scheduler/runs")
def scheduler_runs(limit: int = 20) -> dict:
    from .db import get_engine

    limit = min(limit, 100)
    engine = get_engine()
    with engine.connect() as conn:
        rows = conn.execute(sa_text("""
            SELECT id, started_at, completed_at, duration_ms,
                   processed, merged, rejected, escalated,
                   status, trigger, error_message
            FROM matcher_runs
            ORDER BY started_at DESC
            LIMIT :lim
        """), {"lim": limit}).mappings().all()

    return {
        "runs": [dict(r) for r in rows],
        "total": len(rows),
    }


# ─────────────────────── config endpoints ──────────────────────────────


class ConfigUpdateRequest(BaseModel):
    enabled: Optional[bool] = None
    interval_ms: Optional[int] = None
    team_merge_threshold: Optional[float] = None
    comp_merge_threshold: Optional[float] = None
    team_reject_threshold: Optional[float] = None
    combined_merge_threshold: Optional[float] = None
    combined_reject_threshold: Optional[float] = None
    xe_escalation_enabled: Optional[bool] = None
    xe_escalation_low: Optional[float] = None
    xe_escalation_high: Optional[float] = None
    xe_merge_threshold: Optional[float] = None
    xe_pvalue_threshold: Optional[float] = None


@app.get("/config")
def get_config() -> dict:
    from .scheduler import read_config
    cfg = read_config()
    return {
        "enabled": cfg.enabled,
        "interval_ms": cfg.interval_ms,
        "team_merge_threshold": cfg.team_merge_threshold,
        "comp_merge_threshold": cfg.comp_merge_threshold,
        "team_reject_threshold": cfg.team_reject_threshold,
        "combined_merge_threshold": cfg.combined_merge_threshold,
        "combined_reject_threshold": cfg.combined_reject_threshold,
        "xe_escalation_enabled": cfg.xe_escalation_enabled,
        "xe_escalation_low": cfg.xe_escalation_low,
        "xe_escalation_high": cfg.xe_escalation_high,
        "xe_merge_threshold": cfg.xe_merge_threshold,
        "xe_pvalue_threshold": cfg.xe_pvalue_threshold,
    }


@app.post("/config")
def update_config(req: ConfigUpdateRequest) -> dict:
    from .db import get_engine

    updates: list[str] = []
    params: dict = {}

    for field_name in req.model_fields_set:
        val = getattr(req, field_name)
        if val is not None:
            updates.append(f"{field_name} = :{field_name}")
            params[field_name] = val

    if not updates:
        return {"updated": False}

    updates.append("updated_at = now()")
    set_clause = ", ".join(updates)

    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(
            sa_text(f"UPDATE matcher_config SET {set_clause} WHERE id = 'default'"),
            params,
        )

    log.info("Config updated: %s", params)
    return {"updated": True, "fields": list(params.keys())}


# ─────────────────────────── warm-up ───────────────────────────────────


@app.on_event("startup")
async def warmup() -> None:
    log.info("Warming up models…")
    get_bi_encoder()
    get_cross_encoder()
    get_calibrator()
    log.info("Warm-up complete")

if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8080"))
    uvicorn.run(app, host="0.0.0.0", port=port)
