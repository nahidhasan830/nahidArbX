-- Auto-validation history is retired: live ROI / drift are now computed
-- on every scheduler tick by lib/optimizer/live-metrics-aggregator and
-- surfaced inline on the Strategies tab. The 7-day snapshot history was
-- a stale duplicate, and with filter-based attribution old rows silently
-- re-interpret as new bets accumulate.
DROP TABLE IF EXISTS "strategy_validations";
