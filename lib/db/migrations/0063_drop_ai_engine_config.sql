-- Drop orphaned ai_engine_config table (superseded by ai_provider_config)
-- Migration: 0063_drop_ai_engine_config
DROP TABLE IF EXISTS ai_engine_config;