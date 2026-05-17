-- AI Engine Config — per-engine enabled/disabled state for LLM engines.
-- Persists toggle state across Python service restarts.
CREATE TABLE IF NOT EXISTS ai_engine_config (
  name       TEXT PRIMARY KEY,
  enabled    BOOLEAN NOT NULL DEFAULT true,
  disabled_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed default rows for known engines
INSERT INTO ai_engine_config (name, enabled)
VALUES ('deepseek', true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO ai_engine_config (name, enabled)
VALUES ('gemini', true)
ON CONFLICT (name) DO NOTHING;
