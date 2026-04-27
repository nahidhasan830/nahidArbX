const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function run() {
  try {
    const res = await pool.query(
      "SELECT * FROM bets WHERE mode = 'manual' ORDER BY placed_at DESC LIMIT 1",
    );
    console.log("Full manual bet:", res.rows[0]);
  } catch (e) {
    console.error(e);
  } finally {
    pool.end();
  }
}
run();
