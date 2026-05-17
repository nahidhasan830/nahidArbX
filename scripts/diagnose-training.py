#!/usr/bin/env python3
"""Diagnose ML training pipeline failures — run locally, not via Cloud Run.

Usage:
    cd services/optimizer
    source .venv/bin/activate   # or: uv run python ../../scripts/diagnose-training.py
    python ../../scripts/diagnose-training.py

Walks through every stage of app/job.py with detailed error reporting:
  1. Config + env vars
  2. DB connectivity
  3. Data loading (ml_training_examples + bets)
  4. Feature contract validation
  5. CPCV splitting
  6. LightGBM training (single fold dry-run)
  7. Full CPCV training
  8. Deployment gate evaluation
  9. ONNX export (dry-run)
"""

from __future__ import annotations

import json
import logging
import os
import sys
import traceback
from pathlib import Path

# Ensure the optimizer package is importable
REPO_ROOT = Path(__file__).resolve().parent.parent
OPTIMIZER_ROOT = REPO_ROOT / "services" / "optimizer"
sys.path.insert(0, str(OPTIMIZER_ROOT))

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s %(levelname)-5s %(name)s  %(message)s",
)
log = logging.getLogger("diagnose")

PASS = "✅"
FAIL = "❌"
WARN = "⚠️"
INFO = "ℹ️"

results: list[tuple[str, str, str]] = []  # (status, stage, detail)


def record(status: str, stage: str, detail: str = ""):
    results.append((status, stage, detail))
    icon = {PASS: "✅", FAIL: "❌", WARN: "⚠️", INFO: "ℹ️"}.get(status, "?")
    print(f"\n{icon}  [{stage}] {detail}")


def print_summary():
    print("\n" + "=" * 72)
    print("DIAGNOSIS SUMMARY")
    print("=" * 72)
    for status, stage, detail in results:
        icon = {PASS: "✅", FAIL: "❌", WARN: "⚠️", INFO: "ℹ️"}.get(status, "?")
        short = detail[:100] + "…" if len(detail) > 100 else detail
        print(f"  {icon} {stage:35s} {short}")
    n_fail = sum(1 for s, _, _ in results if s == FAIL)
    print("=" * 72)
    if n_fail:
        print(f"  {n_fail} FAILURE(S) detected — see details above.")
    else:
        print("  All stages passed. Training should succeed.")
    print()


# ── Stage 1: Config + env vars ─────────────────────────────────────────────

def stage_config():
    stage = "1. Config + Env"
    try:
        from app.config import get_settings
        settings = get_settings()
        record(PASS, stage, f"Settings loaded OK")

        if not settings.database_url:
            record(FAIL, stage, "DATABASE_URL is empty")
            return None
        else:
            # mask password
            from urllib.parse import urlparse
            p = urlparse(settings.database_url)
            safe = f"{p.scheme}://{p.username}:***@{p.hostname}:{p.port}{p.path}"
            record(PASS, stage, f"DATABASE_URL={safe}")

        csql = settings.cloud_sql_instance
        record(INFO, stage, f"CLOUD_SQL_INSTANCE={'<set: ' + csql + '>' if csql else '<not set>'}")
        record(INFO, stage, f"ML_MODEL_BUCKET={settings.ml_model_bucket}")
        record(INFO, stage, f"ML_COLD_START_THRESHOLD={settings.ml_cold_start_threshold}")

        return settings
    except Exception as e:
        record(FAIL, stage, f"Failed to load config: {e}")
        traceback.print_exc()
        return None


# ── Stage 2: DB connectivity ──────────────────────────────────────────────

def stage_db():
    stage = "2. DB Connectivity"
    try:
        from app.db import open_session
        session = open_session()

        # Simple query
        from sqlalchemy import text
        result = session.execute(text("SELECT 1 AS ping"))
        val = result.scalar()
        assert val == 1
        record(PASS, stage, "SELECT 1 OK — DB is reachable")

        # Check required tables exist
        tables_result = session.execute(text("""
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('bets', 'ml_models', 'ml_training_examples')
            ORDER BY table_name
        """))
        found_tables = [r[0] for r in tables_result]
        record(INFO, stage, f"Found tables: {found_tables}")

        required = {'bets', 'ml_models'}
        missing = required - set(found_tables)
        if missing:
            record(FAIL, stage, f"Missing required tables: {missing}")
        else:
            record(PASS, stage, "All required tables present")

        # Check for stuck 'training' rows
        stuck = session.execute(text(
            "SELECT id, training_started_at FROM ml_models WHERE status = 'training'"
        ))
        stuck_rows = list(stuck)
        if stuck_rows:
            record(WARN, stage,
                   f"{len(stuck_rows)} stuck 'training' row(s): "
                   + ", ".join(f"{r[0]} (started {r[1]})" for r in stuck_rows))
        else:
            record(PASS, stage, "No stuck 'training' rows")

        # Show latest models
        latest = session.execute(text("""
            SELECT id, version, status, training_samples, 
                   training_completed_at, rejection_reasons,
                   feature_version, permission_level
            FROM ml_models
            ORDER BY created_at DESC
            LIMIT 5
        """))
        rows = list(latest)
        if rows:
            print(f"\n  Recent ml_models rows:")
            for r in rows:
                reasons = ""
                if r[5]:
                    try:
                        reasons = f" reasons={json.loads(r[5]) if isinstance(r[5], str) else r[5]}"
                    except Exception:
                        reasons = f" reasons={r[5]}"
                print(f"    v{r[1]:3d} status={r[2]:10s} samples={r[3]:5d} fv={r[6]} "
                      f"perm={r[7]} completed={r[4]}{reasons}")
        else:
            record(INFO, stage, "No ml_models rows found")

        session.close()
        return True
    except Exception as e:
        record(FAIL, stage, f"DB connection failed: {e}")
        traceback.print_exc()
        return False


# ── Stage 3: Data loading ─────────────────────────────────────────────────

def stage_data_loading():
    stage = "3. Data Loading"
    try:
        from app.db import open_session
        from app.feature_names import FEATURE_VERSION, FEATURE_COUNT, FEATURE_NAMES_HASH
        from sqlalchemy import text

        session = open_session()

        # Count qualified bets
        result = session.execute(text("""
            SELECT count(*) FROM bets
            WHERE outcome NOT IN ('pending', 'void')
              AND ml_features IS NOT NULL
        """))
        total_bets = result.scalar()
        record(INFO, stage, f"Total settled bets with ml_features: {total_bets}")

        # Count by feature version
        result = session.execute(text("""
            SELECT ml_feature_version, count(*) as n
            FROM bets
            WHERE outcome NOT IN ('pending', 'void')
              AND ml_features IS NOT NULL
            GROUP BY ml_feature_version
            ORDER BY ml_feature_version
        """))
        version_counts = list(result)
        for fv, n in version_counts:
            marker = " ← current" if fv == FEATURE_VERSION else ""
            record(INFO, stage, f"  Feature version {fv}: {n} bets{marker}")

        # Count qualified at current version
        result = session.execute(text("""
            SELECT count(*) FROM bets
            WHERE outcome NOT IN ('pending', 'void')
              AND ml_features IS NOT NULL
              AND ml_feature_version = :fv
              AND array_length(ml_features, 1) = :fc
        """), {"fv": FEATURE_VERSION, "fc": FEATURE_COUNT})
        current_v_bets = result.scalar()
        record(INFO, stage, f"Bets at current feature version ({FEATURE_VERSION}): {current_v_bets}")

        # Check feature hash match
        result = session.execute(text("""
            SELECT ml_feature_names_hash, count(*) as n
            FROM bets
            WHERE outcome NOT IN ('pending', 'void')
              AND ml_features IS NOT NULL
              AND ml_feature_version = :fv
            GROUP BY ml_feature_names_hash
        """), {"fv": FEATURE_VERSION})
        hash_counts = list(result)
        for h, n in hash_counts:
            match = "MATCH" if h == FEATURE_NAMES_HASH else "MISMATCH"
            record(INFO if match == "MATCH" else WARN, stage,
                   f"  Hash {h[:16]}… ({n} rows) — {match}")

        # Count ml_training_examples
        try:
            result = session.execute(text("""
                SELECT count(*) FROM ml_training_examples
                WHERE label IS NOT NULL
                  AND features IS NOT NULL
                  AND feature_version = :fv
                  AND array_length(features, 1) = :fc
            """), {"fv": FEATURE_VERSION, "fc": FEATURE_COUNT})
            examples_count = result.scalar()
            record(INFO, stage, f"ml_training_examples at current version: {examples_count}")
        except Exception as e:
            record(WARN, stage, f"ml_training_examples query failed: {e}")
            session.rollback()
            examples_count = 0

        # Check outcome distribution
        result = session.execute(text("""
            SELECT outcome, count(*) as n
            FROM bets
            WHERE outcome NOT IN ('pending', 'void')
              AND ml_features IS NOT NULL
              AND ml_feature_version = :fv
            GROUP BY outcome
            ORDER BY n DESC
        """), {"fv": FEATURE_VERSION})
        print(f"\n  Outcome distribution (feature_version={FEATURE_VERSION}):")
        for outcome, n in result:
            print(f"    {outcome}: {n}")

        # Try actual loader
        print(f"\n  Attempting load_best_available()...")
        from app.loader import load_best_available
        session2 = open_session()
        try:
            data = load_best_available(session2)
            record(PASS, stage,
                   f"load_best_available OK: {data.n_samples} samples, "
                   f"{int(data.labels.sum())} positive, "
                   f"{int((data.labels == 0).sum())} negative, "
                   f"features shape={data.features.shape}, "
                   f"fv={data.feature_version}")

            if data.sample_weights is not None:
                import numpy as np
                record(INFO, stage,
                       f"Sample weights: min={data.sample_weights.min():.3f}, "
                       f"max={data.sample_weights.max():.3f}, "
                       f"mean={data.sample_weights.mean():.3f}")

            if data.scale_pos_weight is not None:
                record(INFO, stage, f"scale_pos_weight={data.scale_pos_weight}")

            # Check for NaN/Inf in features
            import numpy as np
            n_nan = int(np.isnan(data.features).sum())
            n_inf = int(np.isinf(data.features).sum())
            if n_nan > 0 or n_inf > 0:
                record(FAIL, stage, f"Feature matrix has {n_nan} NaN and {n_inf} Inf values!")
            else:
                record(PASS, stage, "Feature matrix clean (no NaN/Inf)")

            # Check feature ranges
            for i, name in enumerate(data.feature_names):
                col = data.features[:, i]
                col_finite = col[np.isfinite(col)]
                if len(col_finite) == 0:
                    record(WARN, stage, f"Feature '{name}' is all NaN/Inf")
                elif col_finite.std() == 0:
                    record(WARN, stage, f"Feature '{name}' has zero variance (constant={col_finite[0]:.4f})")

            return data
        finally:
            session2.close()

        session.close()
    except Exception as e:
        record(FAIL, stage, f"Data loading failed: {e}")
        traceback.print_exc()
        return None


# ── Stage 4: Feature contract ─────────────────────────────────────────────

def stage_feature_contract(data):
    stage = "4. Feature Contract"
    if data is None:
        record(FAIL, stage, "Skipped — no data from Stage 3")
        return False

    try:
        from app.feature_names import FEATURE_COUNT, FEATURE_VERSION, FEATURE_NAMES, FEATURE_NAMES_HASH

        if data.features.shape[1] != FEATURE_COUNT:
            record(FAIL, stage, f"Feature count mismatch: got {data.features.shape[1]}, expected {FEATURE_COUNT}")
            return False
        record(PASS, stage, f"Feature count matches: {FEATURE_COUNT}")

        if data.feature_version != FEATURE_VERSION:
            record(FAIL, stage, f"Feature version mismatch: got {data.feature_version}, expected {FEATURE_VERSION}")
            return False
        record(PASS, stage, f"Feature version matches: {FEATURE_VERSION}")

        if len(data.feature_names) != FEATURE_COUNT:
            record(FAIL, stage, f"Feature names length: {len(data.feature_names)}, expected {FEATURE_COUNT}")
            return False
        record(PASS, stage, f"Feature names length OK: {FEATURE_COUNT}")

        if data.feature_names_hash != FEATURE_NAMES_HASH:
            record(FAIL, stage, f"Feature names hash mismatch: {data.feature_names_hash[:16]}… vs {FEATURE_NAMES_HASH[:16]}…")
            return False
        record(PASS, stage, "Feature names hash matches")

        # Stale-image check equivalent
        expected_fv = os.environ.get("EXPECTED_FEATURE_VERSION")
        if expected_fv:
            try:
                if int(expected_fv) != FEATURE_VERSION:
                    record(FAIL, stage, f"STALE IMAGE: EXPECTED_FEATURE_VERSION={expected_fv} but code has {FEATURE_VERSION}")
                    return False
            except ValueError:
                pass

        return True
    except Exception as e:
        record(FAIL, stage, f"Feature contract check failed: {e}")
        traceback.print_exc()
        return False


# ── Stage 5: CPCV splitting ───────────────────────────────────────────────

def stage_cpcv(data):
    stage = "5. CPCV Splitting"
    if data is None:
        record(FAIL, stage, "Skipped — no data")
        return None

    try:
        import polars as pl
        from app.cpcv import CpcvConfig, make_cpcv_splits

        cfg = CpcvConfig(n_groups=10, n_test_groups=2, embargo_pct=0.01)

        splitter_df = pl.DataFrame({
            "event_id": data.metadata["event_id"].to_list(),
        })

        splits = make_cpcv_splits(splitter_df, cfg)
        record(PASS, stage, f"Created {len(splits)} CPCV folds")

        # Analyze splits
        import numpy as np
        for i, s in enumerate(splits[:3]):  # show first 3
            record(INFO, stage,
                   f"  Fold {i}: train={len(s.train_indices)} test={len(s.test_indices)}")

        too_small = sum(1 for s in splits if len(s.train_indices) < 10 or len(s.test_indices) < 5)
        if too_small:
            record(WARN, stage, f"{too_small}/{len(splits)} folds have too few samples and will be skipped")

        return splits
    except Exception as e:
        record(FAIL, stage, f"CPCV splitting failed: {e}")
        traceback.print_exc()
        return None


# ── Stage 6: Single fold dry-run ──────────────────────────────────────────

def stage_single_fold(data, splits):
    stage = "6. Single Fold Test"
    if data is None or splits is None or len(splits) == 0:
        record(FAIL, stage, "Skipped — no data or splits")
        return False

    try:
        import lightgbm as lgb
        import numpy as np
        from app.trainer import DEFAULT_LGBM_PARAMS, _adaptive_min_child_samples

        params = {**DEFAULT_LGBM_PARAMS}
        params["min_child_samples"] = _adaptive_min_child_samples(data.n_samples)
        if data.scale_pos_weight is not None:
            params["scale_pos_weight"] = data.scale_pos_weight

        # Pick the first valid split
        split = None
        for s in splits:
            if len(s.train_indices) >= 10 and len(s.test_indices) >= 5:
                split = s
                break
        if split is None:
            record(FAIL, stage, "No valid split found with enough samples")
            return False

        X = data.features
        y = data.labels
        w = data.sample_weights

        X_train, y_train = X[split.train_indices], y[split.train_indices]
        X_test, y_test = X[split.test_indices], y[split.test_indices]
        w_train = w[split.train_indices] if w is not None else None

        record(INFO, stage, f"Training single fold: train={len(X_train)} test={len(X_test)}")

        model = lgb.LGBMClassifier(**params)
        model.fit(
            X_train, y_train,
            sample_weight=w_train,
            eval_set=[(X_test, y_test)],
            callbacks=[lgb.log_evaluation(period=0)],
        )

        preds = model.predict_proba(X_test)[:, 1]
        from sklearn.metrics import roc_auc_score
        try:
            auc = roc_auc_score(y_test, preds)
            record(PASS, stage, f"Single fold AUC={auc:.4f}, pred range=[{preds.min():.4f}, {preds.max():.4f}]")
        except ValueError:
            record(WARN, stage, "Single-class in test set — AUC undefined")

        return True
    except Exception as e:
        record(FAIL, stage, f"Single fold training failed: {e}")
        traceback.print_exc()
        return False


# ── Stage 7: Full CPCV training ───────────────────────────────────────────

def stage_full_training(data):
    stage = "7. Full Training"
    if data is None:
        record(FAIL, stage, "Skipped — no data")
        return None

    try:
        from app.trainer import train
        result = train(data)
        m = result.metrics

        record(PASS, stage,
               f"Training complete: AUC={m.auc_roc:.4f}, DSR={m.dsr:.4f}, PBO={m.pbo:.4f}, "
               f"ROI={m.oos_roi_mean:.2f}%, CLV={m.oos_clv_mean:.2f}%, "
               f"CalErr={m.calibration_error:.6f}")

        if m.score_bucket_report:
            br = m.score_bucket_report
            record(INFO, stage,
                   f"Bucket monotonicity: ROI={br.roi_monotonicity:.2f}, "
                   f"CLV={br.clv_monotonicity:.2f}, WR={br.win_rate_monotonicity:.2f}, "
                   f"directional={br.is_directionally_monotonic}")

        if m.feature_importance:
            top_5 = sorted(m.feature_importance.items(), key=lambda x: x[1], reverse=True)[:5]
            record(INFO, stage, f"Top features: {', '.join(f'{k}={v:.4f}' for k, v in top_5)}")

        return result
    except Exception as e:
        record(FAIL, stage, f"Full training failed: {e}")
        traceback.print_exc()
        return None


# ── Stage 8: Deployment gate ──────────────────────────────────────────────

def stage_deployment_gate(training_result, data):
    stage = "8. Deployment Gate"
    if training_result is None:
        record(FAIL, stage, "Skipped — no training result")
        return None

    try:
        from app.deployment_gate import evaluate_deployment_gate
        from app.feature_names import FEATURE_COUNT, FEATURE_VERSION
        from app.db import open_session
        from sqlalchemy import text

        session = open_session()
        try:
            result = session.execute(text("""
                SELECT count(*) FROM bets
                WHERE placed_at IS NOT NULL
                  AND outcome <> 'pending' AND outcome <> 'void'
            """))
            n_placed_settled = int(result.scalar() or 0)
        finally:
            session.close()

        gate_result = evaluate_deployment_gate(
            training_result.metrics,
            n_placed_settled=n_placed_settled,
            feature_version_matches=data.feature_version == FEATURE_VERSION,
            feature_count_matches=len(data.feature_names) == FEATURE_COUNT,
        )

        if gate_result.approved:
            record(PASS, stage,
                   f"APPROVED — permission_level={gate_result.permission_level}")
        else:
            record(FAIL, stage,
                   f"REJECTED — {len(gate_result.rejection_reasons)} reason(s)")
            for r in gate_result.rejection_reasons:
                record(FAIL, stage, f"  → {r}")

        for w in gate_result.warnings:
            record(WARN, stage, f"  Warning: {w}")

        return gate_result
    except Exception as e:
        record(FAIL, stage, f"Deployment gate failed: {e}")
        traceback.print_exc()
        return None


# ── Stage 9: ONNX export dry-run ──────────────────────────────────────────

def stage_onnx_export(training_result):
    stage = "9. ONNX Export"
    if training_result is None:
        record(FAIL, stage, "Skipped — no training result")
        return False

    try:
        import tempfile
        from app.exporter import export_onnx, _validate_onnx_output

        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "test_model.onnx")
            export_onnx(training_result.model, path)

            size_kb = os.path.getsize(path) / 1024
            record(PASS, stage, f"ONNX exported: {size_kb:.1f} KB")

            _validate_onnx_output(path)
            record(PASS, stage, "ONNX inference validation passed")

        return True
    except Exception as e:
        record(FAIL, stage, f"ONNX export failed: {e}")
        traceback.print_exc()
        return False


# ── Stage 10: Cold start threshold check ──────────────────────────────────

def stage_cold_start(data, settings):
    stage = "10. Cold Start Check"
    if data is None or settings is None:
        record(FAIL, stage, "Skipped")
        return False

    threshold = settings.ml_cold_start_threshold
    if data.n_samples < threshold:
        record(FAIL, stage,
               f"COLD START: {data.n_samples} samples < threshold {threshold}. "
               f"Training would be skipped by job.py!")
        return False
    else:
        record(PASS, stage,
               f"{data.n_samples} samples >= threshold {threshold}")
        return True


# ── Main ──────────────────────────────────────────────────────────────────

def main():
    print("=" * 72)
    print("ML TRAINING PIPELINE DIAGNOSTIC")
    print(f"Running from: {os.getcwd()}")
    print(f"Optimizer root: {OPTIMIZER_ROOT}")
    print("=" * 72)

    # Change to optimizer dir so relative imports work
    os.chdir(str(OPTIMIZER_ROOT))

    settings = stage_config()
    if settings is None:
        print_summary()
        sys.exit(1)

    db_ok = stage_db()
    if not db_ok:
        print_summary()
        sys.exit(1)

    data = stage_data_loading()

    stage_cold_start(data, settings)
    contract_ok = stage_feature_contract(data)

    if data is not None and data.n_samples > 0 and contract_ok:
        splits = stage_cpcv(data)
        stage_single_fold(data, splits)

        training_result = stage_full_training(data)
        gate_result = stage_deployment_gate(training_result, data)
        stage_onnx_export(training_result)
    else:
        record(FAIL, "5-9. Training stages", "Skipped — insufficient data or broken contract")

    print_summary()

    n_fail = sum(1 for s, _, _ in results if s == FAIL)
    sys.exit(1 if n_fail else 0)


if __name__ == "__main__":
    main()
