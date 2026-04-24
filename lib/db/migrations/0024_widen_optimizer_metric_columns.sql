-- AlphaSearch — widen optimizer metric columns to accommodate noisy
-- folds that produce Sharpe / ROI values above 9,999 (numeric(8,4)
-- envelope). Seen 2026-04-24 prod: a trial's Sharpe computed on a
-- std≈0 fold blew past numeric(8,4), failing the entire run with:
--   "numeric field overflow: A field with precision 8, scale 4 must
--    round to an absolute value less than 10^4."
--
-- numeric(14, 4) lifts the cap to ±9,999,999,999.9999 — plenty of
-- headroom while still storing metrics as exact decimals, not floats.
-- The sidecar also sanitizes NaN/inf/overflow values to NULL (see
-- services/optimizer/app/runner.py::_sanitize_metric), so both the
-- column type and the app cooperate on this defence.
--
-- `probabilistic_sharpe` stays numeric(6,4) because it's a probability
-- (0..1) — no reason to widen.

ALTER TABLE "optimization_trials"
  ALTER COLUMN "oos_roi_mean"       TYPE numeric(14, 4),
  ALTER COLUMN "oos_roi_ci_low"     TYPE numeric(14, 4),
  ALTER COLUMN "oos_roi_ci_high"    TYPE numeric(14, 4),
  ALTER COLUMN "oos_sortino"        TYPE numeric(14, 4),
  ALTER COLUMN "oos_sharpe"         TYPE numeric(14, 4),
  ALTER COLUMN "deflated_sharpe"    TYPE numeric(14, 4),
  ALTER COLUMN "max_drawdown"       TYPE numeric(14, 4),
  ALTER COLUMN "composite_score"    TYPE numeric(14, 4);

ALTER TABLE "strategy_validations"
  ALTER COLUMN "live_roi_pct"          TYPE numeric(14, 4),
  ALTER COLUMN "snapshot_roi_mean"     TYPE numeric(14, 4),
  ALTER COLUMN "snapshot_roi_ci_low"   TYPE numeric(14, 4),
  ALTER COLUMN "snapshot_roi_ci_high"  TYPE numeric(14, 4);
