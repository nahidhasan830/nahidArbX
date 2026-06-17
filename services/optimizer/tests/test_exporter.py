from app.exporter import _training_report_payload
from app.trainer import TrainingMetrics


def test_training_report_payload_persists_dsr_audit_inputs() -> None:
    metrics = TrainingMetrics(
        auc_roc=0.71,
        accuracy=0.64,
        log_loss_val=0.52,
        calibration_error=0.03,
        oos_roi_mean=4.2,
        oos_clv_mean=1.7,
        policy_roi_mean=5.1,
        policy_sample_size=321,
        policy_coverage=0.18,
        policy_edge_threshold_pct=2.0,
        baseline_roi_mean=1.1,
        simple_policy_roi_mean=2.4,
        simple_policy_sample_size=654,
        simple_policy_coverage=0.37,
        model_vs_simple_roi_delta=2.7,
        policy_lower_confidence_roi_pct=0.9,
        policy_threshold_candidates=0,
        dsr=0.0045,
        pbo=0.65,
        hpo_n_trials=47,
        hpo_best_objective=0.123456,
        hpo_per_trial_sharpe_var=0.789012,
        outer_holdout_n=92,
        outer_holdout_auc=0.61,
        outer_holdout_unit_return_mean=0.0123,
        outer_holdout_policy_roi_pct=3.4,
        outer_holdout_policy_n=17,
        n_samples=1500,
        n_positive=760,
        n_negative=740,
        n_folds=45,
        scale_pos_weight=0.9737,
        per_fold_sharpes=[0.1, -0.2, 0.3],
        calibration_method="isotonic",
        calibration_params={"x": [0.1], "y": [0.2]},
    )

    report = _training_report_payload(metrics)

    assert report["hpo_n_trials"] == 47
    assert report["hpo_best_objective"] == 0.123456
    assert report["hpo_per_trial_sharpe_var"] == 0.789012
    assert report["outer_holdout_n"] == 92
    assert report["outer_holdout_auc"] == 0.61
    assert report["outer_holdout_unit_return_mean"] == 0.0123
    assert report["outer_holdout_policy_roi_pct"] == 3.4
    assert report["outer_holdout_policy_n"] == 17
    assert report["per_fold_sharpes"] == [0.1, -0.2, 0.3]
