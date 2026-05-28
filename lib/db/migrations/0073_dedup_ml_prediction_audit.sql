-- Keep one latest prediction row per deterministic bet_id.
--
-- The ML Optimizer predictions table is a per-bet surface, not a historical
-- tick log. Preserve the latest score/price context while carrying forward
-- any non-pending settlement mirror before deleting older rows.

WITH keepers AS (
  SELECT DISTINCT ON (bet_id)
    id,
    bet_id
  FROM ml_prediction_audit
  ORDER BY bet_id, scored_at DESC, id DESC
),
latest_settlement AS (
  SELECT DISTINCT ON (bet_id)
    bet_id,
    outcome,
    pnl,
    clv_pct,
    settled_at
  FROM ml_prediction_audit
  WHERE outcome <> 'pending'
  ORDER BY bet_id, COALESCE(settled_at, scored_at) DESC, scored_at DESC, id DESC
)
UPDATE ml_prediction_audit AS audit
SET
  outcome = latest_settlement.outcome,
  pnl = latest_settlement.pnl,
  clv_pct = latest_settlement.clv_pct,
  settled_at = latest_settlement.settled_at
FROM keepers, latest_settlement
WHERE audit.id = keepers.id
  AND keepers.bet_id = latest_settlement.bet_id
  AND audit.outcome = 'pending';

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY bet_id
      ORDER BY scored_at DESC, id DESC
    ) AS rn
  FROM ml_prediction_audit
)
DELETE FROM ml_prediction_audit AS audit
USING ranked
WHERE audit.id = ranked.id
  AND ranked.rn > 1;

DROP INDEX IF EXISTS ml_prediction_audit_bet_idx;

CREATE UNIQUE INDEX IF NOT EXISTS ml_prediction_audit_bet_unique
  ON ml_prediction_audit (bet_id);
