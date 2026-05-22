"""Load training data for LightGBM from settled bets or ML training examples.

Primary source: ml_training_examples table (decoupled from bets).
Fallback: bets table (legacy path — for repos that haven't populated
training examples yet).

Derives binary labels and CLV%, and returns a Polars DataFrame ready for
CPCV splitting and LightGBM training.

Sample weights:
  - load_from_training_examples: trust stored sample_weight (no double PnL boost)
  - load_best_available: sort merged data chronologically
  - Coverage uses only labeled, current-version examples
  - Unit return computed from odds+outcome instead of null pnl
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

import numpy as np
import polars as pl
from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError
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

EXAMPLE_TYPE_PRECEDENCE = {
    "shadow_scored": 2,
    "settled_detected": 3,
    "placed_settled": 4,
}

SHARP_TRUE_PROB_FEATURE_INDEX = FEATURE_NAMES.index("sharp_true_prob")
SOFT_ODDS_FEATURE_INDEX = FEATURE_NAMES.index("soft_odds")
ADJUSTED_SOFT_ODDS_FEATURE_INDEX = FEATURE_NAMES.index("adjusted_soft_odds")
COMPETITION_TIER_FEATURE_INDEX = FEATURE_NAMES.index("competition_tier")
SHARP_TRUE_PROB_SQL_INDEX = SHARP_TRUE_PROB_FEATURE_INDEX + 1
ADJUSTED_SOFT_ODDS_SQL_INDEX = ADJUSTED_SOFT_ODDS_FEATURE_INDEX + 1
COMPETITION_TIER_SQL_INDEX = COMPETITION_TIER_FEATURE_INDEX + 1
VALID_COMPETITION_TIERS = {1.0, 2.0, 3.0}


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
          AND ml_feature_version = :version
          AND ml_feature_count = :feature_count
          AND ml_feature_names_hash = :feature_hash
          AND array_length(ml_features, 1) = :feature_count
          AND soft_odds > 1.01
          AND sharp_true_prob > 0
          AND sharp_true_prob < 1
          AND ml_features[:competition_tier_sql_index] = ANY(:valid_competition_tiers)
        ORDER BY first_seen_at ASC
    """)

    result = session.execute(
        stmt,
        {
            "version": FEATURE_VERSION,
            "feature_count": FEATURE_COUNT,
            "feature_hash": FEATURE_NAMES_HASH,
            "competition_tier_sql_index": COMPETITION_TIER_SQL_INDEX,
            "valid_competition_tiers": list(VALID_COMPETITION_TIERS),
        },
    )
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
        if (
            fv is not None
            and len(fv) == FEATURE_COUNT
            and _has_valid_feature_semantics(fv)
        ):
            raw_features.append(fv)
            valid_indices.append(i)
        else:
            log.warning(
                "Skipping unsuitable bet row %s: length=%s expected=%d competition_tier=%s",
                row.get("id"),
                len(fv) if fv else None,
                FEATURE_COUNT,
                _feature_at(fv, COMPETITION_TIER_FEATURE_INDEX),
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
    # Disable per-sample weights for the binary classifier.
    #
    # Per-sample weights derived from |unit_return| (winning-longshot bias)
    # were empirically shown to invert the OOS rank order on this corpus:
    # uncapped weights → AUC≈0.45, no weights → AUC≈0.69 with the same
    # CPCV path. The mechanism: weighted classification up-weights the
    # exception cases (longshot wins, favorite losses) until the model
    # learns to predict the exceptions. `scale_pos_weight` is preserved
    # below because it's a class-imbalance correction at the loss level,
    # not a per-sample weight.
    sample_weights = None

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

        # Compute unit return from odds+outcome (avoids using null pnl as zero).
        unit_return = _compute_unit_return(
            r["outcome"],
            float(r.get("soft_odds") or 0),
            float(r.get("soft_commission_pct") or 0),
        )

        meta_records.append({
            "id": r["id"],
            "outcome": r["outcome"],
            "pnl": float(r.get("pnl") or 0) if r.get("placed_at") else unit_return,
            "unit_return": unit_return,
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
    for col in ("pnl", "unit_return", "soft_odds", "sharp_true_prob", "soft_commission_pct",
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
            "unit_return": pl.Float64,
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
    """Load from the ml_training_examples table (preferred path).

    Returns None if the table doesn't exist or has no usable rows,
    so the caller can fall back to load_training_data().

    Sample-weight discipline:
      - Trust stored sample_weight directly (no double PnL boost)
      - Compute unit return from odds+outcome for financial metrics
      - Only load labeled rows at current feature version
    """
    try:
        count_stmt = text("""
            SELECT count(*) AS n
            FROM ml_training_examples
            WHERE label IS NOT NULL
              AND label IN ('positive', 'negative')
              AND features IS NOT NULL
              AND feature_version = :version
              AND array_length(features, 1) = :feature_count
              AND features[:sharp_prob_sql_index] > 0
              AND features[:sharp_prob_sql_index] < 1
              AND features[:adjusted_odds_sql_index] > 1.01
              AND features[:competition_tier_sql_index] = ANY(:valid_competition_tiers)
        """)
        count_result = session.execute(
            count_stmt,
            {
                "version": FEATURE_VERSION,
                "feature_count": FEATURE_COUNT,
                "sharp_prob_sql_index": SHARP_TRUE_PROB_SQL_INDEX,
                "adjusted_odds_sql_index": ADJUSTED_SOFT_ODDS_SQL_INDEX,
                "competition_tier_sql_index": COMPETITION_TIER_SQL_INDEX,
                "valid_competition_tiers": list(VALID_COMPETITION_TIERS),
            },
        ).scalar()
        if not count_result or count_result == 0:
            log.info(
                "ml_training_examples has no labeled current-contract rows; "
                "falling back to bets table"
            )
            return None
    except ProgrammingError as exc:
        if _is_missing_table_error(exc):
            log.info(
                "ml_training_examples table is missing; falling back to bets table"
            )
            session.rollback()
            return None
        session.rollback()
        raise RuntimeError(
            "ml_training_examples probe failed before fallback; "
            "check bound parameters and SQL compatibility"
        ) from exc
    except Exception as exc:
        session.rollback()
        raise RuntimeError(
            "ml_training_examples probe failed before fallback"
        ) from exc

    stmt = text("""
        SELECT
            m.id,
            m.source_bet_id,
            m.example_type,
            m.event_id,
            m.family_id,
            m.atom_id,
            m.features,
            m.feature_version,
            m.label,
            m.label_source,
            m.sample_weight,
            m.outcome,
            coalesce(m.pnl, b.pnl) as pnl,
            coalesce(m.clv_pct, b.clv_pct) as clv_pct,
            m.created_at,
            m.settled_at,
            b.soft_odds,
            b.sharp_true_prob,
            b.soft_commission_pct,
            b.closing_sharp_odds,
            b.event_start_time
        FROM ml_training_examples m
        LEFT JOIN bets b ON m.source_bet_id = b.id
        WHERE m.label IS NOT NULL
          AND m.label IN ('positive', 'negative')
          AND m.features IS NOT NULL
          AND m.feature_version = :version
          AND array_length(m.features, 1) = :feature_count
          AND m.features[:sharp_prob_sql_index] > 0
          AND m.features[:sharp_prob_sql_index] < 1
          AND m.features[:adjusted_odds_sql_index] > 1.01
          AND m.features[:competition_tier_sql_index] = ANY(:valid_competition_tiers)
        ORDER BY coalesce(m.settled_at, m.created_at) ASC
    """)

    result = session.execute(
        stmt,
        {
            "version": FEATURE_VERSION,
            "feature_count": FEATURE_COUNT,
            "sharp_prob_sql_index": SHARP_TRUE_PROB_SQL_INDEX,
            "adjusted_odds_sql_index": ADJUSTED_SOFT_ODDS_SQL_INDEX,
            "competition_tier_sql_index": COMPETITION_TIER_SQL_INDEX,
            "valid_competition_tiers": list(VALID_COMPETITION_TIERS),
        },
    )
    rows = result.mappings().all()

    if not rows:
        return None

    def _coerce(r: Any) -> dict[str, Any]:
        d = dict(r)
        for k, v in d.items():
            if isinstance(v, Decimal):
                d[k] = float(v)
        return d

    coerced = _canonicalize_training_example_rows([_coerce(r) for r in rows])
    if not coerced:
        return None

    # Log canonicalization dedup results
    n_raw = len(rows)
    n_canonical = len(coerced)
    if n_raw != n_canonical:
        type_counts = {}
        for r in coerced:
            et = r.get("example_type", "?")
            type_counts[et] = type_counts.get(et, 0) + 1
        log.info(
            "Canonicalized %d raw → %d unique examples (deduped %d). "
            "Composition: %s",
            n_raw, n_canonical, n_raw - n_canonical,
            ", ".join(f"{k}={v}" for k, v in sorted(type_counts.items())),
        )

    raw_features = []
    raw_weights = []
    valid_coerced = []
    for row in coerced:
        fv = row.get("features")
        if (
            fv is not None
            and len(fv) == FEATURE_COUNT
            and _has_valid_feature_semantics(fv)
        ):
            raw_features.append(fv)
            # Trust stored sample_weight directly — the TS writer
            # already applied PnL boost. Do NOT double-apply.
            raw_weights.append(float(row.get("sample_weight", 1.0)))
            valid_coerced.append(row)
        else:
            log.warning(
                "Skipping training example %s: invalid feature vector "
                "(length=%s, expected=%d, competition_tier=%s)",
                row.get("id"),
                len(fv) if fv else None,
                FEATURE_COUNT,
                _feature_at(fv, COMPETITION_TIER_FEATURE_INDEX),
            )

    if not raw_features:
        return None

    features = np.array(raw_features, dtype=np.float32)

    labels = np.array(
        [1 if r["label"] == "positive" else 0 for r in valid_coerced],
        dtype=np.int32,
    )

    # Disable per-sample weights for the binary classifier.
    # See `load_training_data` above for the empirical justification.
    # `raw_weights` is intentionally unused here.
    _ = raw_weights
    sample_weights = None

    # Compute conservative scale_pos_weight
    n_pos = int(labels.sum())
    n_neg = int((labels == 0).sum())
    spw = _compute_scale_pos_weight(n_pos, n_neg)

    # Build minimal metadata DataFrame
    meta_records = []
    for r in valid_coerced:
        fv = r.get("features") or []
        soft_odds = float(
            r.get("soft_odds")
            or _feature_at(fv, SOFT_ODDS_FEATURE_INDEX)
            or _feature_at(fv, ADJUSTED_SOFT_ODDS_FEATURE_INDEX)
            or 0
        )
        commission_pct = float(r.get("soft_commission_pct") or 0)
        # Compute unit return from odds+outcome.
        unit_return = _compute_unit_return(
            r.get("outcome", ""),
            soft_odds,
            commission_pct,
        )

        source_id = r.get("source_bet_id") or r["id"]
        meta_records.append({
            "id": str(source_id),
            "example_type": r.get("example_type"),
            "outcome": r.get("outcome", ""),
            "pnl": unit_return if unit_return is not None else 0.0,
            "unit_return": unit_return,
            "soft_odds": soft_odds,
            "sharp_true_prob": float(r.get("sharp_true_prob") or 0),
            "soft_commission_pct": commission_pct,
            "closing_sharp_odds": float(r.get("closing_sharp_odds")) if r.get("closing_sharp_odds") else None,
            "clv_pct": float(r.get("clv_pct")) if r.get("clv_pct") else None,
            "first_seen_at": r.get("created_at"),
            "event_start_time": r.get("event_start_time"),
            "event_id": r.get("event_id"),
        })

    metadata = pl.DataFrame(meta_records, infer_schema_length=None, strict=False)
    for col in ("pnl", "unit_return", "soft_odds", "sharp_true_prob", "soft_commission_pct",
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

    Strategy:
      1. Prefer ml_training_examples (curated, canonicalized,
         one example per bet via _canonicalize_training_example_rows).
      2. Fall back to bets table only if training_examples is empty.

    The merge/supplement path has been removed: production data shows 100%
    overlap between ml_training_examples and bets (0 uncovered bets), so
    the merge only added complexity and dedup risk without adding data.
    """
    from_examples = load_from_training_examples(session)

    if from_examples is not None and from_examples.n_samples > 0:
        log.info(
            "Using ml_training_examples table (%d canonical samples)",
            from_examples.n_samples,
        )
        return from_examples

    # Fall back to bets table (legacy path or empty training_examples)
    bets_data = load_training_data(session)
    log.info("Falling back to bets table for training data (%d samples)", bets_data.n_samples)
    return bets_data


def _canonicalize_training_example_rows(
    rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Keep one strongest labeled example per source selection.

    `ml_training_examples` may contain several labels for the same bet
    (`shadow_scored`, `settled_detected`, `placed_settled`).
    Training on all of them double-counts one decision. The canonical row is
    the highest-precedence evidence; ties prefer settled/newer rows.
    """
    best_by_key: dict[str, dict[str, Any]] = {}

    for row in rows:
        source_id = row.get("source_bet_id")
        key = (
            str(source_id)
            if source_id is not None
            else f"{row.get('event_id')}|{row.get('family_id')}|{row.get('atom_id')}"
        )

        existing = best_by_key.get(key)
        if existing is None or _example_rank(row) > _example_rank(existing):
            best_by_key[key] = row

    return sorted(
        best_by_key.values(),
        key=lambda r: str(r.get("settled_at") or r.get("created_at") or ""),
    )


def _example_rank(row: dict[str, Any]) -> tuple[int, int, str]:
    example_type = str(row.get("example_type") or "")
    precedence = EXAMPLE_TYPE_PRECEDENCE.get(example_type, 0)
    has_settlement = 1 if row.get("settled_at") is not None else 0
    recency = str(row.get("settled_at") or row.get("created_at") or "")
    return (precedence, has_settlement, recency)


def _is_missing_table_error(exc: BaseException) -> bool:
    message = str(exc).lower()
    return (
        "ml_training_examples" in message
        and (
            "does not exist" in message
            or "undefinedtable" in message
            or "no such table" in message
        )
    )


def _feature_at(features: Any, index: int) -> Any:
    if features is None or len(features) <= index:
        return None
    return features[index]


def _has_valid_feature_semantics(features: Any) -> bool:
    if features is None or len(features) != FEATURE_COUNT:
        return False
    try:
        import math
        values = [float(v) for v in features]
        if not all(math.isfinite(v) for v in values):
            return False
        competition_tier = float(features[COMPETITION_TIER_FEATURE_INDEX])
        sharp_prob = float(features[0])
        adjusted_odds = float(features[ADJUSTED_SOFT_ODDS_FEATURE_INDEX])
    except (TypeError, ValueError):
        return False
    return (
        competition_tier in VALID_COMPETITION_TIERS
        and 0.0 < sharp_prob < 1.0
        and adjusted_odds > 1.01
    )

# ── Sample weight helpers ──────────────────────────────────────────────────

# Half outcomes get reduced weight.
HALF_OUTCOME_WEIGHT = 0.5


def _derive_sample_weights(rows: list[dict[str, Any]]) -> np.ndarray:
    """Derive per-sample weights from outcome type and unit return magnitude.

    Weight formula (fixed for EV alignment):
      base = |unit_return| (economic impact)
      half_outcome_adjustment = 0.5 for half_won/half_lost
      final = base * half_outcome_adjustment, clipped to [0.1, 10.0]

    Rationale: A bet that wins 5 units should have 5x the influence of a bet
    that wins 1 unit. Previous log-scale PnL boost was too weak.
    """
    weights = np.ones(len(rows), dtype=np.float64)

    for i, r in enumerate(rows):
        outcome = r.get("outcome", "")
        soft_odds = float(r.get("soft_odds") or 0)
        commission_pct = float(r.get("soft_commission_pct") or 0)

        # Compute unit return (economic impact)
        unit_return = _compute_unit_return(outcome, soft_odds, commission_pct)
        if unit_return is not None:
            # Weight by absolute return magnitude
            weights[i] = abs(unit_return)

        # Half outcomes still get reduced weight
        if outcome in ("half_won", "half_lost"):
            weights[i] *= 0.5

    # Clip extreme outliers to prevent single bets from dominating
    weights = np.clip(weights, 0.1, 10.0)

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


def _compute_unit_return(
    outcome: str,
    soft_odds: float,
    commission_pct: float,
) -> float | None:
    """Compute normalized 1-unit return for a bet based on outcome and odds.

    Canonical metric for model evaluation — it simulates what would happen
    if we staked exactly 1 unit on this bet.

    Must match the TS `computeUnitReturn()` in lib/ml/outcomes.ts.
    """
    if soft_odds <= 0:
        return None

    # Commission-adjusted net return per unit staked
    b = (soft_odds - 1) * (1 - commission_pct / 100)

    if outcome == "won":
        return b
    elif outcome == "half_won":
        return b * 0.5
    elif outcome == "lost":
        return -1.0
    elif outcome == "half_lost":
        return -0.5
    else:
        return None  # void, pending, cancelled — excluded
