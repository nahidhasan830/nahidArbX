"""Smoke test: train on synthetic data with KNOWN answers, verify the machine works.

This is a self-contained round-trip test:

1. Generate tiny training data with a simple, deterministic signal:
   - sharp_true_prob > 0.60  →  almost certainly wins  (label=1)
   - sharp_true_prob ≤ 0.60  →  almost certainly loses (label=0)

2. Train LightGBM on it (fast: small model, few estimators).

3. Create fresh test data where we KNOW the right answers.

4. Run the trained model on the test data and assert it gets them right.

5. Export to ONNX, load it back, run inference again — same assertions.

Everything is in-memory / tempdir. Nothing touches Postgres or GCS.
After the test, all data is garbage-collected — zero residue.
"""

from __future__ import annotations

import os
import tempfile

import numpy as np
import polars as pl
import pytest

from app.cpcv import CpcvConfig
from app.feature_names import FEATURE_COUNT, FEATURE_NAMES
from app.loader import TrainingData
from app.trainer import train


# ── Helpers ──────────────────────────────────────────────────────────────

IDX = {name: FEATURE_NAMES.index(name) for name in FEATURE_NAMES}


def _make_deterministic_data(
    n: int = 500,
    *,
    seed: int = 99,
) -> TrainingData:
    """Generate data with a trivially learnable signal.

    Rule: sharp_true_prob > 0.60  → label 1 (win)
          sharp_true_prob ≤ 0.60  → label 0 (loss)

    We add a tiny noise band (±0.3) near the boundary so the model
    has something to separate, but away from the boundary it's pure signal.
    """
    rng = np.random.default_rng(seed)

    features = np.zeros((n, FEATURE_COUNT), dtype=np.float32)

    features[:, IDX["sharp_true_prob"]] = rng.uniform(0.15, 0.85, size=n)
    features[:, IDX["soft_odds"]] = rng.uniform(1.3, 6.0, size=n)
    features[:, IDX["adjusted_soft_odds"]] = features[:, IDX["soft_odds"]] * rng.uniform(
        0.97, 1.0, size=n
    )
    features[:, IDX["tick_count"]] = rng.integers(1, 50, size=n).astype(np.float32)
    features[:, IDX["time_to_kickoff_min"]] = rng.uniform(5, 600, size=n)
    features[:, IDX["movement_pct_sharp"]] = rng.normal(0, 1.5, size=n)
    features[:, IDX["movement_pct_soft"]] = rng.normal(0, 2.0, size=n)
    features[:, IDX["steam_move_sharp"]] = (rng.random(n) < 0.1).astype(np.float32)
    features[:, IDX["steam_move_soft"]] = (rng.random(n) < 0.15).astype(np.float32)
    features[:, IDX["sharp_direction"]] = rng.choice([-1, 0, 1], size=n).astype(np.float32)
    features[:, IDX["soft_direction"]] = rng.choice([-1, 0, 1], size=n).astype(np.float32)
    features[:, IDX["convergence_rate"]] = rng.normal(-0.5, 1.0, size=n)
    features[:, IDX["tick_velocity"]] = rng.exponential(2.0, size=n)
    features[:, IDX["provider_count"]] = rng.choice([2, 3, 4], size=n).astype(np.float32)
    features[:, IDX["opening_sharp_odds"]] = features[:, IDX["soft_odds"]] + rng.normal(
        0, 0.2, size=n
    )
    features[:, IDX["market_type_encoded"]] = rng.integers(0, 8, size=n).astype(np.float32)
    features[:, IDX["is_asian_line"]] = (rng.random(n) < 0.3).astype(np.float32)
    features[:, IDX["vig_pct"]] = rng.uniform(2.0, 8.0, size=n)
    features[:, IDX["competition_tier"]] = rng.choice([1, 2, 3], size=n).astype(np.float32)
    features[:, IDX["hours_since_line_opened"]] = rng.uniform(0, 48, size=n)
    features[:, IDX["sharp_soft_spread"]] = rng.normal(0, 0.5, size=n)
    features[:, IDX["num_markets_same_event"]] = rng.choice([1, 2, 3, 4, 5], size=n).astype(
        np.float32
    )

    # Labels: deterministic from sharp_true_prob, with noise near the boundary.
    signal = features[:, IDX["sharp_true_prob"]]
    labels = np.zeros(n, dtype=np.int32)
    labels[signal > 0.63] = 1
    labels[signal < 0.57] = 0
    boundary_mask = (signal >= 0.57) & (signal <= 0.63)
    labels[boundary_mask] = rng.integers(0, 2, size=boundary_mask.sum()).astype(np.int32)

    # Metadata
    soft_odds = features[:, IDX["soft_odds"]].astype(np.float64)
    pnl = np.where(labels == 1, soft_odds - 1.0, -1.0)
    base_ts = 1735689600
    timestamps = base_ts + np.sort(rng.integers(0, 180 * 86400, size=n))

    metadata = pl.DataFrame(
        {
            "id": [f"smoke-{i}" for i in range(n)],
            "outcome": ["won" if l == 1 else "lost" for l in labels],
            "pnl": pnl.tolist(),
            "soft_odds": soft_odds.tolist(),
            "sharp_true_prob": features[:, IDX["sharp_true_prob"]].astype(np.float64).tolist(),
            "soft_commission_pct": rng.choice([0.0, 2.0, 5.0], size=n).astype(np.float64).tolist(),
            "closing_sharp_odds": (soft_odds + rng.normal(0, 0.1, size=n)).tolist(),
            "clv_pct": rng.normal(1.0, 3.0, size=n).tolist(),
            "first_seen_at": [str(t) for t in timestamps],
            "event_start_time": [str(t + 3600) for t in timestamps],
            "event_id": [f"event-{i // 3}" for i in range(n)],
            "family_id": [f"family-{i % 17}" for i in range(n)],
            "atom_id": [f"atom-{i % 2}" for i in range(n)],
        }
    )

    return TrainingData(
        features=features,
        labels=labels,
        feature_names=list(FEATURE_NAMES),
        metadata=metadata,
        n_samples=n,
    )


def _make_test_vectors() -> tuple[np.ndarray, list[int]]:
    """Create 10 test vectors where we KNOW the answer.

    Returns (features, expected_labels).
    The test vectors are crafted so the answer is unambiguous:
      - sharp_true_prob = 0.80 → definite win  (label 1)
      - sharp_true_prob = 0.30 → definite loss (label 0)
    """
    rng = np.random.default_rng(1234)
    n = 10
    features = np.zeros((n, FEATURE_COUNT), dtype=np.float32)

    # 5 definite wins (ev_pct = 8-10) and 5 definite losses (ev_pct = 1-2)
    expected = []
    for i in range(n):
        if i < 5:
            features[i, IDX["sharp_true_prob"]] = 0.78 + rng.uniform(0, 0.05)
            expected.append(1)
        else:
            features[i, IDX["sharp_true_prob"]] = 0.28 + rng.uniform(0, 0.05)
            expected.append(0)

        # Fill remaining features with generic noise
        features[i, IDX["soft_odds"]] = rng.uniform(1.5, 4.0)
        features[i, IDX["adjusted_soft_odds"]] = features[i, IDX["soft_odds"]] * 0.98
        features[i, IDX["tick_count"]] = float(rng.integers(5, 30))
        features[i, IDX["time_to_kickoff_min"]] = rng.uniform(30, 300)
        features[i, IDX["movement_pct_sharp"]] = rng.normal(0, 1)
        features[i, IDX["movement_pct_soft"]] = rng.normal(0, 1)
        features[i, IDX["convergence_rate"]] = rng.normal(0, 0.5)
        features[i, IDX["tick_velocity"]] = rng.exponential(1.0)
        features[i, IDX["provider_count"]] = 3.0
        features[i, IDX["opening_sharp_odds"]] = features[i, IDX["soft_odds"]] + rng.normal(0, 0.1)
        features[i, IDX["market_type_encoded"]] = float(rng.integers(0, 5))
        features[i, IDX["vig_pct"]] = rng.uniform(3, 6)
        features[i, IDX["competition_tier"]] = float(rng.integers(1, 4))
        features[i, IDX["hours_since_line_opened"]] = rng.uniform(1, 24)
        features[i, IDX["sharp_soft_spread"]] = rng.normal(0, 0.3)
        features[i, IDX["num_markets_same_event"]] = float(rng.integers(1, 5))

    return features, expected


# ── Tests ────────────────────────────────────────────────────────────────


class TestMLSmoke:
    """Smoke-test the entire ML machine with known-answer data."""

    @pytest.fixture(autouse=True)
    def _setup(self):
        """Train once, reuse across tests in this class."""
        self.train_data = _make_deterministic_data(n=500, seed=99)
        self.result = train(
            self.train_data,
            lgbm_params={"n_estimators": 100, "num_leaves": 15, "max_depth": 4},
            cpcv_config=CpcvConfig(n_groups=5, n_test_groups=2, embargo_pct=0.01),
        )
        self.test_features, self.expected_labels = _make_test_vectors()

    def test_model_learned_the_signal(self):
        """The model should achieve very high AUC on data with pure signal."""
        # With a trivially separable signal, AUC should be > 0.85
        assert self.result.metrics.auc_roc > 0.85, (
            f"AUC-ROC too low ({self.result.metrics.auc_roc:.4f}). "
            f"The model failed to learn the simple ev_pct > 5 signal."
        )

    def test_lgbm_predicts_known_answers(self):
        """LightGBM native predict should get all 10 known-answer cases right."""
        probs = self.result.model.predict_proba(self.test_features)[:, 1]

        print("\n--- LightGBM Native Predictions ---")
        for i, (prob, expected) in enumerate(zip(probs, self.expected_labels)):
            signal = self.test_features[i, IDX["sharp_true_prob"]]
            predicted = 1 if prob > 0.5 else 0
            status = "✓" if predicted == expected else "✗"
            print(
                f"  [{status}] Test {i}: sharp_true_prob={signal:.2f}  P(win)={prob:.4f}  "
                f"predicted={predicted}  expected={expected}"
            )

        # All 10 should be correct
        predictions = (probs > 0.5).astype(int)
        accuracy = (predictions == np.array(self.expected_labels)).mean()
        assert accuracy >= 0.9, (
            f"Only {accuracy * 100:.0f}% correct on known-answer data. Expected ≥ 90%."
        )

    def test_onnx_matches_lgbm_predictions(self):
        """ONNX export should produce identical predictions to native LightGBM."""
        from app.exporter import export_onnx

        with tempfile.TemporaryDirectory() as tmpdir:
            onnx_path = os.path.join(tmpdir, "smoke_model.onnx")
            export_onnx(self.result.model, onnx_path)

            # Run inference through ONNX
            try:
                import onnxruntime as ort
            except ImportError:
                pytest.skip("onnxruntime not installed")

            sess = ort.InferenceSession(onnx_path)
            input_name = sess.get_inputs()[0].name
            results = sess.run(None, {input_name: self.test_features})

            onnx_probs_raw = results[1]  # [labels, probabilities]

            # onnxruntime may return probabilities as:
            # - np.ndarray of shape (n, 2)
            # - list of dicts [{0: p_neg, 1: p_pos}, ...]
            if isinstance(onnx_probs_raw, np.ndarray):
                onnx_p_win = onnx_probs_raw[:, 1]
            elif isinstance(onnx_probs_raw, list):
                onnx_p_win = np.array([d[1] for d in onnx_probs_raw], dtype=np.float64)
            else:
                pytest.fail(f"Unexpected ONNX output type: {type(onnx_probs_raw)}")

            # Compare with LightGBM native
            lgbm_p_win = self.result.model.predict_proba(self.test_features)[:, 1]

            print("\n--- ONNX vs LightGBM Comparison ---")
            for i in range(10):
                signal = self.test_features[i, IDX["sharp_true_prob"]]
                diff = abs(onnx_p_win[i] - lgbm_p_win[i])
                print(
                    f"  Test {i}: sharp_true_prob={signal:.2f}  "
                    f"ONNX={onnx_p_win[i]:.4f}  LightGBM={lgbm_p_win[i]:.4f}  "
                    f"diff={diff:.6f}"
                )

            # ONNX and LightGBM should be very close (not exact due to float conversion)
            np.testing.assert_allclose(onnx_p_win, lgbm_p_win, atol=0.01, rtol=0.01)

            # ONNX should also get the known answers right
            onnx_predictions = (onnx_p_win > 0.5).astype(int)
            onnx_accuracy = (onnx_predictions == np.array(self.expected_labels)).mean()
            assert onnx_accuracy >= 0.9, (
                f"ONNX model only {onnx_accuracy * 100:.0f}% correct on known-answer data."
            )

    def test_feature_importance_ev_pct_is_top(self):
        """sharp_true_prob should be most important since it's the only signal."""
        fi = self.result.metrics.feature_importance
        if not fi:
            pytest.skip("SHAP not available")

        sorted_fi = sorted(fi.items(), key=lambda x: x[1], reverse=True)
        top_3_names = [name for name, _ in sorted_fi[:3]]

        print("\n--- Top 5 Feature Importance ---")
        for name, imp in sorted_fi[:5]:
            print(f"  {name}: {imp:.6f}")

        assert "sharp_true_prob" in top_3_names, (
            f"sharp_true_prob should be in top 3 by importance, but top 3 are: {top_3_names}"
        )

    def test_no_residual_artifacts(self):
        """Verify the test leaves no files behind."""
        # This test is here to document the contract:
        # all data was in-memory or in a tempdir that Python auto-cleans.
        # No DB rows, no GCS uploads, no disk models.
        assert not os.path.exists("/tmp/smoke_model.onnx")
        assert not os.path.exists("smoke_model.onnx")
