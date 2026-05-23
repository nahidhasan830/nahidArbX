-- Migration: Create ai_provider_config table
-- Run with: psql postgresql://nahidarbx_app:cQB9wCpbba8gQZIqIjbOiUKIfQ7vdHra@127.0.0.1:5432/nahidarbx -f lib/db/migrations/0062_ai_provider_config_manual.sql

-- Create table
CREATE TABLE IF NOT EXISTS ai_provider_config (
    name TEXT PRIMARY KEY,
    enabled BOOLEAN NOT NULL DEFAULT true,
    disabled_reason TEXT,
    model_id TEXT,
    tier TEXT,
    label TEXT,
    tagline TEXT,
    engine_type TEXT,
    total_usage_count BIGINT NOT NULL DEFAULT 0,
    monthly_usage_count INTEGER NOT NULL DEFAULT 0,
    monthly_limit INTEGER,
    last_reset_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS ai_provider_config_engine_idx ON ai_provider_config(engine_type);
CREATE INDEX IF NOT EXISTS ai_provider_config_enabled_idx ON ai_provider_config(enabled);

-- Seed providers with Brave=762, Tavily=1000 usage
INSERT INTO ai_provider_config (name, enabled, model_id, tier, label, tagline, engine_type, monthly_limit, total_usage_count, monthly_usage_count)
VALUES
    ('deepseek-lite', true, 'deepseek-v4-flash', 'lite', 'DeepSeek Lite', 'Fast, cheap', 'llm', null, 0, 0),
    ('deepseek-pro', true, 'deepseek-v4-pro', 'pro', 'DeepSeek Pro', 'Deep reasoning', 'llm', null, 0, 0),
    ('gemini-lite', false, 'gemini-3.1-flash-lite', 'lite', 'Gemini Flash-Lite', 'Cheapest', 'llm', null, 0, 0),
    ('gemini-flash', false, 'gemini-3-flash', 'flash', 'Gemini Flash', 'Balanced', 'llm', null, 0, 0),
    ('gemini-pro', false, 'gemini-3.1-pro', 'pro', 'Gemini Pro', 'Expert', 'llm', null, 0, 0),
    ('vertex', true, 'vertex-ai-search', 'flash', 'Vertex AI Search', "Google's enterprise", 'search', null, 0, 0),
    ('brave', true, 'brave-search-api', 'flash', 'Brave Search', 'Privacy-first', 'search', 1000, 0, 762),
    ('tavily', true, 'tavily-api', 'flash', 'Tavily', 'AI-focused', 'search', 1000, 0, 1000)
ON CONFLICT (name) DO NOTHING;

-- Drop old tables if they exist
DROP TABLE IF EXISTS ai_engine_config;
DROP TABLE IF EXISTS ai_provider_quotas;

SELECT name, enabled, monthly_usage_count, monthly_limit FROM ai_provider_config ORDER BY engine_type, name;
