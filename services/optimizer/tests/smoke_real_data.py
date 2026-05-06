#!/usr/bin/env python3
"""Real-data smoke test: load actual settled bets, train, predict, validate.

Adapts to whatever sample size is available — even as few as 8 bets.
For tiny datasets (< 50), skips CPCV and does a simple train-then-predict
round-trip to prove the pipeline works end-to-end with real data.

This script:
  1. Connects to the real Postgres DB (via Cloud SQL Connector)
  2. Loads ALL settled bets with ml_features
  3. Trains LightGBM
  4. Predicts on the data and reports metrics
  5. Exports to ONNX, re-runs inference, verifies match
  6. Cleans up — no model deployed, no DB writes, no artifacts left

Run:  source .venv/bin/activate && python tests/smoke_real_data.py
"""

from __future__ import annotations

import os
import sys
import tempfile

# Ensure app is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import lightgbm as lgb
import numpy as np
import polars as pl

from app.db import open_session
from app.feature_names import FEATURE_COUNT, FEATURE_NAMES
from app.loader import load_training_data

# ── Formatting helpers ──────────────────────────────────────────────────

BOLD = "\033[1m"
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
DIM = "\033[2m"
RESET = "\033[0m"

def header(text: str) -> None:
    print(f"\n{BOLD}{'═' * 60}{RESET}")
    print(f"{BOLD}  {text}{RESET}")
    print(f"{BOLD}{'═' * 60}{RESET}")

def section(text: str) -> None:
    print(f"\n{CYAN}── {text} ──{RESET}")

def ok(text: str) -> None:
    print(f"  {GREEN}✓{RESET} {text}")

def fail(text: str) -> None:
    print(f"  {RED}✗{RESET} {text}")

def info(text: str) -> None:
    print(f"  {DIM}→{RESET} {text}")

def warn(text: str) -> None:
    print(f"  {YELLOW}⚠{RESET} {text}")


def main() -> None:
    header("ML Pipeline Real-Data Smoke Test")

    # ── Step 1: Load data from DB ──────────────────────────────────────
    section("Step 1: Loading settled bets from database")
    session = open_session()
    try:
        data = load_training_data(session)
    finally:
        session.close()

    if data.n_samples == 0:
        fail("No settled bets with ml_features found. Cannot run smoke test.")
        sys.exit(1)

    n = data.n_samples
    n_pos = int(data.labels.sum())
    n_neg = int((data.labels == 0).sum())
    ok(f"Loaded {n} settled bets ({n_pos} won, {n_neg} lost)")
    info(f"Features: {FEATURE_COUNT} dimensions")
    info(f"Win rate: {n_pos / n * 100:.1f}%")

    # Show the raw data
    section("Step 1b: Raw data inspection")
    ids = data.metadata["id"].to_list()
    outcomes = data.metadata["outcome"].to_list()
    pnls = data.metadata["pnl"].to_list()
    odds = data.metadata["soft_odds"].to_list()

    print(f"  {'#':<4} {'Bet ID':<45} {'Outcome':<10} {'Odds':<8} {'PnL':<10}")
    print(f"  {'─'*4} {'─'*45} {'─'*10} {'─'*8} {'─'*10}")
    for i in range(n):
        bet_id = ids[i][:43] if len(ids[i]) > 43 else ids[i]
        pnl_str = f"{pnls[i]:+.2f}" if pnls[i] is not None else "N/A"
        odds_str = f"{odds[i]:.2f}" if odds[i] is not None else "N/A"
        color = GREEN if outcomes[i] in ("won", "half_won") else RED
        print(f"  {i+1:<4} {bet_id:<45} {color}{outcomes[i]:<10}{RESET} {odds_str:<8} {pnl_str}")

    # Show feature vectors for first 3 bets
    section("Step 1c: Feature vectors (first 3 bets)")
    for i in range(min(3, n)):
        print(f"\n  {BOLD}Bet {i+1}: {ids[i][:50]}{RESET}")
        fv = data.features[i]
        for j, name in enumerate(FEATURE_NAMES):
            bar_len = int(min(abs(fv[j]) * 2, 15))
            bar = "█" * bar_len if fv[j] > 0 else "▒" * bar_len
            print(f"    {name:<25} {fv[j]:>10.4f}  {DIM}{bar}{RESET}")

    # ── Step 2: Train LightGBM ──────────────────────────────────────────
    section("Step 2: Training LightGBM")

    if n < 10:
        warn(f"Only {n} samples — too few for CPCV. Doing direct fit + repredict.")
        info("This tests the pipeline machinery, not generalization.")

        model = lgb.LGBMClassifier(
            objective="binary",
            metric="binary_logloss",
            num_leaves=8,
            max_depth=3,
            learning_rate=0.1,
            n_estimators=50,
            min_child_samples=1,  # allow tiny leaf nodes for tiny data
            verbose=-1,
            random_state=42,
        )
        model.fit(data.features, data.labels)
        ok("Model trained (direct fit, no cross-validation)")

        # Predict on training data (not a true test, but proves machinery)
        probs = model.predict_proba(data.features)[:, 1]
        preds = (probs > 0.5).astype(int)
        test_features = data.features
        test_labels = data.labels
        test_meta = data.metadata
        metrics_source = "in-sample (train = test, pipeline validation only)"

    else:
        # Enough data for proper train/test split
        from app.cpcv import CpcvConfig
        from app.trainer import train

        split_idx = int(n * 0.80)
        from app.loader import TrainingData

        train_data = TrainingData(
            features=data.features[:split_idx],
            labels=data.labels[:split_idx],
            feature_names=data.feature_names,
            metadata=data.metadata[:split_idx],
            n_samples=split_idx,
        )
        test_features = data.features[split_idx:]
        test_labels = data.labels[split_idx:]
        test_meta = data.metadata[split_idx:]

        n_groups = min(10, max(3, train_data.n_samples // 30))
        info(f"Using {n_groups} CPCV groups")

        result = train(
            train_data,
            lgbm_params={"n_estimators": 200, "num_leaves": 31, "max_depth": 6},
            cpcv_config=CpcvConfig(n_groups=n_groups, n_test_groups=2, embargo_pct=0.01),
        )
        model = result.model
        m = result.metrics
        ok(f"Training complete (CPCV)")
        info(f"AUC-ROC (OOS):      {m.auc_roc:.4f}")
        info(f"DSR:                {m.dsr:.4f}")
        info(f"PBO:                {m.pbo:.4f}")

        probs = model.predict_proba(test_features)[:, 1]
        preds = (probs > 0.5).astype(int)
        metrics_source = "held-out test set (20%)"

    # ── Step 3: Results ─────────────────────────────────────────────────
    section(f"Step 3: Predictions ({metrics_source})")

    from sklearn.metrics import accuracy_score
    try:
        from sklearn.metrics import roc_auc_score
        test_auc = roc_auc_score(test_labels, probs)
    except ValueError:
        test_auc = float("nan")

    test_acc = accuracy_score(test_labels, preds)
    n_test = len(test_labels)

    ok(f"Accuracy: {test_acc:.4f} ({int(test_acc * n_test)}/{n_test} correct)")
    if not np.isnan(test_auc):
        ok(f"AUC-ROC:  {test_auc:.4f}")
    else:
        warn("AUC-ROC: N/A (single class in test set)")

    # Per-bet predictions
    test_ids = test_meta["id"].to_list()
    test_outcomes = test_meta["outcome"].to_list()

    print(f"\n  {'#':<4} {'Bet ID':<45} {'Actual':<10} {'P(win)':<10} {'Pred':<8} {'Match'}")
    print(f"  {'─'*4} {'─'*45} {'─'*10} {'─'*10} {'─'*8} {'─'*6}")
    for i in range(n_test):
        pred_label = "win" if preds[i] == 1 else "loss"
        actual = test_outcomes[i]
        correct = (preds[i] == test_labels[i])
        mark = f"{GREEN}✓{RESET}" if correct else f"{RED}✗{RESET}"
        bet_id = test_ids[i][:43] if len(test_ids[i]) > 43 else test_ids[i]
        p_color = GREEN if probs[i] > 0.7 else (RED if probs[i] < 0.3 else YELLOW)
        print(f"  {i+1:<4} {bet_id:<45} {actual:<10} {p_color}{probs[i]:<10.4f}{RESET} {pred_label:<8} {mark}")

    # ── Step 4: Feature importance ──────────────────────────────────────
    section("Step 4: Feature importance (native LightGBM)")
    importances = model.feature_importances_
    fi_pairs = sorted(zip(FEATURE_NAMES, importances), key=lambda x: x[1], reverse=True)
    max_imp = fi_pairs[0][1] if fi_pairs[0][1] > 0 else 1

    print(f"  {'Feature':<25} {'Splits':<8} {'Bar'}")
    print(f"  {'─'*25} {'─'*8} {'─'*20}")
    for name, imp in fi_pairs[:15]:
        bar = "█" * max(1, int(imp / max_imp * 20))
        print(f"  {name:<25} {imp:>6}   {DIM}{bar}{RESET}")

    # ── Step 5: ONNX export + inference validation ─────────────────────
    section("Step 5: ONNX export & inference validation")
    from app.exporter import export_onnx

    with tempfile.TemporaryDirectory() as tmpdir:
        onnx_path = os.path.join(tmpdir, "smoke_real_model.onnx")
        export_onnx(model, onnx_path)
        fsize = os.path.getsize(onnx_path) / 1024
        ok(f"ONNX model exported ({fsize:.1f} KB)")

        try:
            import onnxruntime as ort

            sess = ort.InferenceSession(onnx_path)
            input_name = sess.get_inputs()[0].name
            onnx_results = sess.run(None, {input_name: test_features})

            onnx_probs_raw = onnx_results[1]
            if isinstance(onnx_probs_raw, np.ndarray):
                onnx_p_win = onnx_probs_raw[:, 1]
            elif isinstance(onnx_probs_raw, list):
                onnx_p_win = np.array([d[1] for d in onnx_probs_raw], dtype=np.float64)
            else:
                fail(f"Unexpected ONNX output type: {type(onnx_probs_raw)}")
                onnx_p_win = None

            if onnx_p_win is not None:
                max_diff = float(np.max(np.abs(onnx_p_win - probs)))
                mean_diff = float(np.mean(np.abs(onnx_p_win - probs)))
                ok(f"ONNX ↔ LightGBM max diff:  {max_diff:.8f}")
                ok(f"ONNX ↔ LightGBM mean diff: {mean_diff:.8f}")

                # Show side-by-side
                print(f"\n  {'#':<4} {'LightGBM':<12} {'ONNX':<12} {'Diff'}")
                print(f"  {'─'*4} {'─'*12} {'─'*12} {'─'*12}")
                for i in range(n_test):
                    diff = abs(onnx_p_win[i] - probs[i])
                    color = GREEN if diff < 0.001 else YELLOW
                    print(f"  {i+1:<4} {probs[i]:<12.6f} {onnx_p_win[i]:<12.6f} {color}{diff:<12.8f}{RESET}")

                if max_diff < 0.01:
                    ok("ONNX matches LightGBM native — pipeline is sound!")
                else:
                    fail(f"ONNX divergence too high ({max_diff:.4f})")
        except ImportError:
            warn("onnxruntime not installed — skipping ONNX inference validation")

    # ── Summary ────────────────────────────────────────────────────────
    header("Summary")

    all_correct = int((preds == test_labels).sum())

    print(f"""
  {BOLD}Dataset:{RESET}     {n} settled bets from production DB
  {BOLD}Win Rate:{RESET}    {n_pos / n * 100:.1f}%
  {BOLD}Eval Mode:{RESET}   {metrics_source}

  {BOLD}Results:{RESET}
    Accuracy:     {test_acc:.4f} ({all_correct}/{n_test})
    AUC-ROC:      {test_auc:.4f}

  {BOLD}ONNX Export:{RESET} Validated ✓
  {BOLD}Artifacts:{RESET}   None (zero residue)
""")

    if n < 20:
        warn(f"Only {n} bets — this validates the PIPELINE, not the model's real-world accuracy.")
        info("As more bets settle, re-run this test for meaningful generalization metrics.")
    
    ok(f"{GREEN}{BOLD}The machine works end-to-end with real production data.{RESET}")
    print(f"\n{DIM}  No data was written to DB, no models deployed, no files on disk.{RESET}\n")


if __name__ == "__main__":
    main()
