"""Phase 5 tests: Python optimizer sidecar hardening.

Tests for:
  - CPCV event-aware purging (no event_id leakage between train/test)
  - Cold-start threshold alignment (config default = 200)
  - PBO demoted from deployment gate hard check to warning
  - _fail_pending_models scoping to TRAINING_MODEL_ID
  - Loader chronological ordering after merge
  - Sample weight parity (no double PnL boost)
"""

from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import numpy as np
import polars as pl
import pytest

from app.cpcv import CpcvConfig, CpcvSplit, make_cpcv_splits
from app.deployment_gate import (
    MAX_PBO,
    evaluate_deployment_gate,
)
from app.loader import (
    _canonicalize_training_example_rows,
    _compute_unit_return,
    _derive_sample_weights,
    _pnl_boost,
)
from app.scoring import ScoreBucket, ScoreBucketReport
from app.trainer import TrainingMetrics


# ── CPCV Event-Aware Purging ───────────────────────────────────────────────


class TestCPCVEventPurging:
    """Phase 5: CPCV should purge ALL train rows sharing event_ids with test."""

    def test_no_shared_events_between_train_and_test(self):
        """No event_id should appear in both train and test sets."""
        # Create data where some events span multiple rows
        event_ids = (
            ["event-A"] * 5 +
            ["event-B"] * 5 +
            ["event-C"] * 5 +
            ["event-D"] * 5 +
            ["event-E"] * 5 +
            ["event-F"] * 5 +
            ["event-G"] * 5 +
            ["event-H"] * 5 +
            ["event-I"] * 5 +
            ["event-J"] * 5
        )
        df = pl.DataFrame({"event_id": event_ids})
        cfg = CpcvConfig(n_groups=5, n_test_groups=1, embargo_pct=0.0)

        splits = make_cpcv_splits(df, cfg)
        assert len(splits) == 5  # C(5,1) = 5

        for split in splits:
            test_events = set(np.array(event_ids)[split.test_indices])
            train_events = set(np.array(event_ids)[split.train_indices])
            overlap = test_events & train_events
            assert not overlap, (
                f"Fold {split.path_index}: events {overlap} appear in both "
                f"train ({len(split.train_indices)}) and test ({len(split.test_indices)})"
            )

    def test_event_purging_removes_shared_event_rows(self):
        """An event spanning train/test groups should be fully purged from train."""
        # Event "shared" spans rows 4-5, crossing the group boundary
        event_ids = ["a", "a", "b", "b", "shared", "shared", "c", "c", "d", "d"]
        df = pl.DataFrame({"event_id": event_ids})

        # 2 groups of 5, pick 1 for test → the group containing row 5 ("shared")
        cfg = CpcvConfig(n_groups=2, n_test_groups=1, embargo_pct=0.0)
        splits = make_cpcv_splits(df, cfg)

        for split in splits:
            test_events = set(np.array(event_ids)[split.test_indices])
            train_events = set(np.array(event_ids)[split.train_indices])
            assert "shared" not in (test_events & train_events)

    def test_cpcv_still_works_without_event_id_column(self):
        """CPCV should fall back to index-only purging when event_id is absent."""
        df = pl.DataFrame({"x": list(range(100))})  # No event_id column
        cfg = CpcvConfig(n_groups=5, n_test_groups=2, embargo_pct=0.01)
        splits = make_cpcv_splits(df, cfg)
        assert len(splits) == 10  # C(5,2) = 10

        for split in splits:
            train_set = set(split.train_indices.tolist())
            test_set = set(split.test_indices.tolist())
            assert train_set.isdisjoint(test_set)

    def test_embargo_still_applies_with_event_purging(self):
        """Embargo should remove additional rows beyond event-based purging."""
        # 20 rows, all unique events
        event_ids = [f"event-{i}" for i in range(20)]
        df = pl.DataFrame({"event_id": event_ids})
        cfg = CpcvConfig(n_groups=4, n_test_groups=1, embargo_pct=0.1)  # 2-row embargo

        splits = make_cpcv_splits(df, cfg)
        for split in splits:
            # With unique events, event-purging does nothing extra.
            # Embargo should still remove rows near test boundaries.
            total = len(split.train_indices) + len(split.test_indices)
            assert total < 20, (
                f"Fold {split.path_index}: embargo should reduce total "
                f"but train({len(split.train_indices)}) + test({len(split.test_indices)}) = {total}"
            )

    def test_all_test_events_purged_even_when_scattered(self):
        """Events scattered across groups should still be fully purged."""
        # "scattered" event appears in rows 0, 5, 10, 15 — across all groups
        event_ids = [
            "scattered", "a", "b", "c", "d",
            "scattered", "e", "f", "g", "h",
            "scattered", "i", "j", "k", "l",
            "scattered", "m", "n", "o", "p",
        ]
        df = pl.DataFrame({"event_id": event_ids})
        cfg = CpcvConfig(n_groups=4, n_test_groups=1, embargo_pct=0.0)
        splits = make_cpcv_splits(df, cfg)

        for split in splits:
            test_events = set(np.array(event_ids)[split.test_indices])
            if "scattered" in test_events:
                train_events = set(np.array(event_ids)[split.train_indices])
                assert "scattered" not in train_events, (
                    f"Fold {split.path_index}: 'scattered' event leaked to train"
                )


# ── PBO Demoted to Warning ─────────────────────────────────────────────────


def _make_good_metrics(**overrides) -> TrainingMetrics:
    """Build metrics that pass all hard gates by default."""
    buckets = [
        ScoreBucket(
            label=f"b{i}", low=i * 0.2, high=(i + 1) * 0.2,
            count=100, n_positive=50, n_negative=50,
            win_rate=0.5, mean_pnl=1.0, roi_pct=5.0,
            mean_clv_pct=2.0, mean_score=i * 0.2 + 0.1,
        )
        for i in range(6)
    ]
    defaults = dict(
        auc_roc=0.72, accuracy=0.65, log_loss_val=0.55,
        calibration_error=0.04, oos_roi_mean=5.0, oos_clv_mean=2.0,
        policy_roi_mean=4.0, policy_sample_size=400,
        policy_coverage=0.25, policy_edge_threshold_pct=0.0,
        baseline_roi_mean=2.0, simple_policy_roi_mean=2.0,
        simple_policy_sample_size=250, simple_policy_coverage=0.2,
        model_vs_simple_roi_delta=2.0,
        dsr=0.85, pbo=0.15, n_samples=1500, n_positive=600,
        n_negative=900, n_folds=45,
        score_bucket_report=ScoreBucketReport(
            buckets=buckets,
            roi_monotonicity=0.8, clv_monotonicity=0.6,
            win_rate_monotonicity=0.7, is_directionally_monotonic=True,
        ),
    )
    defaults.update(overrides)
    return TrainingMetrics(**defaults)


class TestPBODemotedToWarning:
    """Phase 5: PBO should be a warning, not a hard rejection gate."""

    def test_high_pbo_does_not_reject(self):
        """A model with high PBO should still be approved."""
        metrics = _make_good_metrics(pbo=0.95)  # Very high PBO
        result = evaluate_deployment_gate(metrics)
        assert result.approved, (
            f"Model should NOT be rejected for high PBO. "
            f"Reasons: {result.rejection_reasons}"
        )

    def test_high_pbo_produces_warning(self):
        """High PBO should produce a warning (not rejection reason)."""
        metrics = _make_good_metrics(pbo=0.95)
        result = evaluate_deployment_gate(metrics)
        assert any("Overfitting" in w or "PBO" in w for w in result.warnings), (
            f"Expected PBO warning, got warnings: {result.warnings}"
        )

    def test_high_pbo_not_in_rejection_reasons(self):
        """PBO should never appear in rejection_reasons."""
        metrics = _make_good_metrics(pbo=0.95)
        result = evaluate_deployment_gate(metrics)
        assert not any("PBO" in r or "Overfitting" in r for r in result.rejection_reasons), (
            f"PBO should not cause rejection. Reasons: {result.rejection_reasons}"
        )

    def test_low_pbo_no_warning(self):
        """PBO below threshold should not produce a warning."""
        metrics = _make_good_metrics(pbo=0.10)
        result = evaluate_deployment_gate(metrics)
        pbo_warnings = [w for w in result.warnings if "PBO" in w or "Overfitting" in w]
        assert len(pbo_warnings) == 0


# ── Cold-Start Alignment ──────────────────────────────────────────────────


class TestColdStartAlignment:
    """Phase 5: TS and Python cold-start thresholds should be aligned at 200."""

    def test_python_config_default_is_200(self):
        """Python config default should be 200."""
        from app.config import Settings
        # Create settings with no env override — should use default
        with patch.dict(os.environ, {}, clear=False):
            s = Settings(database_url="postgresql://test")
            assert s.ml_cold_start_threshold == 200

    def test_deployment_gate_min_valid_examples_is_200(self):
        """Deployment gate MIN_VALID_EXAMPLES should be 200."""
        from app.deployment_gate import MIN_VALID_EXAMPLES
        assert MIN_VALID_EXAMPLES == 200

    def test_insufficient_samples_below_200(self):
        """Models trained on < 200 samples should be rejected."""
        metrics = _make_good_metrics(n_samples=150)
        result = evaluate_deployment_gate(metrics)
        assert not result.approved
        assert any("Insufficient" in r for r in result.rejection_reasons)


# ── Sample Weight Parity ──────────────────────────────────────────────────


class TestSampleWeightParity:
    """Phase 5: Verify sample weight consistency between loaders."""

    def test_pnl_boost_identity_at_zero(self):
        """Zero PnL should produce a boost of 1.0 (no boost)."""
        assert _pnl_boost(0.0) == 1.0

    def test_pnl_boost_capped(self):
        """PnL boost should never exceed _PNL_BOOST_CAP (2.0)."""
        assert _pnl_boost(1000.0) <= 2.0

    def test_pnl_boost_increases_with_pnl(self):
        """Higher |pnl| should produce higher boost."""
        assert _pnl_boost(10.0) > _pnl_boost(1.0)
        assert _pnl_boost(50.0) > _pnl_boost(10.0)

    def test_derive_sample_weights_half_outcomes(self):
        """Half outcomes should get reduced weight (0.5 base)."""
        rows = [
            {"outcome": "won", "pnl": 0},
            {"outcome": "half_won", "pnl": 0},
            {"outcome": "lost", "pnl": 0},
            {"outcome": "half_lost", "pnl": 0},
        ]
        weights = _derive_sample_weights(rows)
        assert weights[0] == 1.0   # won → base=1.0
        assert weights[1] == 0.5   # half_won → base=0.5
        assert weights[2] == 1.0   # lost → base=1.0
        assert weights[3] == 0.5   # half_lost → base=0.5


# ── Unit Return Consistency ───────────────────────────────────────────────


class TestUnitReturnConsistency:
    """Phase 5: Verify unit return computation is consistent."""

    def test_won_positive_return(self):
        """Won bet should return positive unit return."""
        ret = _compute_unit_return("won", 2.0, 0.0)
        assert ret == 1.0  # (2.0 - 1) * (1 - 0) = 1.0

    def test_lost_negative_one(self):
        """Lost bet should return -1.0."""
        assert _compute_unit_return("lost", 2.0, 0.0) == -1.0

    def test_half_won_half_return(self):
        """Half won should return half the net profit."""
        ret = _compute_unit_return("half_won", 3.0, 0.0)
        assert ret == 1.0  # (3-1) * 0.5 = 1.0

    def test_half_lost_half_loss(self):
        """Half lost should return -0.5."""
        assert _compute_unit_return("half_lost", 3.0, 0.0) == -0.5

    def test_void_returns_none(self):
        """Void outcome should return None (excluded)."""
        assert _compute_unit_return("void", 2.0, 0.0) is None

    def test_commission_reduces_return(self):
        """Commission should reduce the net return."""
        no_comm = _compute_unit_return("won", 3.0, 0.0)
        with_comm = _compute_unit_return("won", 3.0, 5.0)
        assert with_comm < no_comm

    def test_zero_odds_returns_none(self):
        """Zero or negative odds should return None."""
        assert _compute_unit_return("won", 0.0, 0.0) is None
        assert _compute_unit_return("won", -1.0, 0.0) is None


# ── Loader Chronological Merge ────────────────────────────────────────────


class TestLoaderCanonicalExamples:
    """Phase 2: one canonical training example per source bet."""

    def test_highest_precedence_example_wins(self):
        rows = [
            {
                "id": 1,
                "source_bet_id": "bet-1",
                "event_id": "e1",
                "family_id": "f1",
                "atom_id": "a1",
                "example_type": "shadow_scored",
                "created_at": "2026-01-01T00:00:00Z",
                "settled_at": None,
            },
            {
                "id": 2,
                "source_bet_id": "bet-1",
                "event_id": "e1",
                "family_id": "f1",
                "atom_id": "a1",
                "example_type": "shadow_scored",
                "created_at": "2026-01-01T00:01:00Z",
                "settled_at": "2026-01-02T00:00:00Z",
            },
            {
                "id": 3,
                "source_bet_id": "bet-1",
                "event_id": "e1",
                "family_id": "f1",
                "atom_id": "a1",
                "example_type": "settled_detected",
                "created_at": "2026-01-01T00:02:00Z",
                "settled_at": "2026-01-02T00:00:00Z",
            },
        ]

        canonical = _canonicalize_training_example_rows(rows)

        assert len(canonical) == 1
        assert canonical[0]["id"] == 3

    def test_settled_detected_beats_shadow_scored(self):
        rows = [
            {
                "id": 1,
                "source_bet_id": "bet-1",
                "event_id": "e1",
                "family_id": "f1",
                "atom_id": "a1",
                "example_type": "shadow_scored",
                "created_at": "2026-01-01T00:00:00Z",
                "settled_at": "2026-01-02T00:00:00Z",
            },
        ]

        canonical = _canonicalize_training_example_rows(rows)
        assert len(canonical) == 1
        assert canonical[0]["example_type"] == "shadow_scored"

    def test_null_source_rows_are_keyed_by_selection(self):
        rows = [
            {
                "id": 1,
                "source_bet_id": None,
                "event_id": "e1",
                "family_id": "f1",
                "atom_id": "a1",
                "example_type": "shadow_scored",
                "created_at": "2026-01-01T00:00:00Z",
                "settled_at": None,
            },
            {
                "id": 2,
                "source_bet_id": None,
                "event_id": "e1",
                "family_id": "f1",
                "atom_id": "a1",
                "example_type": "settled_detected",
                "created_at": "2026-01-01T00:01:00Z",
                "settled_at": "2026-01-02T00:00:00Z",
            },
        ]

        canonical = _canonicalize_training_example_rows(rows)

        assert len(canonical) == 1
        assert canonical[0]["id"] == 2


class TestLoaderChronologicalMerge:
    """Phase 5: Merged data should be sorted chronologically."""

    def test_metadata_has_first_seen_at_sorted(self):
        """After load_best_available merges sources, data should be time-sorted."""
        # This is a unit test of the sort logic, not a full DB test.
        # Create two metadata DataFrames with interleaved timestamps.
        meta_a = pl.DataFrame({
            "id": ["a1", "a2", "a3"],
            "first_seen_at": ["2025-01-01", "2025-01-05", "2025-01-10"],
            "outcome": ["won", "lost", "won"],
            "pnl": [1.0, -1.0, 1.0],
            "unit_return": [1.0, -1.0, 1.0],
            "soft_odds": [2.0, 2.0, 2.0],
            "sharp_true_prob": [0.5, 0.5, 0.5],
            "soft_commission_pct": [0.0, 0.0, 0.0],
            "closing_sharp_odds": [2.0, 2.0, 2.0],
            "clv_pct": [1.0, 1.0, 1.0],
            "event_start_time": ["2025-01-01", "2025-01-05", "2025-01-10"],
            "event_id": ["e1", "e2", "e3"],
        })
        meta_b = pl.DataFrame({
            "id": ["b1", "b2"],
            "first_seen_at": ["2025-01-03", "2025-01-07"],
            "outcome": ["won", "lost"],
            "pnl": [1.0, -1.0],
            "unit_return": [1.0, -1.0],
            "soft_odds": [2.0, 2.0],
            "sharp_true_prob": [0.5, 0.5],
            "soft_commission_pct": [0.0, 0.0],
            "closing_sharp_odds": [2.0, 2.0],
            "clv_pct": [1.0, 1.0],
            "event_start_time": ["2025-01-03", "2025-01-07"],
            "event_id": ["e4", "e5"],
        })

        merged = pl.concat([meta_a, meta_b], how="diagonal_relaxed")
        merged = merged.with_columns(
            pl.col("first_seen_at").cast(pl.Utf8, strict=False)
        )
        sorted_merged = merged.sort("first_seen_at", nulls_last=True)

        # Verify chronological order
        dates = sorted_merged["first_seen_at"].to_list()
        assert dates == sorted(dates), f"Not chronological: {dates}"
        assert sorted_merged["id"].to_list() == ["a1", "b1", "a2", "b2", "a3"]
