-- Unified AI Provider Config — single table for provider config + quota tracking.
-- Replaces ai_engine_config and ai_provider_quotas tables.

-- Create the unified table
CREATE TABLE IF NOT EXISTS ai_provider_config (
    -- Identity
    name TEXT PRIMARY KEY,

    -- Enabled/disabled state
    enabled BOOLEAN NOT NULL DEFAULT true,
    disabled_reason TEXT,

    -- Model metadata
    model_id TEXT,
    tier TEXT,
    label TEXT,
    tagline TEXT,
    engine_type TEXT,

    -- Quota tracking
    total_usage_count BIGINT NOT NULL DEFAULT 0,
    monthly_usage_count INTEGER NOT NULL DEFAULT 0,
    monthly_limit INTEGER,  -- null = unlimited
    last_reset_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS ai_provider_config_engine_idx ON ai_provider_config(engine_type);
CREATE INDEX IF NOT EXISTS ai_provider_config_enabled_idx ON ai_provider_config(enabled);
CREATE INDEX IF NOT EXISTS ai_provider_config_usage_idx ON ai_provider_config(monthly_usage_count);

-- Seed default providers
INSERT INTO ai_provider_config (name, enabled, model_id, tier, label, tagline, engine_type, monthly_limit)
VALUES
    -- DeepSeek LLM providers (no limit)
    ('deepseek-lite', true, 'deepseek-v4-flash', 'lite', 'DeepSeek Lite', 'Fast, cheap — default', 'llm', null),
    ('deepseek-pro', true, 'deepseek-v4-pro', 'pro', 'DeepSeek Pro', 'Deep reasoning', 'llm', null),
    -- Gemini LLM providers (no limit)
    ('gemini-lite', false, 'gemini-3.1-flash-lite', 'lite', 'Gemini Flash-Lite', 'Cheapest', 'llm', null),
    ('gemini-flash', false, 'gemini-3-flash', 'flash', 'Gemini Flash', 'Balanced', 'llm', null),
    ('gemini-pro', false, 'gemini-3.1-pro', 'pro', 'Gemini Pro', 'Expert', 'llm', null),
    -- Search providers. Vertex is unlimited in this deployment.
    ('vertex', true, 'vertex-ai-search', 'flash', 'Vertex AI Search', "Google's enterprise", 'search', null),
    ('brave', true, 'brave-search-api', 'flash', 'Brave Search', 'Privacy-first', 'search', 1000),
    ('tavily', true, 'tavily-api', 'flash', 'Tavily', 'AI-focused', 'search', 1000)
ON CONFLICT (name) DO NOTHING;

-- Drop old tables (after confirming migration worked)
-- DROP TABLE IF EXISTS ai_engine_config;
-- DROP TABLE IF EXISTS ai_provider_quotas;
