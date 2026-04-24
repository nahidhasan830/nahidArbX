-- AlphaSearch Phase 1.5 — pre-search data-scope filter on optimization_runs.
--
-- Lets the user narrow the dataset BEFORE the optimizer searches inside it.
-- e.g. "exclude all NineWickets-Exchange bets from this analysis" — different
-- from the search-space dimension `soft_providers`, which sweeps subsets
-- WITHIN the included data.
--
-- Default = empty object = include every settled bet.
-- Schema (JSON shape, validated in TS at /api/optimizer/runs):
--   {
--     excludeSoftProviders?: string[],
--     includeSoftProviders?: string[],
--     excludeMarketTypes?:  string[],
--     includeMarketTypes?:  string[],
--     eventStartFrom?:      string (ISO 8601),
--     eventStartTo?:        string (ISO 8601),
--     placedOnly?:          boolean,
--   }

ALTER TABLE "optimization_runs"
  ADD COLUMN IF NOT EXISTS "data_filters" jsonb NOT NULL DEFAULT '{}'::jsonb;
