-- Vertex AI Search is the primary search provider and is unlimited for this
-- deployment. Keep usage counters for visibility, but never mark it exhausted.
UPDATE ai_provider_config
SET monthly_limit = NULL,
    enabled = TRUE,
    disabled_reason = NULL,
    updated_at = now()
WHERE name = 'vertex';
