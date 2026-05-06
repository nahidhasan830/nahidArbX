"""Load training data for LightGBM from settled bets or ML training examples.

Primary source: ml_training_examples table (Phase 4 — decoupled from bets).
Fallback: bets table (legacy path — for repos that haven't populated
training examples yet).

Derives binary labels and CLV%, and returns a Polars DataFrame ready for
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

from .feature_names import FEATURE_COUNT, FEATURE_NAMES, FEATURE_NAMES_HASH, FEATURE_VERSION

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

    features: np.ndarray       # shape (n, 25), float32
    labels: np.ndarray         # shape (n,), int {0, 1}
    feature_names: list[str]   # parallel to columns
    metadata: pl.DataFrame     # full rows for metric computation
    n_samples: int
    sample_weights: np.ndarray | None = None  # shape (n,), float64 — per-sample weights for LightGBM
    scale_pos_weight: float | None = None     # n_neg / n_pos — conservative class imbalance correction
    feature_version: int = FEATURE_VERSION
    feature_names_hash: str = FEATURE_NAMES_HASH


def load_training_data(session: Session) -> TrainingData:
    """Load all settled bets with ML features from the database.

    Returns a TrainingData container with numpy arrays for features/labels
    and a Polars DataFrame for metadata needed during metric computation.
    """
    stmt = text("""
        SELECT
            id,
            ml_features,
            ml_feature_version,
            ml_feature_count,
            ml_feature_names_hash,
            outcome,
            pnl,
            soft_odds,
            sharp_true_prob,
            soft_commission_pct,
            closing_sharp_odds,
            first_seen_at,
            event_start_time,
            event_id,
            placed_at
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
    _validate_feature_contract(coerced)

    raw_features = []
    valid_indices = []
    for i, row in enumerate(coerced):
        fv = row.get("ml_features")
        if fv is not None and len(fv) == FEATURE_COUNT:
            raw_features.append(fv)
            valid_indices.append(i)
        else:
            raise ValueError(
                f"Feature length drift for row {row.get('id')}: "
                f"got {len(fv) if fv else None}, expected {FEATURE_COUNT}. "
                "Run the feature normalization migration before training."
            )

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

    # Derive per-sample weights from outcome type and PnL magnitude
    sample_weights = _derive_sample_weights(valid_rows)

    # Compute conservative scale_pos_weight (n_neg / n_pos)
    n_pos = int(labels.sum())
    n_neg = int((labels == 0).sum())
    spw = _compute_scale_pos_weight(n_pos, n_neg)

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
        "Loaded %d training samples (%d positive, %d negative, scale_pos_weight=%.3f)",
        len(labels), n_pos, n_neg, spw,
    )

    return TrainingData(
        features=features,
        labels=labels,
        feature_names=list(FEATURE_NAMES),
        metadata=metadata,
        n_samples=len(labels),
        sample_weights=sample_weights,
        scale_pos_weight=spw,
        feature_version=FEATURE_VERSION,
        feature_names_hash=FEATURE_NAMES_HASH,
    )


def _validate_feature_contract(rows: list[dict[str, Any]]) -> None:
    """Reject mixed or stale feature contracts before training."""
    versions = {r.get("ml_feature_version") for r in rows}
    counts = {r.get("ml_feature_count") for r in rows}
    hashes = {r.get("ml_feature_names_hash") for r in rows}

    if versions != {FEATURE_VERSION}:
        raise ValueError(
            f"Mixed or unsupported ml_feature_version values: {sorted(map(str, versions))}; "
            f"expected only {FEATURE_VERSION}. Run the feature normalization migration first."
        )
    if counts != {FEATURE_COUNT}:
        raise ValueError(
            f"Mixed or unsupported ml_feature_count values: {sorted(map(str, counts))}; "
            f"expected only {FEATURE_COUNT}. Run the feature normalization migration first."
        )
    if hashes != {FEATURE_NAMES_HASH}:
        raise ValueError(
            "Mixed or unsupported ml_feature_names_hash values; "
            "runtime, training, and stored feature vectors are out of contract."
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


def load_from_training_examples(session: Session) -> TrainingData | None:
    """Load from the ml_training_examples table (Phase 4 preferred path).

    Returns None if the table doesn't exist or has no usable rows,
    so the caller can fall back to load_training_data().
    """
    try:
        count_stmt = text("""
            SELECT count(*) AS n
            FROM ml_training_examples
            WHERE label IS NOT NULL
              AND features IS NOT NULL
              AND feature_version = :version
        """)
        count_result = session.execute(count_stmt, {"version": FEATURE_VERSION}).scalar()
        if not count_result or count_result == 0:
            return None
    except Exception:
        # Table doesn't exist yet — fall back
        return None

    stmt = text("""
        SELECT
            id,
            source_bet_id,
            example_type,
            event_id,
            family_id,
            atom_id,
            features,
            feature_version,
            label,
            label_source,
            sample_weight,
            outcome,
            pnl,
            clv_pct,
            created_at,
            settled_at
        FROM ml_training_examples
        WHERE label IS NOT NULL
          AND features IS NOT NULL
          AND feature_version = :version
        ORDER BY created_at ASC
    """)

    result = session.execute(stmt, {"version": FEATURE_VERSION})
    rows = result.mappings().all()

    if not rows:
        return None

    def _coerce(r: Any) -> dict[str, Any]:
        d = dict(r)
        for k, v in d.items():
            if isinstance(v, Decimal):
                d[k] = float(v)
        return d

    coerced = [_coerce(r) for r in rows]

    raw_features = []
    raw_weights = []
    valid_coerced = []
    for row in coerced:
        fv = row.get("features")
        if fv is not None and len(fv) == FEATURE_COUNT:
            raw_features.append(fv)
            raw_weights.append(float(row.get("sample_weight", 1.0)))
            valid_coerced.append(row)
        else:
            log.warning(
                "Skipping training example %s: feature length %s != %d",
                row.get("id"), len(fv) if fv else None, FEATURE_COUNT,
            )

    if not raw_features:
        return None

    features = np.array(raw_features, dtype=np.float32)
    labels = np.array(
        [1 if r["label"] == "positive" else 0 for r in valid_coerced],
        dtype=np.int32,
    )

    # Apply PnL-magnitude boosting on top of stored sample_weight
    sample_weights = np.array(raw_weights, dtype=np.float64)
    for i, r in enumerate(valid_coerced):
        pnl_abs = abs(float(r.get("pnl") or 0))
        sample_weights[i] *= _pnl_boost(pnl_abs)

    # Compute conservative scale_pos_weight
    n_pos = int(labels.sum())
    n_neg = int((labels == 0).sum())
    spw = _compute_scale_pos_weight(n_pos, n_neg)

    # Build minimal metadata DataFrame
    meta_records = []
    for r in valid_coerced:
        meta_records.append({
            "id": str(r.get("source_bet_id", r["id"])),
            "outcome": r.get("outcome", ""),
            "pnl": float(r.get("pnl") or 0),
            "soft_odds": 0.0,  # Not stored in training examples
            "sharp_true_prob": 0.0,
            "soft_commission_pct": 0.0,
            "closing_sharp_odds": None,
            "clv_pct": float(r.get("clv_pct")) if r.get("clv_pct") else None,
            "first_seen_at": r.get("created_at"),
            "event_start_time": None,
            "event_id": r.get("event_id"),
        })

    metadata = pl.DataFrame(meta_records, infer_schema_length=None, strict=False)
    for col in ("pnl", "soft_odds", "sharp_true_prob", "soft_commission_pct",
                "closing_sharp_odds", "clv_pct"):
        if col in metadata.columns:
            metadata = metadata.with_columns(
                pl.col(col).cast(pl.Float64, strict=False)
            )

    log.info(
        "Loaded %d training examples from ml_training_examples "
        "(%d positive, %d negative, scale_pos_weight=%.3f)",
        len(labels), n_pos, n_neg, spw,
    )

    return TrainingData(
        features=features,
        labels=labels,
        feature_names=list(FEATURE_NAMES),
        metadata=metadata,
        n_samples=len(labels),
        sample_weights=sample_weights,
        scale_pos_weight=spw,
        feature_version=FEATURE_VERSION,
        feature_names_hash=FEATURE_NAMES_HASH,
    )


def load_best_available(session: Session) -> TrainingData:
    """Load training data from the best available source.

    Tries ml_training_examples first (Phase 4), falls back to bets table.
    """
    from_examples = load_from_training_examples(session)
    if from_examples is not None and from_examples.n_samples > 0:
        log.info("Using ml_training_examples table (%d samples)", from_examples.n_samples)
        return from_examples

    log.info("Falling back to bets table for training data")
    return load_training_data(session)



# ── Sample weight helpers ──────────────────────────────────────────────────

# Half outcomes get reduced weight; near_miss handled by stored sample_weight.
HALF_OUTCOME_WEIGHT = 0.5

# PnL magnitude boost: log1p(|pnl| / scale) so that high-impact bets
# get up to ~2x weight without dominating. Capped at 2.0.
_PNL_BOOST_SCALE = 5.0
_PNL_BOOST_CAP = 2.0


def _pnl_boost(pnl_abs: float) -> float:
    """Multiplicative boost from absolute PnL — higher impact → more weight.

    Returns a multiplier in [1.0, _PNL_BOOST_CAP]. Zero PnL → 1.0.
    """
    if pnl_abs <= 0:
        return 1.0
    import math
    boost = 1.0 + math.log1p(pnl_abs / _PNL_BOOST_SCALE) * 0.3
    return min(boost, _PNL_BOOST_CAP)


def _derive_sample_weights(rows: list[dict[str, Any]]) -> np.ndarray:
    """Derive per-sample weights from outcome type and PnL magnitude.

    Weight formula:
      base = 0.5 for half_won/half_lost, 1.0 otherwise
      boost = _pnl_boost(|pnl|)
      final = base * boost
    """
    weights = np.ones(len(rows), dtype=np.float64)
    for i, r in enumerate(rows):
        outcome = r.get("outcome", "")
        # Half outcomes get reduced weight
        if outcome in ("half_won", "half_lost"):
            weights[i] = HALF_OUTCOME_WEIGHT

        # PnL magnitude boost
        pnl_abs = abs(float(r.get("pnl") or 0))
        weights[i] *= _pnl_boost(pnl_abs)

    return weights


def _compute_scale_pos_weight(n_pos: int, n_neg: int) -> float:
    """Compute conservative scale_pos_weight for LightGBM.

    When the class ratio is close to balanced (0.7 ≤ ratio ≤ 1.4),
    returns 1.0 (no correction needed). Otherwise returns a damped
    ratio: sqrt(n_neg / n_pos) to avoid aggressive over-correction
    on small datasets.
    """
    if n_pos == 0 or n_neg == 0:
        return 1.0
    ratio = n_neg / n_pos
    if 0.7 <= ratio <= 1.4:
        return 1.0
    # Damped correction: sqrt to be conservative
    import math
    return round(math.sqrt(ratio), 4)
