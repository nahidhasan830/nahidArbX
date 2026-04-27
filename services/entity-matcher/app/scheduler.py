"""Background ML scheduler — runs as an asyncio task inside the FastAPI process.

Reads config from `matcher_config`, picks up all `inbox` pairs from
`match_pairs`, scores them in-process using the bi-encoder (+ optional
cross-encoder escalation), routes results via direct SQL, and logs runs
to `matcher_runs`.

No HTTP round-trips for scoring — embeddings and cross-encoder happen
in the same process that holds the loaded model weights.

The Next.js UI writes config to `matcher_config`; this scheduler reads
it every tick. The UI is a pure dashboard — all processing happens here.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
from sqlalchemy import text

from .db import get_engine
from .models import embed_many, cross_score, EMBEDDING_DIM
from .conformal import get_calibrator

log = logging.getLogger("entity-matcher.scheduler")

# ─── Config read from Postgres ───────────────────────────────────────────


@dataclass
class MatcherConfig:
    enabled: bool = False
    interval_ms: int = 60_000
    team_merge_threshold: float = 0.9
    comp_merge_threshold: float = 0.75
    team_reject_threshold: float = 0.5
    combined_merge_threshold: float = 0.88
    combined_reject_threshold: float = 0.5
    xe_escalation_enabled: bool = True
    xe_escalation_low: float = 0.7
    xe_escalation_high: float = 0.89
    xe_merge_threshold: float = 0.9
    xe_pvalue_threshold: float = 0.05


def read_config() -> MatcherConfig:
    engine = get_engine()
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT * FROM matcher_config WHERE id = 'default'")
        ).mappings().first()
        if not row:
            return MatcherConfig()
        return MatcherConfig(
            enabled=row["enabled"],
            interval_ms=row["interval_ms"],
            team_merge_threshold=row["team_merge_threshold"],
            comp_merge_threshold=row["comp_merge_threshold"],
            team_reject_threshold=row["team_reject_threshold"],
            combined_merge_threshold=row["combined_merge_threshold"],
            combined_reject_threshold=row["combined_reject_threshold"],
            xe_escalation_enabled=row["xe_escalation_enabled"],
            xe_escalation_low=row["xe_escalation_low"],
            xe_escalation_high=row["xe_escalation_high"],
            xe_merge_threshold=row["xe_merge_threshold"],
            xe_pvalue_threshold=row["xe_pvalue_threshold"],
        )


# ─── Scheduler state ─────────────────────────────────────────────────────


@dataclass
class SchedulerState:
    running: bool = False
    processing: bool = False
    task: Optional[asyncio.Task] = field(default=None, repr=False)
    last_run_at: Optional[str] = None
    last_batch_size: int = 0
    total_processed: int = 0


_state = SchedulerState()


def get_scheduler_status() -> dict:
    config = read_config()
    return {
        "active": _state.running,
        "processing": _state.processing,
        "intervalMs": config.interval_ms,
        "lastRunAt": _state.last_run_at,
        "lastBatchSize": _state.last_batch_size,
        "totalProcessed": _state.total_processed,
        "config": {
            "enabled": config.enabled,
            "interval_ms": config.interval_ms,
            "team_merge_threshold": config.team_merge_threshold,
            "combined_merge_threshold": config.combined_merge_threshold,
            "xe_escalation_enabled": config.xe_escalation_enabled,
        },
    }


# ─── Match pair scoring (in-process, no HTTP) ────────────────────────────

W_TEAM = 0.7
W_COMP = 0.3


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    dot = float(np.dot(a, b))
    norm_a = float(np.linalg.norm(a))
    norm_b = float(np.linalg.norm(b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def compute_verdict(
    home_cos: float,
    away_cos: float,
    comp_cos: float,
    combined: float,
    cfg: MatcherConfig,
) -> str:
    worst_team = min(home_cos, away_cos)
    if worst_team <= cfg.team_reject_threshold:
        return "auto-reject"
    if combined <= cfg.combined_reject_threshold:
        return "auto-reject"
    if worst_team >= cfg.team_merge_threshold and comp_cos >= cfg.comp_merge_threshold:
        return "auto-merge"
    if combined >= cfg.combined_merge_threshold:
        return "auto-merge"
    return "uncertain"


@dataclass
class PairResult:
    pair_id: str
    home_cosine: float
    away_cosine: float
    comp_cosine: float
    combined_score: float
    verdict: str
    xe_score: Optional[float] = None
    xe_pvalue: Optional[float] = None
    model_version: str = "bge-m3"


def score_pairs_batch(pairs: list[dict], cfg: MatcherConfig) -> list[PairResult]:
    """Score a batch of match pairs using in-process bi-encoder embeddings."""
    if not pairs:
        return []

    name_set: set[str] = set()
    for p in pairs:
        name_set.update([
            p["event_a_home_team"], p["event_a_away_team"], p["event_a_competition"],
            p["event_b_home_team"], p["event_b_away_team"], p["event_b_competition"],
        ])

    names = list(name_set)
    vecs = embed_many(names)
    name_to_vec = {name: vecs[i] for i, name in enumerate(names)}

    calibrator = get_calibrator()
    results: list[PairResult] = []

    for p in pairs:
        va_home = name_to_vec.get(p["event_a_home_team"])
        va_away = name_to_vec.get(p["event_a_away_team"])
        va_comp = name_to_vec.get(p["event_a_competition"])
        vb_home = name_to_vec.get(p["event_b_home_team"])
        vb_away = name_to_vec.get(p["event_b_away_team"])
        vb_comp = name_to_vec.get(p["event_b_competition"])

        if any(v is None for v in [va_home, va_away, va_comp, vb_home, vb_away, vb_comp]):
            results.append(PairResult(
                pair_id=p["id"], home_cosine=0, away_cosine=0,
                comp_cosine=0, combined_score=0, verdict="uncertain",
            ))
            continue

        home_home = cosine_similarity(va_home, vb_home)
        away_away = cosine_similarity(va_away, vb_away)
        normal_team = (home_home + away_away) / 2

        home_away = cosine_similarity(va_home, vb_away)
        away_home = cosine_similarity(va_away, vb_home)
        swapped_team = (home_away + away_home) / 2

        if normal_team >= swapped_team:
            home_cos, away_cos = home_home, away_away
        else:
            home_cos, away_cos = home_away, away_home

        comp_cos = cosine_similarity(va_comp, vb_comp)
        team_score = max(normal_team, swapped_team)
        combined = W_TEAM * team_score + W_COMP * comp_cos

        verdict = compute_verdict(home_cos, away_cos, comp_cos, combined, cfg)

        result = PairResult(
            pair_id=p["id"],
            home_cosine=float(home_cos),
            away_cosine=float(away_cos),
            comp_cosine=float(comp_cos),
            combined_score=float(combined),
            verdict=verdict,
            model_version=calibrator.model_version,
        )
        results.append(result)

    # Cross-encoder escalation for uncertain pairs in the band
    if cfg.xe_escalation_enabled:
        uncertain = [
            r for r in results
            if r.verdict == "uncertain"
            and cfg.xe_escalation_low <= r.combined_score <= cfg.xe_escalation_high
        ]
        if uncertain:
            log.info("Escalating %d uncertain pairs to cross-encoder", len(uncertain))
            pair_map = {p["id"]: p for p in pairs}
            for r in uncertain:
                p = pair_map.get(r.pair_id)
                if not p:
                    continue
                home_pairs = [(p["event_a_home_team"], p["event_b_home_team"])]
                away_pairs = [(p["event_a_away_team"], p["event_b_away_team"])]
                home_xe = float(cross_score(home_pairs)[0])
                away_xe = float(cross_score(away_pairs)[0])
                cal_home = calibrator.predict(home_xe)
                cal_away = calibrator.predict(away_xe)
                avg_xe = (cal_home.score + cal_away.score) / 2
                worst_pv = max(
                    cal_home.pvalue if cal_home.pvalue is not None else 1.0,
                    cal_away.pvalue if cal_away.pvalue is not None else 1.0,
                )
                r.xe_score = avg_xe
                r.xe_pvalue = worst_pv
                if avg_xe >= cfg.xe_merge_threshold and worst_pv <= cfg.xe_pvalue_threshold:
                    r.verdict = "auto-merge"
                elif avg_xe < cfg.team_reject_threshold:
                    r.verdict = "auto-reject"

    return results


# ─── Batch processing (direct SQL routing) ───────────────────────────────


def process_batch(trigger: str = "scheduler", pair_ids: Optional[list[str]] = None) -> dict:
    """Pick up inbox pairs, score in-process, route via direct SQL."""
    cfg = read_config()
    if trigger == "scheduler" and not cfg.enabled:
        return {"status": "disabled", "processed": 0, "merged": 0, "rejected": 0, "escalated": 0}

    if _state.processing:
        return {"status": "already_running", "processed": 0, "merged": 0, "rejected": 0, "escalated": 0}

    _state.processing = True
    t0 = time.time()
    run_id = str(uuid.uuid4())
    engine = get_engine()

    try:
        # Atomically move inbox → ml_queued
        with engine.begin() as conn:
            conn.execute(text(
                "INSERT INTO matcher_runs (id, trigger) VALUES (:id, :trigger)"
            ), {"id": run_id, "trigger": trigger})

            if pair_ids:
                result = conn.execute(text("""
                    UPDATE match_pairs
                    SET stage = 'ml_queued', stage_changed_at = now()
                    WHERE stage = 'inbox' AND id = ANY(:ids)
                    RETURNING id
                """), {"ids": pair_ids})
            else:
                result = conn.execute(text("""
                    UPDATE match_pairs
                    SET stage = 'ml_queued', stage_changed_at = now()
                    WHERE stage = 'inbox'
                    RETURNING id
                """))
            ids = [row[0] for row in result]

        if not ids:
            with engine.begin() as conn:
                conn.execute(text("""
                    UPDATE matcher_runs
                    SET status = 'empty', completed_at = now(), duration_ms = 0
                    WHERE id = :id
                """), {"id": run_id})
            return {"status": "empty", "processed": 0, "merged": 0, "rejected": 0, "escalated": 0}

        log.info("Processing %d inbox pairs", len(ids))

        # Fetch full rows
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT id,
                       event_a_home_team, event_a_away_team, event_a_competition,
                       event_a_start_time, event_a_provider, event_a_event_id,
                       event_b_home_team, event_b_away_team, event_b_competition,
                       event_b_start_time, event_b_provider, event_b_event_id,
                       string_score
                FROM match_pairs WHERE id = ANY(:ids)
            """), {"ids": ids}).mappings().all()

        pairs = [dict(r) for r in rows]

        # Score in-process (no HTTP round-trip!)
        results = score_pairs_batch(pairs, cfg)

        merged = 0
        rejected = 0
        escalated = 0

        with engine.begin() as conn:
            for r in results:
                # Write ML scores
                conn.execute(text("""
                    UPDATE match_pairs SET
                        ml_home_cosine = :hc,
                        ml_away_cosine = :ac,
                        ml_comp_cosine = :cc,
                        ml_combined_score = :cs,
                        ml_scored_at = now(),
                        ml_model_version = :mv
                    WHERE id = :id
                """), {
                    "id": r.pair_id,
                    "hc": r.home_cosine,
                    "ac": r.away_cosine,
                    "cc": r.comp_cosine,
                    "cs": r.combined_score,
                    "mv": r.model_version,
                })

                if r.xe_score is not None:
                    conn.execute(text("""
                        UPDATE match_pairs SET
                            xe_score = :xs, xe_pvalue = :xp, xe_scored_at = now()
                        WHERE id = :id
                    """), {"id": r.pair_id, "xs": r.xe_score, "xp": r.xe_pvalue})

                decided_by = (
                    "ml-cross-encoder" if r.xe_score is not None else "ml-bi-encoder"
                )
                reason = f"combined={r.combined_score:.3f}"
                if r.xe_score is not None:
                    reason += f" xe={r.xe_score:.3f}"

                if r.verdict == "auto-merge":
                    conn.execute(text("""
                        UPDATE match_pairs SET
                            stage = 'history',
                            decision = 'auto-merge',
                            decided_by = :db,
                            decided_at = now(),
                            decision_reason = :reason,
                            stage_changed_at = now()
                        WHERE id = :id
                    """), {"id": r.pair_id, "db": decided_by, "reason": reason})
                    merged += 1

                elif r.verdict == "auto-reject":
                    conn.execute(text("""
                        UPDATE match_pairs SET
                            stage = 'history',
                            decision = 'auto-reject',
                            decided_by = :db,
                            decided_at = now(),
                            decision_reason = :reason,
                            stage_changed_at = now()
                        WHERE id = :id
                    """), {"id": r.pair_id, "db": decided_by, "reason": reason})
                    rejected += 1

                elif r.verdict == "uncertain":
                    conn.execute(text("""
                        UPDATE match_pairs SET
                            stage = 'human_review',
                            stage_changed_at = now()
                        WHERE id = :id
                    """), {"id": r.pair_id})
                    escalated += 1

        duration_ms = int((time.time() - t0) * 1000)

        # Record run result
        with engine.begin() as conn:
            conn.execute(text("""
                UPDATE matcher_runs SET
                    status = 'success',
                    completed_at = now(),
                    duration_ms = :dur,
                    processed = :p,
                    merged = :m,
                    rejected = :r,
                    escalated = :e
                WHERE id = :id
            """), {
                "id": run_id, "dur": duration_ms,
                "p": len(pairs), "m": merged, "r": rejected, "e": escalated,
            })

        _state.last_run_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        _state.last_batch_size = len(pairs)
        _state.total_processed += len(pairs)

        log.info(
            "Batch complete in %dms: %d merged, %d rejected, %d → human_review",
            duration_ms, merged, rejected, escalated,
        )

        return {
            "status": "success",
            "processed": len(pairs),
            "merged": merged,
            "rejected": rejected,
            "escalated": escalated,
            "durationMs": duration_ms,
        }

    except Exception as exc:
        duration_ms = int((time.time() - t0) * 1000)
        log.exception("process_batch failed: %s", exc)

        # Return pairs to inbox on failure
        try:
            with engine.begin() as conn:
                conn.execute(text("""
                    UPDATE match_pairs
                    SET stage = 'inbox', stage_changed_at = now()
                    WHERE stage = 'ml_queued'
                """))
                conn.execute(text("""
                    UPDATE matcher_runs SET
                        status = 'service_error',
                        completed_at = now(),
                        duration_ms = :dur,
                        error_message = :err
                    WHERE id = :id
                """), {"id": run_id, "dur": duration_ms, "err": str(exc)})
        except Exception:
            pass

        return {
            "status": "service_error",
            "processed": 0,
            "merged": 0,
            "rejected": 0,
            "escalated": 0,
            "error": str(exc),
        }
    finally:
        _state.processing = False


# ─── Batch processing (direct SQL routing) ───────────────────────────────
