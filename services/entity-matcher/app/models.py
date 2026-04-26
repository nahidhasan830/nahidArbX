"""Bi-encoder + cross-encoder model loading.

BGE-M3 (1024-dim multilingual sentence embedding) handles fast retrieval —
the "Looks alike" stage. bge-reranker-v2-m3 is a cross-encoder reranker
that takes (name_a, name_b) directly and returns a relevance score —
the "Smart check" stage used for hard pairs the bi-encoder is uncertain
about.

Both lazy-load on first use so import-time stays cheap during container
warm-up. Once loaded, weights stay resident — Cloud Run keeps the process
alive between requests when min-instances >= 1.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Optional

import numpy as np
from sentence_transformers import CrossEncoder, SentenceTransformer

log = logging.getLogger("entity-matcher.models")

EMBEDDING_DIM = 1024
BI_ENCODER_NAME = "BAAI/bge-m3"
CROSS_ENCODER_NAME = "BAAI/bge-reranker-v2-m3"

# Threading: protect lazy initialization from racing requests at cold start.
_bi_lock = threading.Lock()
_cross_lock = threading.Lock()
_bi: Optional[SentenceTransformer] = None
_cross: Optional[CrossEncoder] = None


def get_bi_encoder() -> SentenceTransformer:
    global _bi
    if _bi is not None:
        return _bi
    with _bi_lock:
        if _bi is None:
            log.info("Loading bi-encoder %s", BI_ENCODER_NAME)
            _bi = SentenceTransformer(BI_ENCODER_NAME, device="cpu")
            log.info("Bi-encoder loaded (dim=%d)", _bi.get_sentence_embedding_dimension())
    return _bi


def get_cross_encoder() -> CrossEncoder:
    global _cross
    if _cross is not None:
        return _cross
    with _cross_lock:
        if _cross is None:
            log.info("Loading cross-encoder %s", CROSS_ENCODER_NAME)
            _cross = CrossEncoder(CROSS_ENCODER_NAME, device="cpu", max_length=128)
            log.info("Cross-encoder loaded")
    return _cross


def embed_one(text: str) -> np.ndarray:
    """Encode a single string. Returns L2-normalized vector for cosine sims."""
    enc = get_bi_encoder()
    vec = enc.encode([text], normalize_embeddings=True, convert_to_numpy=True)[0]
    return vec.astype(np.float32)


def embed_many(texts: list[str]) -> np.ndarray:
    """Batch-encode. Returns (N, EMBEDDING_DIM) L2-normalized matrix."""
    if not texts:
        return np.zeros((0, EMBEDDING_DIM), dtype=np.float32)
    enc = get_bi_encoder()
    arr = enc.encode(
        texts,
        batch_size=32,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )
    return arr.astype(np.float32)


def cross_score(pairs: list[tuple[str, str]]) -> np.ndarray:
    """Score (name_a, name_b) pairs. Higher = more similar.

    Raw bge-reranker output is unbounded logit-style; we apply a sigmoid
    so downstream calibration sees [0, 1]. The conformal calibrator
    converts that into a properly normalized probability + p-value.
    """
    if not pairs:
        return np.zeros(0, dtype=np.float32)
    enc = get_cross_encoder()
    raw = enc.predict(pairs, batch_size=8, show_progress_bar=False)
    arr = np.asarray(raw, dtype=np.float32)
    return 1.0 / (1.0 + np.exp(-arr))
