CREATE TABLE IF NOT EXISTS "strategy_executions" (
  "id" text PRIMARY KEY NOT NULL,
  "strategy_id" text NOT NULL,
  "value_bet_id" text NOT NULL,
  "matched_at" timestamp with time zone DEFAULT now() NOT NULL,
  "stake_multiplier" numeric(6, 3) NOT NULL DEFAULT '1'
);

CREATE INDEX IF NOT EXISTS "strategy_exec_strategy_idx" ON "strategy_executions" ("strategy_id");
CREATE INDEX IF NOT EXISTS "strategy_exec_value_bet_idx" ON "strategy_executions" ("value_bet_id");
CREATE UNIQUE INDEX IF NOT EXISTS "strategy_exec_unique_idx" ON "strategy_executions" ("strategy_id", "value_bet_id");
