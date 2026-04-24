"""Load settled bets into a Polars DataFrame.

Hot path of the trial loop reads from this DataFrame thousands of times,
so we load once per run and keep it in memory.

Schema mirrors `lib/db/schema.ts::bets` — columns we actually use are
projected; everything else is dropped to keep memory tight.
"""

from __future__ import annotations

import polars as pl
from sqlalchemy import text
from sqlalchemy.orm import Session

# Outcomes considered "settled" — used for sizing-aware ROI calculation.
SETTLED_OUTCOMES = ("won", "half_won", "lost", "half_lost", "void")

_BETS_QUERY = text(
    """
    SELECT
        id,
        event_id            AS event_id,
        family_id           AS family_id,
        atom_id             AS atom_id,
        market_type         AS market_type,
        time_scope          AS time_scope,
        competition         AS competition,
        event_start_time    AS event_start_time,
        first_seen_at       AS first_seen_at,
        sharp_provider      AS sharp_provider,
        sharp_odds          AS sharp_odds,
        sharp_true_prob     AS sharp_true_prob,
        sharp_odds_age_ms   AS sharp_odds_age_ms,
        soft_provider       AS soft_provider,
        soft_odds           AS soft_odds,
        soft_commission_pct AS soft_commission_pct,
        closing_soft_odds   AS closing_soft_odds,
        closing_sharp_odds  AS closing_sharp_odds,
        tick_count          AS tick_count,
        outcome             AS outcome,
        pnl                 AS pnl,
        clv_pct             AS clv_pct,
        placed_at           AS placed_at,
        stake               AS stake,
        odds                AS odds
    FROM bets
    WHERE outcome IN :outcomes
    ORDER BY event_start_time ASC, id ASC
    """
).bindparams()


def load_settled_bets(session: Session) -> pl.DataFrame:
    """Returns a Polars DataFrame of all settled bets, sorted by event time.

    Sort order is stable + deterministic for the CV splitter (which assumes
    rows are time-ordered) and for the determinism contract (same input,
    same output).
    """
    result = session.execute(
        _BETS_QUERY.bindparams(outcomes=SETTLED_OUTCOMES)
    )
    rows = result.mappings().all()
    if not rows:
        return _empty_frame()

    # Polars from list-of-dicts is zero-copy when the values are scalar.
    df = pl.DataFrame([dict(r) for r in rows])

    # Coerce types — DECIMAL -> Float64, timestamp strings -> Datetime.
    numeric_cols = [
        "sharp_odds",
        "sharp_true_prob",
        "soft_odds",
        "soft_commission_pct",
        "closing_soft_odds",
        "closing_sharp_odds",
        "pnl",
        "clv_pct",
        "stake",
        "odds",
    ]
    df = df.with_columns(
        [pl.col(c).cast(pl.Float64, strict=False) for c in numeric_cols if c in df.columns]
    )

    # Compute EV% inline (matches `aggregateBets` formula in TS exactly):
    # ((1 + (softOdds - 1) * (1 - commissionPct/100)) * sharpTrueProb - 1) * 100
    df = df.with_columns(
        (
            (
                (1.0 + (pl.col("soft_odds") - 1.0) * (1.0 - pl.col("soft_commission_pct") / 100.0))
                * pl.col("sharp_true_prob")
                - 1.0
            )
            * 100.0
        ).alias("ev_pct")
    )

    return df


def _empty_frame() -> pl.DataFrame:
    """Schema-correct empty frame so downstream code doesn't crash on
    edge-case 'no settled bets yet' deployments."""
    return pl.DataFrame(
        schema={
            "id": pl.Utf8,
            "event_id": pl.Utf8,
            "family_id": pl.Utf8,
            "atom_id": pl.Utf8,
            "market_type": pl.Utf8,
            "time_scope": pl.Utf8,
            "competition": pl.Utf8,
            "event_start_time": pl.Datetime,
            "first_seen_at": pl.Datetime,
            "sharp_provider": pl.Utf8,
            "sharp_odds": pl.Float64,
            "sharp_true_prob": pl.Float64,
            "sharp_odds_age_ms": pl.Int64,
            "soft_provider": pl.Utf8,
            "soft_odds": pl.Float64,
            "soft_commission_pct": pl.Float64,
            "closing_soft_odds": pl.Float64,
            "closing_sharp_odds": pl.Float64,
            "tick_count": pl.Int64,
            "outcome": pl.Utf8,
            "pnl": pl.Float64,
            "clv_pct": pl.Float64,
            "placed_at": pl.Datetime,
            "stake": pl.Float64,
            "odds": pl.Float64,
            "ev_pct": pl.Float64,
        }
    )
