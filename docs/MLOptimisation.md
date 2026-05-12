# ML Optimisation Pipeline

A four-stage training-to-deployment pipeline that runs as a Cloud Run Job, producing LightGBM models exported to ONNX for runtime inference. The engine scores live value bets using the deployed model and adjusts Kelly sizing based on model confidence.

## Pipeline stages

### Stage A — Hyperparameter optimisation (Optuna)

**File:** `services/optimizer/app/hpo.py`

- Uses Optuna's multivariate TPE sampler + HyperbandPruner (BOHB-style).
- Inner CV = purged walk-forward (`walk_forward.py`), NOT CPCV.
- 6 hyperparameters searched: `num_leaves`, `max_depth`, `learning_rate`, `min_child_samples`, `reg_alpha`, `reg_lambda`.
- Default budget: 50 trials with a 10-minute timeout.
- Composite objective: mean OOS unit return × (1 + Sharpe floor).

**Why walk-forward, not CPCV, for HPO:** CPCV path geometry leaks into HPO selection bias, undermining the statistic (DSR) it's there to provide. CPCV is reserved for _certifying_ the chosen model, not picking it. Walk-forward is honest, fast, and matches production retraining.

### Stage B — Outer holdout

**File:** `services/optimizer/app/trainer.py` (`_stage_b_outer_holdout`)

- Single train on first 85%, test on last 15% (chronological).
- Provides honest, unbiased evaluation of the HPO-chosen config.
- Reports AUC, unit return mean, policy ROI, policy sample count.

### Stage C — CPCV risk certification

**File:** `services/optimizer/app/trainer.py` (`_stage_c_cpcv`)

- Purged combinatorial cross-validation on the chosen config.
- 10 groups, 2 test groups per path, 1% embargo.
- Produces OOS prediction distributions used for DSR, PBO, calibration, and score-bucket analysis.

### Stage D — Final fit + calibration + SHAP

**File:** `services/optimizer/app/trainer.py` (final section of `train()`)

- Fits on ALL data with the chosen hyperparameters.
- Computes SHAP feature importance.
- Fits calibrator on Stage C OOS predictions.

## Calibration

**File:** `services/optimizer/app/calibration.py`

Three methods with automatic sample-size-based selection:

| Method | Parameters | When |
|--------|-----------|------|
| Platt (sigmoid) | 2 (intercept, slope) | < 500 samples |
| Beta | 3 (a, b, c) | 500–1000 samples |
| Isotonic | PAV step function | ≥ 1000 samples |

Calibration parameters are stored in `training_report.calibration_params` and consumed by the Node.js scorer at runtime.

## Deployment gate

**File:** `services/optimizer/app/deployment_gate.py`

Hard gates (any failure = rejection):
- Feature version/count match
- Minimum 200 training samples
- AUC ≥ 0.55
- ECE ≤ 0.15
- Score bucket monotonicity ≥ 0.6
- ML-gated policy with ≥ 100 samples and non-negative ROI
- DSR ≥ 0.6

Permission levels (escalation order):
1. **shadow** — score and log, no effect on placement
2. **gate_only** — skip low-score bets (requires AUC ≥ 0.60, DSR ≥ 0.7)
3. **stake_reduce** — reduce stakes on weak bets (requires AUC ≥ 0.65, DSR ≥ 0.8, monotonicity ≥ 0.8)
4. **stake_increase** — increase stakes on strong bets (disabled; requires real placed-settled evidence)

## Champion-challenger

**File:** `lib/ml/promotion.ts`

The deployed model (champion) is replaced only when a challenger proves statistically better:

- **Opdyke two-sample PSR** tests whether the challenger's Sharpe ratio significantly exceeds the champion's on the same OOS evaluation window.
- Accounts for skew, kurtosis, and correlation between the two models' returns.
- Promotion threshold: PSR ≥ 0.95 (95% confidence).

### Dual scoring

**File:** `lib/ml/scorer.ts`

The scorer can run both champion and challenger inference sessions simultaneously (`scoreBatchDual()`). Both models' scores are logged for performance comparison. The challenger does not affect live betting — it only collects evidence.

## Drift detection

**File:** `lib/ml/drift-detector.ts`

ADWIN (ADaptive WINdowing) tracks three metrics on settled bets:
- **unitReturn** — per-bet unit return
- **winRate** — 0/1 win/loss signals
- **mlScoreBias** — difference between predicted score and actual outcome

When ADWIN shrinks its window repeatedly (concept drift), the retraining scheduler is notified and may override the normal cadence to trigger an early retrain. A one-hour cooldown prevents retrain storms.

## Deflated Sharpe Ratio (DSR)

**File:** `services/optimizer/app/scoring.py`

The DSR (Bailey & López de Prado, 2014) corrects the observed Sharpe for:
1. **Multiple testing** — many hyperparameter configs were tried (n_trials).
2. **Non-normality** — returns have skew and excess kurtosis.

It answers: "given this observed Sharpe, how confident should we be that it's real and not just the luckiest trial?" DSR ≥ 0.6 is required for deployment.

DSR is now _multi-trial-aware_: when HPO ran multiple trials, the DSR formula uses the variance of per-trial Sharpes as the benchmark variance. When HPO is skipped (single-config mode, e.g., unit tests), DSR collapses to the Probabilistic Sharpe Ratio (PSR vs zero).

## Score bucket analysis

**File:** `services/optimizer/app/scoring.py` (`score_bucket_analysis`)

Equal-count quantile buckets (6 by default) test whether higher ML scores produce better ROI, CLV, and win rates. Combined monotonicity (average of ROI and win-rate monotonicity) must be ≥ 0.6 for deployment.

## Key files

| Layer | File | Purpose |
|-------|------|---------|
| Python | `services/optimizer/app/trainer.py` | Training orchestrator (Stages A→D) |
| Python | `services/optimizer/app/hpo.py` | Optuna HPO with walk-forward inner CV |
| Python | `services/optimizer/app/walk_forward.py` | Purged walk-forward CV splits |
| Python | `services/optimizer/app/calibration.py` | Platt/Beta/Isotonic calibration |
| Python | `services/optimizer/app/deployment_gate.py` | Quality gates + permission levels |
| Python | `services/optimizer/app/exporter.py` | ONNX export + DB row write |
| Python | `services/optimizer/app/job.py` | Cloud Run Job entrypoint |
| Python | `services/optimizer/app/scoring.py` | DSR, PBO, PSR, score buckets |
| TypeScript | `lib/ml/scorer.ts` | ONNX inference + calibration apply |
| TypeScript | `lib/ml/staker.ts` | Permission-aware Kelly sizing |
| TypeScript | `lib/ml/promotion.ts` | Opdyke champion-challenger promotion |
| TypeScript | `lib/ml/drift-detector.ts` | ADWIN concept drift detection |
| TypeScript | `lib/ml/deployment-gate.ts` | Runtime permission checking |
| TypeScript | `lib/ml/features.ts` | Feature extraction (25-dim vector) |
| TypeScript | `lib/ml/outcomes.ts` | Outcome → label derivation |
| TypeScript | `lib/optimizer/scheduler.ts` | Retraining scheduler |
| DB | `lib/db/schema.ts` (`ml_models`) | Model lifecycle tracking |
| DB | `lib/db/schema.ts` (`ml_scheduler_settings`) | Scheduler configuration |
| UI | `components/lab/ml/MLPipelineDashboard.tsx` | ML Optimizer dashboard |
| UI | `components/lab/ml/dashboard/ChampionChallengerCard.tsx` | Champion vs challenger card |
| UI | `components/lab/ml/MLModelStatus.tsx` | Retrain button component |

## ONNX export pipeline

1. `exporter.py` converts the trained LightGBM model to ONNX via `skl2onnx`.
2. ZipMap operators are stripped so `onnxruntime-node` can consume the tensor output.
3. Feature names, version, and hash are embedded in ONNX metadata for runtime validation.
4. The ONNX binary is stored in Postgres (`ml_models.onnx_blob`) — no GCS or local file cache needed for normal operation.
5. The Node.js scorer validates feature contract on load and fails loud on mismatch.
