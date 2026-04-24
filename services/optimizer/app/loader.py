"""Load settled bets into a Polars DataFrame.

Hot path of the trial loop reads from this DataFrame thousands of times,
so we load once per run and keep it in memory.

Schema mirrors `lib/db/schema.ts::bets` — columns we actually use are
projected; everything else is dropped to keep memory tight.

Pre-search data-scope filters (the `data_filters` JSONB column on
`optimization_runs`) are applied here in the SQL WHERE clause so excluded
rows never enter memory at all.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import polars as pl
from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session

# Outcomes considered "settled" — used for sizing-aware ROI calculation.
SETTLED_OUTCOMES = ("won", "half_won", "lost", "half_lost", "void")


@dataclass(frozen=True)
class DataFilters:
    """Mirror of TS `DataFiltersJson`.

    Empty filter object = include every settled bet (the default).
    Include* takes precedence over exclude* on the same field (whitelist
    semantics — same as the TS API).
    """

    exclude_soft_providers: tuple[str, ...] = ()
    include_soft_providers: tuple[str, ...] = ()
    exclude_market_types: tuple[str, ...] = ()
    include_market_types: tuple[str, ...] = ()
    event_start_from: str | None = None  # ISO 8601
    event_start_to: str | None = None
    placed_only: bool = False

    @classmethod
    def from_json(cls, payload: dict[str, Any] | None) -> DataFilters:
        p = payload or {}
        return cls(
            exclude_soft_providers=tuple(p.get("excludeSoftProviders") or ()),
            include_soft_providers=tuple(p.get("includeSoftProviders") or ()),
            exclude_market_types=tuple(p.get("excludeMarketTypes") or ()),
            include_market_types=tuple(p.get("includeMarketTypes") or ()),
            event_start_from=p.get("eventStartFrom"),
            event_start_to=p.get("eventStartTo"),
            placed_only=bool(p.get("placedOnly", False)),
        )


def _build_query(filters: DataFilters):
    """Build a parameterized SELECT respecting the supplied data filters.

    Returns (sql_text, params_dict). Always orders by (event_start_time, id)
    for deterministic CV splits and the determinism contract.
    """
    conds: list[str] = ["outcome IN :outcomes"]
    params: dict[str, Any] = {"outcomes": SETTLED_OUTCOMES}

    if filters.placed_only:
        conds.append("placed_at IS NOT NULL")

    # Soft-provider scope — include* wins if both set.
    if filters.include_soft_providers:
        conds.append("soft_provider IN :include_softs")
        params["include_softs"] = filters.include_soft_providers
    elif filters.exclude_soft_providers:
        conds.append("soft_provider NOT IN :exclude_softs")
        params["exclude_softs"] = filters.exclude_soft_providers

    # Market-type scope.
    if filters.include_market_types:
        conds.append("market_type IN :include_markets")
        params["include_markets"] = filters.include_market_types
    elif filters.exclude_market_types:
        conds.append("market_type NOT IN :exclude_markets")
        params["exclude_markets"] = filters.exclude_market_types

    # Event-time window.
    if filters.event_start_from:
        conds.append("event_start_time >= :event_from")
        params["event_from"] = filters.event_start_from
    if filters.event_start_to:
        conds.append("event_start_time < :event_to")
        params["event_to"] = filters.event_start_to

    where = " AND ".join(conds)
    sql_text = (
        f"""
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
        WHERE {where}
        ORDER BY event_start_time ASC, id ASC
        """
    )

    stmt = text(sql_text).bindparams(
        bindparam("outcomes", expanding=True),
        *(
            [bindparam("include_softs", expanding=True)]
            if "include_softs" in params
            else []
        ),
        *(
            [bindparam("exclude_softs", expanding=True)]
            if "exclude_softs" in params
            else []
        ),
        *(
            [bindparam("include_markets", expanding=True)]
            if "include_markets" in params
            else []
        ),
        *(
            [bindparam("exclude_markets", expanding=True)]
            if "exclude_markets" in params
            else []
        ),
    )
    return stmt, params


def load_settled_bets(
    session: Session,
    filters: DataFilters | None = None,
) -> pl.DataFrame:
    """Returns a Polars DataFrame of all settled bets matching the filters.

    Sort order is stable + deterministic for the CV splitter (which assumes
    rows are time-ordered) and for the determinism contract (same input,
    same output).
    """
    f = filters or DataFilters()
    stmt, params = _build_query(f)
    result = session.execute(stmt, params)
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
