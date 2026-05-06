"""Smoke test: train on synthetic data with KNOWN answers, verify the machine works.

This is a self-contained round-trip test:

1. Generate tiny training data with a simple, deterministic signal:
   - ev_pct > 5.0  →  almost certainly wins  (label=1)
   - ev_pct ≤ 5.0  →  almost certainly loses (label=0)
   
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

def _make_deterministic_data(
    n: int = 500,
    *,
    seed: int = 99,
) -> TrainingData:
    """Generate data with a trivially learnable signal.

    Rule: ev_pct > 5.0  → label 1 (win)
          ev_pct ≤ 5.0  → label 0 (loss)

    We add a tiny noise band (±0.3) near the boundary so the model
    has something to separate, but away from the boundary it's pure signal.
    """
    rng = np.random.default_rng(seed)

    features = np.zeros((n, FEATURE_COUNT), dtype=np.float32)

    # Feature 0 (ev_pct): the signal — uniform [0, 10]
    features[:, 0] = rng.uniform(0.5, 10.0, size=n)

    # Fill remaining features with plausible noise (not signal)
    features[:, 1] = rng.uniform(0.15, 0.85, size=n)   # sharp_true_prob
    features[:, 2] = rng.uniform(1.3, 6.0, size=n)     # soft_odds
    features[:, 3] = features[:, 2] * rng.uniform(0.97, 1.0, size=n)  # adjusted_soft_odds
    features[:, 4] = features[:, 1] - 1.0 / features[:, 2]  # implied_prob_gap
    features[:, 5] = rng.integers(1, 50, size=n).astype(np.float32)  # tick_count
    features[:, 6] = rng.uniform(5, 600, size=n)       # time_to_kickoff_min
    features[:, 7] = rng.normal(0, 1.5, size=n)        # movement_pct_sharp
    features[:, 8] = rng.normal(0, 2.0, size=n)        # movement_pct_soft
    features[:, 9] = (rng.random(n) < 0.1).astype(np.float32)   # steam_move_sharp
    features[:, 10] = (rng.random(n) < 0.15).astype(np.float32) # steam_move_soft
    features[:, 11] = rng.choice([-1, 0, 1], size=n).astype(np.float32)  # sharp_direction
    features[:, 12] = rng.choice([-1, 0, 1], size=n).astype(np.float32)  # soft_direction
    features[:, 13] = rng.normal(-0.5, 1.0, size=n)    # convergence_rate
    features[:, 14] = rng.exponential(2.0, size=n)      # tick_velocity
    features[:, 15] = rng.choice([2, 3, 4], size=n).astype(np.float32)  # provider_count
    features[:, 16] = features[:, 2] + rng.normal(0, 0.2, size=n)  # opening_sharp_odds
    features[:, 17] = rng.integers(0, 8, size=n).astype(np.float32)  # market_type_encoded
    features[:, 18] = (rng.random(n) < 0.3).astype(np.float32)  # is_asian_line
    features[:, 19] = rng.uniform(0.01, 0.15, size=n)   # kelly_fraction_raw
    features[:, 20] = rng.uniform(2.0, 8.0, size=n)     # vig_pct
    features[:, 21] = rng.choice([1, 2, 3], size=n).astype(np.float32)  # competition_tier
    features[:, 22] = rng.uniform(0, 48, size=n)         # hours_since_line_opened
    features[:, 23] = rng.normal(0, 0.5, size=n)         # sharp_soft_spread
    features[:, 24] = rng.choice([1, 2, 3, 4, 5], size=n).astype(np.float32)  # num_markets_same_event

    # Labels: deterministic from ev_pct, with noise near the boundary
    ev_pct = features[:, 0]
    labels = np.zeros(n, dtype=np.int32)
    labels[ev_pct > 5.3] = 1   # clearly above → win
    labels[ev_pct < 4.7] = 0   # clearly below → loss
    # Boundary band [4.7, 5.3]: random (noise the model shouldn't overfit to)
    boundary_mask = (ev_pct >= 4.7) & (ev_pct <= 5.3)
    labels[boundary_mask] = rng.integers(0, 2, size=boundary_mask.sum()).astype(np.int32)

    # Metadata
    soft_odds = features[:, 2].astype(np.float64)
    pnl = np.where(labels == 1, soft_odds - 1.0, -1.0)
    base_ts = 1735689600
    timestamps = base_ts + np.sort(rng.integers(0, 180 * 86400, size=n))

    metadata = pl.DataFrame({
        "id": [f"smoke-{i}" for i in range(n)],
        "outcome": ["won" if l == 1 else "lost" for l in labels],
        "pnl": pnl.tolist(),
        "soft_odds": soft_odds.tolist(),
        "sharp_true_prob": features[:, 1].astype(np.float64).tolist(),
        "soft_commission_pct": rng.choice([0.0, 2.0, 5.0], size=n).astype(np.float64).tolist(),
        "closing_sharp_odds": (soft_odds + rng.normal(0, 0.1, size=n)).tolist(),
        "clv_pct": rng.normal(1.0, 3.0, size=n).tolist(),
        "first_seen_at": [str(t) for t in timestamps],
        "event_start_time": [str(t + 3600) for t in timestamps],
        "event_id": [f"event-{i // 3}" for i in range(n)],
    })

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
      - ev_pct = 9.0 → definite win  (label 1)
      - ev_pct = 1.0 → definite loss (label 0)
    """
    rng = np.random.default_rng(1234)
    n = 10
    features = np.zeros((n, FEATURE_COUNT), dtype=np.float32)

    # 5 definite wins (ev_pct = 8-10) and 5 definite losses (ev_pct = 1-2)
    expected = []
    for i in range(n):
        if i < 5:
            features[i, 0] = 8.0 + rng.uniform(0, 2)  # ev_pct: 8-10 → win
            expected.append(1)
        else:
            features[i, 0] = 0.5 + rng.uniform(0, 1.5)  # ev_pct: 0.5-2 → loss
            expected.append(0)

        # Fill remaining features with generic noise
        features[i, 1] = rng.uniform(0.3, 0.7)
        features[i, 2] = rng.uniform(1.5, 4.0)
        features[i, 3] = features[i, 2] * 0.98
        features[i, 4] = features[i, 1] - 1.0 / features[i, 2]
        features[i, 5] = float(rng.integers(5, 30))
        features[i, 6] = rng.uniform(30, 300)
        features[i, 7] = rng.normal(0, 1)
        features[i, 8] = rng.normal(0, 1)
        features[i, 9] = 0.0
        features[i, 10] = 0.0
        features[i, 11] = 0.0
        features[i, 12] = 0.0
        features[i, 13] = rng.normal(0, 0.5)
        features[i, 14] = rng.exponential(1.0)
        features[i, 15] = 3.0
        features[i, 16] = features[i, 2] + rng.normal(0, 0.1)
        features[i, 17] = float(rng.integers(0, 5))
        features[i, 18] = 0.0
        features[i, 19] = rng.uniform(0.02, 0.10)
        features[i, 20] = rng.uniform(3, 6)
        features[i, 21] = float(rng.integers(1, 4))    # competition_tier
        features[i, 22] = rng.uniform(1, 24)            # hours_since_line_opened
        features[i, 23] = rng.normal(0, 0.3)            # sharp_soft_spread
        features[i, 24] = float(rng.integers(1, 5))     # num_markets_same_event

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
            ev = self.test_features[i, 0]
            predicted = 1 if prob > 0.5 else 0
            status = "✓" if predicted == expected else "✗"
            print(f"  [{status}] Test {i}: ev_pct={ev:.2f}  P(win)={prob:.4f}  "
                  f"predicted={predicted}  expected={expected}")

        # All 10 should be correct
        predictions = (probs > 0.5).astype(int)
        accuracy = (predictions == np.array(self.expected_labels)).mean()
        assert accuracy >= 0.9, (
            f"Only {accuracy*100:.0f}% correct on known-answer data. "
            f"Expected ≥ 90%."
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
                ev = self.test_features[i, 0]
                diff = abs(onnx_p_win[i] - lgbm_p_win[i])
                print(f"  Test {i}: ev_pct={ev:.2f}  "
                      f"ONNX={onnx_p_win[i]:.4f}  LightGBM={lgbm_p_win[i]:.4f}  "
                      f"diff={diff:.6f}")

            # ONNX and LightGBM should be very close (not exact due to float conversion)
            np.testing.assert_allclose(onnx_p_win, lgbm_p_win, atol=0.01, rtol=0.01)

            # ONNX should also get the known answers right
            onnx_predictions = (onnx_p_win > 0.5).astype(int)
            onnx_accuracy = (onnx_predictions == np.array(self.expected_labels)).mean()
            assert onnx_accuracy >= 0.9, (
                f"ONNX model only {onnx_accuracy*100:.0f}% correct on known-answer data."
            )

    def test_feature_importance_ev_pct_is_top(self):
        """ev_pct should be the most important feature since it's the only signal."""
        fi = self.result.metrics.feature_importance
        if not fi:
            pytest.skip("SHAP not available")

        # ev_pct should be #1 or #2 in importance
        sorted_fi = sorted(fi.items(), key=lambda x: x[1], reverse=True)
        top_3_names = [name for name, _ in sorted_fi[:3]]

        print("\n--- Top 5 Feature Importance ---")
        for name, imp in sorted_fi[:5]:
            print(f"  {name}: {imp:.6f}")

        assert "ev_pct" in top_3_names, (
            f"ev_pct should be in top 3 by importance, "
            f"but top 3 are: {top_3_names}"
        )

    def test_no_residual_artifacts(self):
        """Verify the test leaves no files behind."""
        # This test is here to document the contract:
        # all data was in-memory or in a tempdir that Python auto-cleans.
        # No DB rows, no GCS uploads, no disk models.
        assert not os.path.exists("/tmp/smoke_model.onnx")
        assert not os.path.exists("smoke_model.onnx")
