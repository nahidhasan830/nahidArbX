import { Pool } from "pg";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS unmapped_markets (
        id BIGSERIAL PRIMARY KEY,
        provider TEXT NOT NULL,
        raw_market_key TEXT NOT NULL,
        raw_market_name TEXT,
        sample_payload JSONB,
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (provider, raw_market_key)
      );

      CREATE TABLE IF NOT EXISTS market_anomalies (
        id BIGSERIAL PRIMARY KEY,
        event_id TEXT NOT NULL,
        family_id TEXT NOT NULL,
        atom_id TEXT NOT NULL,
        soft_provider TEXT NOT NULL,
        sharp_provider TEXT NOT NULL,
        soft_odds REAL,
        sharp_odds REAL,
        ip_soft REAL,
        ip_sharp REAL,
        deviation_pct REAL NOT NULL,
        anomaly_type TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("Tables created successfully");
  } catch (err) {
    console.error("Error creating tables:", err);
  } finally {
    process.exit(0);
  }
}

main();
