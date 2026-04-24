-- Kelly multiplier setting on betting_settings. Lets the user pick
-- Full / Half / Quarter (default) / Eighth Kelly from the dashboard
-- strategy popover — previously baked in as a hardcoded 0.25 in
-- lib/betting/sizing.ts.
ALTER TABLE "betting_settings"
  ADD COLUMN IF NOT EXISTS "kelly_fraction" numeric(5, 3) NOT NULL DEFAULT 0.25;
