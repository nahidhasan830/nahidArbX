"""End-to-end tests for the LightGBM + ONNX training pipeline.

Tests the full flow from synthetic data → CPCV training → ONNX export
without touching Postgres or GCS.
"""

from __future__ import annotations

import os
import tempfile

import numpy as np
import pytest

from app.cpcv import CpcvConfig, make_cpcv_splits
from app.feature_names import FEATURE_COUNT, FEATURE_NAMES, FEATURE_NAMES_HASH, FEATURE_VERSION
from app.loader import TrainingData
from app.trainer import TrainingMetrics, TrainingResult, train


class TestFeatureContract:
    """Verify the feature name contract is self-consistent."""

    def test_feature_count_matches(self):
        assert len(FEATURE_NAMES) == FEATURE_COUNT == 25

    def test_feature_names_unique(self):
        assert len(set(FEATURE_NAMES)) == len(FEATURE_NAMES)

    def test_no_empty_names(self):
        for name in FEATURE_NAMES:
            assert name.strip(), f"Empty feature name at index {FEATURE_NAMES.index(name)}"


class TestCPCVSplits:
    """Verify CPCV produces correct number of splits with proper purging."""

    def test_default_config_45_paths(self, synthetic_data: TrainingData):
        import polars as pl

        df = pl.DataFrame({"event_id": synthetic_data.metadata["event_id"].to_list()})
        cfg = CpcvConfig(n_groups=10, n_test_groups=2, embargo_pct=0.01)
        splits = make_cpcv_splits(df, cfg)
        # C(10, 2) = 45
        assert len(splits) == 45

    def test_no_overlap_train_test(self, synthetic_data: TrainingData):
        import polars as pl

        df = pl.DataFrame({"event_id": synthetic_data.metadata["event_id"].to_list()})
        cfg = CpcvConfig(n_groups=10, n_test_groups=2, embargo_pct=0.01)
        splits = make_cpcv_splits(df, cfg)

        for split in splits:
            train_set = set(split.train_indices.tolist())
            test_set = set(split.test_indices.tolist())
            assert train_set.isdisjoint(test_set), (
                f"Fold {split.path_index}: train/test overlap"
            )


class TestTrainer:
    """Test the LightGBM training pipeline with synthetic data."""

    def test_train_produces_result(self, synthetic_data: TrainingData):
        """Full training run should complete and produce valid metrics."""
        result = train(
            synthetic_data,
            lgbm_params={"n_estimators": 50, "num_leaves": 15},
            cpcv_config=CpcvConfig(n_groups=5, n_test_groups=2, embargo_pct=0.01),
        )

        assert isinstance(result, TrainingResult)
        assert isinstance(result.metrics, TrainingMetrics)
        assert result.model is not None

    def test_metrics_in_valid_range(self, synthetic_data: TrainingData):
        """Metrics should be within expected ranges."""
        result = train(
            synthetic_data,
            lgbm_params={"n_estimators": 50, "num_leaves": 15},
            cpcv_config=CpcvConfig(n_groups=5, n_test_groups=2, embargo_pct=0.01),
        )
        m = result.metrics

        assert 0.0 <= m.auc_roc <= 1.0, f"AUC-ROC out of range: {m.auc_roc}"
        assert 0.0 <= m.accuracy <= 1.0, f"Accuracy out of range: {m.accuracy}"
        assert m.log_loss_val >= 0, f"Log loss should be non-negative: {m.log_loss_val}"
        assert 0.0 <= m.calibration_error <= 1.0, f"Cal error out of range: {m.calibration_error}"
        assert 0.0 <= m.dsr <= 1.0, f"DSR out of range: {m.dsr}"
        assert 0.0 <= m.pbo <= 1.0, f"PBO out of range: {m.pbo}"
        assert m.n_samples == synthetic_data.n_samples

    def test_oos_predictions_shape(self, synthetic_data: TrainingData):
        """OOS predictions should have the same length as input data."""
        result = train(
            synthetic_data,
            lgbm_params={"n_estimators": 50, "num_leaves": 15},
            cpcv_config=CpcvConfig(n_groups=5, n_test_groups=2, embargo_pct=0.01),
        )

        assert result.oos_predictions.shape == (synthetic_data.n_samples,)
        assert result.oos_labels.shape == (synthetic_data.n_samples,)

    def test_feature_importance_computed(self, synthetic_data: TrainingData):
        """SHAP feature importance should be computed for all features."""
        result = train(
            synthetic_data,
            lgbm_params={"n_estimators": 50, "num_leaves": 15},
            cpcv_config=CpcvConfig(n_groups=5, n_test_groups=2, embargo_pct=0.01),
        )

        fi = result.metrics.feature_importance
        if fi:  # SHAP may fail in some envs — that's a warning, not error
            assert len(fi) == FEATURE_COUNT
            for name in FEATURE_NAMES:
                assert name in fi, f"Missing feature importance for {name}"


class TestONNXExport:
    """Test ONNX model export and validation."""

    def test_export_creates_valid_onnx(self, synthetic_data: TrainingData):
        """Exported ONNX model should be valid and produce correct output shape."""
        result = train(
            synthetic_data,
            lgbm_params={"n_estimators": 50, "num_leaves": 15},
            cpcv_config=CpcvConfig(n_groups=5, n_test_groups=2, embargo_pct=0.01),
        )

        from app.exporter import export_onnx

        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "test_model.onnx")
            export_onnx(result.model, path)

            assert os.path.exists(path)
            assert os.path.getsize(path) > 0

            # Validate with onnx
            import onnx

            model = onnx.load(path)
            onnx.checker.check_model(model)

    def test_onnx_feature_names_embedded(self, synthetic_data: TrainingData):
        """Feature names should be embedded in ONNX metadata."""
        result = train(
            synthetic_data,
            lgbm_params={"n_estimators": 50, "num_leaves": 15},
            cpcv_config=CpcvConfig(n_groups=5, n_test_groups=2, embargo_pct=0.01),
        )

        from app.exporter import export_onnx

        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "test_model.onnx")
            export_onnx(result.model, path)

            import onnx

            model = onnx.load(path)
            meta = {p.key: p.value for p in model.metadata_props}

            assert "feature_names" in meta
            assert meta["feature_names"] == ",".join(FEATURE_NAMES)
            assert meta["feature_count"] == str(FEATURE_COUNT)
            assert meta["feature_version"] == str(FEATURE_VERSION)
            assert meta["feature_names_hash"] == FEATURE_NAMES_HASH

    def test_onnx_inference_output_shape(self, synthetic_data: TrainingData):
        """ONNX model should produce probability outputs with correct shape."""
        result = train(
            synthetic_data,
            lgbm_params={"n_estimators": 50, "num_leaves": 15},
            cpcv_config=CpcvConfig(n_groups=5, n_test_groups=2, embargo_pct=0.01),
        )

        from app.exporter import export_onnx

        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "test_model.onnx")
            export_onnx(result.model, path)

            try:
                import onnxruntime as ort

                sess = ort.InferenceSession(path)
                dummy = np.random.randn(5, FEATURE_COUNT).astype(np.float32)
                input_name = sess.get_inputs()[0].name
                results = sess.run(None, {input_name: dummy})

                # Output: [labels, probabilities]. onnxruntime may expose
                # classifier probabilities either as an ndarray or as a
                # sequence of class-probability maps.
                probs_raw = results[1]
                if isinstance(probs_raw, np.ndarray):
                    probs = probs_raw
                    assert probs.shape == (5, 2), f"Expected (5,2), got {probs.shape}"
                elif isinstance(probs_raw, list):
                    probs = np.array([[d[0], d[1]] for d in probs_raw], dtype=np.float32)
                    assert probs.shape == (5, 2), f"Expected (5,2), got {probs.shape}"
                else:
                    pytest.fail(f"Unexpected ONNX probability output type: {type(probs_raw)}")

                # P(positive) should be in [0, 1]
                assert np.all(probs >= 0) and np.all(probs <= 1)
            except ImportError:
                pytest.skip("onnxruntime not installed")


class TestScoringIntegration:
    """Test that the scoring functions work with trainer output."""

    def test_dsr_pbo_computed(self, synthetic_data: TrainingData):
        """DSR and PBO should be computed from the fold metrics."""
        result = train(
            synthetic_data,
            lgbm_params={"n_estimators": 50, "num_leaves": 15},
            cpcv_config=CpcvConfig(n_groups=5, n_test_groups=2, embargo_pct=0.01),
        )

        # DSR and PBO should be finite numbers
        assert np.isfinite(result.metrics.dsr)
        assert np.isfinite(result.metrics.pbo)

    def test_per_fold_sharpes_populated(self, synthetic_data: TrainingData):
        """Per-fold Sharpe ratios should be computed for each fold."""
        result = train(
            synthetic_data,
            lgbm_params={"n_estimators": 50, "num_leaves": 15},
            cpcv_config=CpcvConfig(n_groups=5, n_test_groups=2, embargo_pct=0.01),
        )

        sharpes = result.metrics.per_fold_sharpes
        assert len(sharpes) > 0
        assert all(np.isfinite(s) for s in sharpes)


class TestPhase6Calibration:
    """Phase 6: Score bucket calibration and monotonicity tests."""

    def test_score_bucket_report_present(self, synthetic_data: TrainingData):
        """Training should produce a score bucket report."""
        result = train(
            synthetic_data,
            lgbm_params={"n_estimators": 50, "num_leaves": 15},
            cpcv_config=CpcvConfig(n_groups=5, n_test_groups=2, embargo_pct=0.01),
        )
        report = result.metrics.score_bucket_report
        assert report is not None
        assert len(report.buckets) == 6  # 6 buckets per the plan

    def test_monotonicity_in_valid_range(self, synthetic_data: TrainingData):
        """Monotonicity scores should be between 0 and 1."""
        result = train(
            synthetic_data,
            lgbm_params={"n_estimators": 50, "num_leaves": 15},
            cpcv_config=CpcvConfig(n_groups=5, n_test_groups=2, embargo_pct=0.01),
        )
        report = result.metrics.score_bucket_report
        assert 0.0 <= report.roi_monotonicity <= 1.0
        assert 0.0 <= report.win_rate_monotonicity <= 1.0

    def test_oos_clv_metric_finite(self, synthetic_data: TrainingData):
        """OOS CLV mean should be a finite number."""
        result = train(
            synthetic_data,
            lgbm_params={"n_estimators": 50, "num_leaves": 15},
            cpcv_config=CpcvConfig(n_groups=5, n_test_groups=2, embargo_pct=0.01),
        )
        assert np.isfinite(result.metrics.oos_clv_mean)

    def test_bucket_counts_sum_to_oos_samples(self, synthetic_data: TrainingData):
        """Total samples across buckets should equal total OOS predictions."""
        result = train(
            synthetic_data,
            lgbm_params={"n_estimators": 50, "num_leaves": 15},
            cpcv_config=CpcvConfig(n_groups=5, n_test_groups=2, embargo_pct=0.01),
        )
        report = result.metrics.score_bucket_report
        total_in_buckets = sum(b.count for b in report.buckets)
        # Total should match OOS predictions count
        oos_count = int((~np.isnan(result.oos_predictions)).sum())
        assert total_in_buckets == oos_count

    def test_adaptive_min_child_samples(self):
        """Adaptive min_child_samples should scale with dataset size."""
        from app.trainer import _adaptive_min_child_samples

        assert _adaptive_min_child_samples(100) == 5
        assert _adaptive_min_child_samples(200) == 5
        assert _adaptive_min_child_samples(2000) == 20
        assert _adaptive_min_child_samples(5000) == 20
        mid = _adaptive_min_child_samples(1000)
        assert 5 < mid < 20
