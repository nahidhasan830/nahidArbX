"""Load settled bets with ML features for LightGBM training.

Queries the bets table for all settled rows that have ml_features populated,
derives binary labels and CLV%, and returns a Polars DataFrame ready for
CPCV splitting and LightGBM training.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

import numpy as np
import polars as pl
from sqlalchemy import text
from sqlalchemy.orm import Session

from .feature_names import FEATURE_COUNT, FEATURE_NAMES

log = logging.getLogger(__name__)

# Outcomes that indicate the bet was settled (not still pending).
SETTLED_OUTCOMES = ("won", "half_won", "lost", "half_lost", "void")

# Outcomes counted as positive label for the binary classifier.
POSITIVE_OUTCOMES = ("won", "half_won")

# Outcomes excluded from training — voids are market cancellations (push/refund)
# that carry no predictive signal. Including them as label=0 adds noise.
EXCLUDED_OUTCOMES = ("void",)


@dataclass(frozen=True)
class TrainingData:
    """Container for training data passed to the trainer."""

    features: np.ndarray       # shape (n, 23), float32
    labels: np.ndarray         # shape (n,), int {0, 1}
    feature_names: list[str]   # parallel to columns
    metadata: pl.DataFrame     # full rows for metric computation
    n_samples: int


def load_training_data(session: Session) -> TrainingData:
    """Load all settled bets with ML features from the database.

    Returns a TrainingData container with numpy arrays for features/labels
    and a Polars DataFrame for metadata needed during metric computation.
    """
    stmt = text("""
        SELECT
            id,
            ml_features,
            outcome,
            pnl,
            soft_odds,
            sharp_true_prob,
            soft_commission_pct,
            closing_sharp_odds,
            first_seen_at,
            event_start_time,
            event_id
        FROM bets
        WHERE outcome <> 'pending'
          AND outcome <> 'void'
          AND ml_features IS NOT NULL
        ORDER BY first_seen_at ASC
    """)

    result = session.execute(stmt)
    rows = result.mappings().all()

    if not rows:
        log.warning("No settled bets with ML features found")
        return TrainingData(
            features=np.empty((0, FEATURE_COUNT), dtype=np.float32),
            labels=np.empty(0, dtype=np.int32),
            feature_names=list(FEATURE_NAMES),
            metadata=_empty_metadata(),
            n_samples=0,
        )

    # Coerce Decimal → float for Polars compatibility
    def _coerce(r: Any) -> dict[str, Any]:
        d = dict(r)
        for k, v in d.items():
            if isinstance(v, Decimal):
                d[k] = float(v)
        return d

    coerced = [_coerce(r) for r in rows]

    # Extract feature vectors → numpy array
    raw_features = []
    valid_indices = []
    for i, row in enumerate(coerced):
        fv = row.get("ml_features")
        if fv is not None and len(fv) == FEATURE_COUNT:
            raw_features.append(fv)
            valid_indices.append(i)
        else:
            log.debug("Skipping row %s: ml_features has wrong length %s",
                      row.get("id"), len(fv) if fv else None)

    if not raw_features:
        log.warning("No valid feature vectors found")
        return TrainingData(
            features=np.empty((0, FEATURE_COUNT), dtype=np.float32),
            labels=np.empty(0, dtype=np.int32),
            feature_names=list(FEATURE_NAMES),
            metadata=_empty_metadata(),
            n_samples=0,
        )

    # Keep only rows with valid features
    valid_rows = [coerced[i] for i in valid_indices]

    features = np.array(raw_features, dtype=np.float32)

    # Binary label: won/half_won → 1, else → 0
    labels = np.array(
        [1 if r["outcome"] in POSITIVE_OUTCOMES else 0 for r in valid_rows],
        dtype=np.int32,
    )

    # Build metadata DataFrame for metric computation
    meta_records = []
    for r in valid_rows:
        # Derive CLV%: (closing_fair_odds / detection_fair_odds - 1) * 100
        # detection_fair_odds = 1 / sharp_true_prob
        # closing_fair_odds = closing_sharp_odds (already vig-removed at detection time)
        clv_pct = None
        closing = r.get("closing_sharp_odds")
        true_prob = r.get("sharp_true_prob")
        if closing and true_prob and closing > 0 and true_prob > 0:
            detection_fair = 1.0 / true_prob
            clv_pct = (detection_fair / closing - 1.0) * 100.0

        meta_records.append({
            "id": r["id"],
            "outcome": r["outcome"],
            "pnl": float(r.get("pnl") or 0),
            "soft_odds": float(r.get("soft_odds") or 0),
            "sharp_true_prob": float(r.get("sharp_true_prob") or 0),
            "soft_commission_pct": float(r.get("soft_commission_pct") or 0),
            "closing_sharp_odds": float(closing) if closing else None,
            "clv_pct": clv_pct,
            "first_seen_at": r.get("first_seen_at"),
            "event_start_time": r.get("event_start_time"),
            "event_id": r.get("event_id"),
        })

    metadata = pl.DataFrame(meta_records, infer_schema_length=None, strict=False)

    # Coerce numeric columns
    for col in ("pnl", "soft_odds", "sharp_true_prob", "soft_commission_pct",
                "closing_sharp_odds", "clv_pct"):
        if col in metadata.columns:
            metadata = metadata.with_columns(
                pl.col(col).cast(pl.Float64, strict=False)
            )

    log.info(
        "Loaded %d training samples (%d positive, %d negative)",
        len(labels), int(labels.sum()), int((labels == 0).sum()),
    )

    return TrainingData(
        features=features,
        labels=labels,
        feature_names=list(FEATURE_NAMES),
        metadata=metadata,
        n_samples=len(labels),
    )


def _empty_metadata() -> pl.DataFrame:
    """Schema-correct empty DataFrame for edge cases."""
    return pl.DataFrame(
        schema={
            "id": pl.Utf8,
            "outcome": pl.Utf8,
            "pnl": pl.Float64,
            "soft_odds": pl.Float64,
            "sharp_true_prob": pl.Float64,
            "soft_commission_pct": pl.Float64,
            "closing_sharp_odds": pl.Float64,
            "clv_pct": pl.Float64,
            "first_seen_at": pl.Utf8,
            "event_start_time": pl.Utf8,
            "event_id": pl.Utf8,
        }
    )
