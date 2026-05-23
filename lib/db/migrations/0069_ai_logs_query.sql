-- Store the exact search/query string for unified AI logs.
-- The Drizzle schema already maps this column as ai_logs.query; older
-- deployments of 0061 did not create it.
ALTER TABLE ai_logs
  ADD COLUMN IF NOT EXISTS query TEXT;

CREATE INDEX IF NOT EXISTS ai_logs_query_idx
  ON ai_logs USING gin (to_tsvector('simple', COALESCE(query, '')));
