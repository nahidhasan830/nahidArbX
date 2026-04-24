"""Trial-loop orchestrator — one coroutine per active run.

Lifecycle:
  - main.py POST /run/start spawns `run_trial_loop(run_id)` as an asyncio task
  - We set status='running', load bets, build CPCV splits
  - For each Optuna-proposed trial:
      * cancellation check (DB poll) — exit cleanly if status='cancelled'
      * evaluate config in a thread (blocks event loop otherwise)
      * persist trial row
  - After loop: extract Pareto frontier, write summary, set status='completed'
  - Any exception → status='failed' with error message.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any

import optuna
import ulid
from sqlalchemy import text

from .bootstrap import stationary_bootstrap_ci
from .config import get_settings
from .cpcv import CpcvConfig, CpcvSplit, expected_n_paths, make_cpcv_splits
from .db import open_session
from .evaluator import TrialResult, evaluate_trial
from .loader import DataFilters, load_settled_bets
from .pareto import ParetoCandidate, extract_pareto
from .ml.evaluator import evaluate_ml_trial, ml_search_space
from .samplers import build_study, is_multi_objective
from .scoring import (
    composite_score,
    deflated_sharpe,
    pbo_score,
    probabilistic_sharpe,
    trial_sharpe_variance,
    whites_reality_check_pvalue,
)
from .search_space import DEFAULT_SEARCH_SPACE, SearchSpace
from .walkforward import WalkForwardConfig, make_walkforward_splits

ML_ALGORITHMS = {"ml-xgboost"}

log = logging.getLogger("alphasearch.runner")


# ── DB queries ────────────────────────────────────────────────────────────


def _fetch_run_row(run_id: str) -> dict[str, Any] | None:
    with open_session() as s:
        row = s.execute(
            text(
                """
                SELECT id, name, status, search_space, search_algorithm,
                       n_trials_target, rng_seed, cv_strategy, data_filters
                FROM optimization_runs WHERE id = :id
                """
            ),
            {"id": run_id},
        ).mappings().first()
        return dict(row) if row else None


def _set_status(
    run_id: str,
    status: str,
    *,
    error: str | None = None,
    started: bool = False,
    completed: bool = False,
    n_trials_done: int | None = None,
    summary: dict[str, Any] | None = None,
    best_trial_id: str | None = None,
) -> None:
    sets = ["status = :status"]
    params: dict[str, Any] = {"id": run_id, "status": status}
    if error is not None:
        sets.append("error = :error")
        params["error"] = error
    if started:
        sets.append("started_at = now()")
    if completed:
        sets.append("completed_at = now()")
    if n_trials_done is not None:
        sets.append("n_trials_done = :ntd")
        params["ntd"] = n_trials_done
    if summary is not None:
        sets.append("summary = CAST(:summary AS jsonb)")
        params["summary"] = json.dumps(summary)
    if best_trial_id is not None:
        sets.append("best_trial_id = :bt")
        params["bt"] = best_trial_id

    with open_session() as s:
        s.execute(
            text(f"UPDATE optimization_runs SET {', '.join(sets)} WHERE id = :id"),
            params,
        )
        s.commit()


def _is_cancelled(run_id: str) -> bool:
    with open_session() as s:
        row = s.execute(
            text("SELECT status FROM optimization_runs WHERE id = :id"),
            {"id": run_id},
        ).first()
        return bool(row and row[0] == "cancelled")


def _sanitize_metric(v: float | None) -> float | None:
    """Coerce `inf` / `nan` / overflow-prone values to `None` before we
    send them to Postgres. Aggressively clamps to the widened
    `numeric(14,4)` envelope (±9,999,999,999.9999) so a pathological
    Sharpe on a std=0 fold doesn't nuke the whole run.
    """
    import math

    if v is None:
        return None
    try:
        fv = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(fv):
        return None  # NaN / +inf / -inf → store as NULL
    if abs(fv) > 9_999_999_999.0:
        return None  # Beyond numeric(14,4) envelope — probably meaningless
    return fv


def _persist_trial(
    *,
    run_id: str,
    trial_index: int,
    sampler: str,
    params: dict[str, Any],
    result: TrialResult,
    ci_low: float,
    ci_high: float,
    dsr: float,
    psr: float,
    composite: float,
) -> str:
    # `ulid-py` exposes `ulid.new()` → ULID object; stringify it for the
    # text primary key. Calling `ulid()` on the module itself raises
    # "'module' object is not callable" (observed 2026-04-24 prod logs).
    trial_id = str(ulid.new())
    payload = {
        "id": trial_id,
        "run_id": run_id,
        "trial_index": trial_index,
        "sampler": sampler,
        "params": json.dumps(params),
        "fold_metrics": json.dumps(
            [
                {
                    "path_index": fm.path_index,
                    "n_bets": fm.n_bets,
                    "roi_pct": fm.roi_pct,
                    "win_rate_pct": fm.win_rate_pct,
                    "sharpe": fm.sharpe,
                    "sortino": fm.sortino,
                    "max_drawdown": fm.max_drawdown,
                    "total_stake": fm.total_stake,
                    "total_pnl": fm.total_pnl,
                    "mean_clv_pct": fm.mean_clv_pct,
                }
                for fm in result.fold_metrics
            ]
        ),
        # Every numeric metric goes through `_sanitize_metric` so an inf /
        # nan / out-of-envelope value becomes NULL instead of blowing up
        # the INSERT. Overflow was seen 2026-04-24 prod — noisy folds
        # produced Sharpe > 10^4 on numeric(8,4) columns.
        "oos_roi_mean": _sanitize_metric(result.oos_roi_mean),
        "oos_roi_ci_low": _sanitize_metric(ci_low),
        "oos_roi_ci_high": _sanitize_metric(ci_high),
        "oos_sortino": _sanitize_metric(result.oos_sortino),
        "oos_sharpe": _sanitize_metric(result.oos_sharpe),
        "deflated_sharpe": _sanitize_metric(dsr),
        "probabilistic_sharpe": _sanitize_metric(psr),
        "max_drawdown": _sanitize_metric(result.max_drawdown),
        "sample_size": result.sample_size,
        "composite_score": _sanitize_metric(composite),
        "on_pareto": False,  # set after run completes
    }
    with open_session() as s:
        s.execute(
            text(
                """
                INSERT INTO optimization_trials (
                    id, run_id, trial_index, sampler, params, fold_metrics,
                    oos_roi_mean, oos_roi_ci_low, oos_roi_ci_high,
                    oos_sortino, oos_sharpe, deflated_sharpe, probabilistic_sharpe,
                    max_drawdown, sample_size, composite_score, on_pareto
                ) VALUES (
                    :id, :run_id, :trial_index, :sampler,
                    CAST(:params AS jsonb), CAST(:fold_metrics AS jsonb),
                    :oos_roi_mean, :oos_roi_ci_low, :oos_roi_ci_high,
                    :oos_sortino, :oos_sharpe, :deflated_sharpe, :probabilistic_sharpe,
                    :max_drawdown, :sample_size, :composite_score, :on_pareto
                )
                """
            ),
            payload,
        )
        s.commit()
    return trial_id


def _mark_pareto(run_id: str, trial_ids_on_pareto: list[str]) -> None:
    if not trial_ids_on_pareto:
        return
    with open_session() as s:
        s.execute(
            text(
                "UPDATE optimization_trials SET on_pareto = true "
                "WHERE run_id = :run_id AND id = ANY(:ids)"
            ),
            {"run_id": run_id, "ids": trial_ids_on_pareto},
        )
        s.commit()


# ── Main loop ─────────────────────────────────────────────────────────────


async def run_trial_loop(run_id: str) -> None:
    """Execute the entire trial sweep for a single run row.

    Errors propagate to status='failed' rather than crashing the whole process.
    """
    settings = get_settings()
    log.info("Run %s: starting", run_id)
    try:
        run = _fetch_run_row(run_id)
        if not run:
            log.error("Run %s: row not found", run_id)
            return
        if run["status"] not in ("queued", "running"):
            log.warning("Run %s: skipping — status=%s", run_id, run["status"])
            return

        _set_status(run_id, "running", started=True)

        # Load data + build splits. `data_filters` is the user's pre-search
        # data scope (e.g. exclude NineWickets-Exchange). Applied in the SQL
        # WHERE clause so excluded rows never enter memory.
        data_filters = DataFilters.from_json(run.get("data_filters"))
        with open_session() as s:
            df = load_settled_bets(s, filters=data_filters)
        if df.height < 50:
            raise RuntimeError(
                f"Only {df.height} settled bets matched the data filters — "
                "too few for meaningful CPCV (need at least 50; target ≥500 "
                "for trustworthy results). Loosen the filters and try again."
            )

        # CV strategy — CPCV (default) or walk-forward, picked by the run row.
        cv_cfg_raw = run["cv_strategy"] or {}
        cv_type = (cv_cfg_raw.get("type") or "cpcv").lower()
        splits: list[CpcvSplit]
        cv_summary: dict[str, Any]
        if cv_type == "walkforward":
            wf_cfg = WalkForwardConfig(
                n_folds=int(cv_cfg_raw.get("n_folds", 6)),
                anchored=bool(cv_cfg_raw.get("anchored", True)),
                embargo_pct=float(cv_cfg_raw.get("embargo_pct", 0.005)),
            )
            splits = make_walkforward_splits(df, wf_cfg)
            cv_summary = {
                "type": "walkforward",
                "n_folds": wf_cfg.n_folds,
                "anchored": wf_cfg.anchored,
                "n_paths": len(splits),
            }
            log.info(
                "Run %s: loaded %d bets, %d walk-forward folds (anchored=%s)",
                run_id, df.height, len(splits), wf_cfg.anchored,
            )
        else:
            cv_cfg = CpcvConfig(
                n_groups=int(cv_cfg_raw.get("n_groups", 10)),
                n_test_groups=int(cv_cfg_raw.get("n_test_groups", 2)),
                embargo_pct=float(cv_cfg_raw.get("embargo_pct", 0.01)),
            )
            splits = make_cpcv_splits(df, cv_cfg)
            cv_summary = {
                "type": "cpcv",
                "n_groups": cv_cfg.n_groups,
                "n_test_groups": cv_cfg.n_test_groups,
                "n_paths": expected_n_paths(cv_cfg),
            }
            log.info(
                "Run %s: loaded %d bets, %d CPCV paths (n_groups=%d, n_test=%d)",
                run_id, df.height, len(splits), cv_cfg.n_groups, cv_cfg.n_test_groups,
            )

        # Search space + algorithm. ML algorithms (e.g. 'ml-xgboost') get a
        # default search space tuned for XGBoost hyperparams when the run row
        # didn't specify one explicitly. The Optuna sampler tier (random / TPE
        # / NSGA-II / ensemble) is orthogonal to whether the trial evaluator
        # is rule-based or ML — both routes share the same study machinery.
        algorithm = run["search_algorithm"] or "tpe"
        is_ml = algorithm in ML_ALGORITHMS

        space_payload = run["search_space"] or {}
        if space_payload.get("dimensions"):
            space = SearchSpace.from_json(space_payload)
        elif is_ml:
            space = ml_search_space()
        else:
            space = DEFAULT_SEARCH_SPACE

        # ML uses TPE for the Optuna sampler regardless of `algorithm` (since
        # the algorithm field is overloaded — 'ml-xgboost' encodes both
        # "evaluator = ML" and "use Bayesian search by default").
        sampler_algo = "tpe" if is_ml else algorithm
        study = build_study(
            algorithm=sampler_algo,
            seed=int(run["rng_seed"]),
            multi_objective=is_multi_objective(sampler_algo),
        )

        n_target = int(run["n_trials_target"])
        per_trial_sharpes: list[float] = []
        per_trial_fold_rois: list[list[float]] = []  # for PBO + WRC
        candidates: list[ParetoCandidate] = []
        trial_id_by_index: dict[int, str] = {}
        best_score = -1e18
        best_trial_id: str | None = None
        n_done = 0

        for trial_index in range(n_target):
            if _is_cancelled(run_id):
                log.info("Run %s: cancelled by user at trial %d", run_id, trial_index)
                return

            # Optuna: ask → evaluate (in thread) → tell.
            trial = study.ask()
            config = space.suggest_config(trial)

            # CPU-bound — run in worker thread to keep the event loop free.
            # Branch on algorithm: ML evaluator trains a model per CV fold;
            # rule-based evaluator just applies filters + sizing.
            evaluator_fn = evaluate_ml_trial if is_ml else evaluate_trial
            result: TrialResult = await asyncio.to_thread(
                evaluator_fn, df, splits, config
            )

            # Per-fold ROI series → bootstrap CI.
            roi_series_obj = [
                f.roi_pct for f in result.fold_metrics if f.n_bets > 0
            ]
            import numpy as np

            roi_series = np.array(roi_series_obj, dtype=np.float64)
            ci = stationary_bootstrap_ci(
                roi_series, seed=int(run["rng_seed"]) + trial_index
            )

            # PSR + DSR.
            sharpe_var = trial_sharpe_variance(per_trial_sharpes)
            psr = probabilistic_sharpe(result.oos_sharpe, n=result.sample_size)
            dsr = deflated_sharpe(
                result.oos_sharpe,
                n=result.sample_size,
                n_trials=max(trial_index + 1, 2),
                sharpe_variance_across_trials=sharpe_var,
            )

            comp = composite_score(
                oos_roi_mean=result.oos_roi_mean,
                sample_size=result.sample_size,
                max_drawdown=result.max_drawdown,
                deflated_sharpe_score=dsr,
            )

            trial_id = _persist_trial(
                run_id=run_id,
                trial_index=trial_index,
                sampler=algorithm,
                params=config,
                result=result,
                ci_low=ci.ci_low,
                ci_high=ci.ci_high,
                dsr=dsr,
                psr=psr,
                composite=comp,
            )
            trial_id_by_index[trial_index] = trial_id

            # Tell Optuna (multi-objective: report (roi, dd); single: composite).
            if is_multi_objective(algorithm):
                study.tell(trial, [result.oos_roi_mean, result.max_drawdown])
            else:
                study.tell(trial, comp)

            per_trial_sharpes.append(result.oos_sharpe)
            # Per-fold ROI vector — same length for every trial (one entry
            # per CV path; folds with 0 surviving bets contribute 0.0).
            per_trial_fold_rois.append(
                [
                    f.roi_pct if f.n_bets > 0 else 0.0
                    for f in result.fold_metrics
                ]
            )
            candidates.append(
                ParetoCandidate(
                    trial_index=trial_index,
                    oos_roi=result.oos_roi_mean,
                    max_drawdown=result.max_drawdown,
                    sample_size=result.sample_size,
                )
            )

            if comp > best_score:
                best_score = comp
                best_trial_id = trial_id

            n_done = trial_index + 1
            if n_done % settings.trial_persist_batch_size == 0:
                _set_status(run_id, "running", n_trials_done=n_done)

        # Pareto extraction.
        on_pareto = extract_pareto(candidates)
        pareto_trial_ids = [
            trial_id_by_index[c.trial_index]
            for c, on in zip(candidates, on_pareto, strict=True)
            if on
        ]
        _mark_pareto(run_id, pareto_trial_ids)

        # Run-level overfit detection: PBO + White's Reality Check.
        # Both operate on the per-trial × per-path ROI matrix we collected.
        pbo = pbo_score(per_trial_fold_rois, seed=int(run["rng_seed"]))
        wrc_p = whites_reality_check_pvalue(
            per_trial_fold_rois, seed=int(run["rng_seed"])
        )

        # Summary.
        summary = {
            "n_trials_completed": n_done,
            "n_pareto": sum(on_pareto),
            "best_composite_score": best_score,
            "best_trial_id": best_trial_id,
            "cv": cv_summary,
            "pbo": pbo,  # Probability of Backtest Overfitting (0..1; lower=better)
            "wrc_pvalue": wrc_p,  # White's Reality Check p-value (lower=stronger signal)
            "completed_at_utc": datetime.now(timezone.utc).isoformat(),
        }
        _set_status(
            run_id,
            "completed",
            completed=True,
            n_trials_done=n_done,
            summary=summary,
            best_trial_id=best_trial_id,
        )
        log.info("Run %s: completed (%d trials, best score %.4f)", run_id, n_done, best_score)

    except Exception as exc:  # noqa: BLE001
        log.exception("Run %s: failed", run_id)
        _set_status(run_id, "failed", error=str(exc), completed=True)
