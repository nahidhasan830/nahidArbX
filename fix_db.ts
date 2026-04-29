import { Pool } from "pg";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await pool.query(`ALTER TABLE market_anomalies ADD COLUMN IF NOT EXISTS dropped BOOLEAN NOT NULL DEFAULT FALSE;`);
    console.log("Column added successfully");
  } catch (err) {
    console.error("Error altering table:", err);
  } finally {
    process.exit(0);
  }
}

main();
