-- Create unified ai_logs table
-- Drop old ai_search_logs and ai_activity_log tables

-- Step 1: Create new unified table
CREATE TABLE IF NOT EXISTS ai_logs (
    id BIGSERIAL PRIMARY KEY,
    "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    system TEXT NOT NULL,
    trigger TEXT NOT NULL DEFAULT 'manual',
    endpoint TEXT,
    service TEXT NOT NULL DEFAULT 'Manual',
    status TEXT NOT NULL,
    model TEXT,
    "providerUsed" TEXT,
    "itemCount" INTEGER,
    "durationMs" INTEGER,
    "costUsd" NUMERIC(8, 5),
    summary TEXT,
    error TEXT,
    "requestBody" JSONB,
    "responseBody" JSONB,
    metadata JSONB
);

-- Indexes for the new table
CREATE INDEX IF NOT EXISTS ai_logs_created_idx ON ai_logs("createdAt" DESC);
CREATE INDEX IF NOT EXISTS ai_logs_system_idx ON ai_logs(system);
CREATE INDEX IF NOT EXISTS ai_logs_status_idx ON ai_logs(status);
CREATE INDEX IF NOT EXISTS ai_logs_endpoint_idx ON ai_logs(endpoint);

-- Step 2: Migrate data from old tables (if they exist)
-- This is optional - existing data can be kept for reference or deleted

-- Step 3: Drop old tables (after migration, comment this out if you want to keep old data)
-- DROP TABLE IF EXISTS ai_search_logs;
-- DROP TABLE IF EXISTS ai_activity_log;