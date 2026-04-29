import { Pool } from "pg";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    const res = await pool.query('SELECT * FROM market_anomalies');
    console.log("Anomalies:", res.rows);
  } catch (err) {
    console.error("Error:", err);
  } finally {
    process.exit(0);
  }
}

main();
