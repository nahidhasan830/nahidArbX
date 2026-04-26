"""FastAPI app exposing /embed, /score, /reload, /healthz.

Replaces services/entity-classifier. Endpoints:

  POST /embed         { text }                  -> { embedding: [1024] }
  POST /embed-batch   { texts: [...] }          -> { embeddings: [[...]] }
  POST /score         { name_a, name_b, stage } -> { score, pvalue, stage_used, model_version }
  POST /reload                                  -> reload calibrator + model weights
  GET  /healthz                                 -> liveness + model load status

Stages:
  - "bi-encoder"     fast cosine-similarity (no calibration; pvalue=null)
  - "cross-encoder"  reranker with conformal calibration (pvalue from MAPIE)

Caller (lib/matching/entities/auto-resolve.ts) decides which stage to call
based on cost + uncertainty band.
"""

from __future__ import annotations

import logging
import os
from typing import Literal, Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

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

app = FastAPI(title="entity-matcher", version="0.1.0")


# ─────────────────────────── /healthz ──────────────────────────────────


@app.get("/healthz")
def healthz() -> dict:
    """Liveness check. Doesn't load models — Cloud Run startup probe needs
    to return fast, and model load is ~15 s."""
    return {
        "status": "ok",
        "embedding_dim": EMBEDDING_DIM,
        "calibrator_version": get_calibrator().model_version,
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
    """Optional context to disambiguate same-named entities in different
    competitions. Currently informational only; future: cross-encoder
    prompt could include this."""

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
    """Score two surface forms.

    bi-encoder:    cosine similarity of L2-normalized embeddings, [0, 1].
    cross-encoder: sigmoid of reranker logit, [0, 1], with conformal
                   p-value over the negative-class calibration distribution.
    """
    if req.stage == "bi-encoder":
        vecs = embed_many([req.name_a, req.name_b])
        cos = float(np.dot(vecs[0], vecs[1]))
        return ScoreResponse(
            score=cos,
            pvalue=None,
            stage_used="bi-encoder",
            model_version=get_calibrator().model_version,
        )

    # cross-encoder + conformal
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
    """Hot-reload the conformal calibrator after the trainer Job
    publishes new weights. Models themselves stay loaded — only the
    calibrator artefact is re-read from disk."""
    cal = reload_calibrator()
    return ReloadResponse(reloaded=True, calibrator_version=cal.model_version)


# ─────────────────────────── warm-up ───────────────────────────────────


@app.on_event("startup")
def warmup() -> None:
    """Pre-load both models on startup so the first /score request
    doesn't pay the ~15 s model-load cost. Cloud Run min-instances=1
    keeps this hot."""
    log.info("Warming up models…")
    get_bi_encoder()
    get_cross_encoder()
    get_calibrator()
    log.info("Warm-up complete")


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8080"))
    uvicorn.run(app, host="0.0.0.0", port=port)
