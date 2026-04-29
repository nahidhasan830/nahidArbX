const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function run() {
  try {
    const query = process.argv[2] || "SELECT * FROM bets WHERE mode = 'manual' ORDER BY placed_at DESC LIMIT 1";
    const res = await pool.query(query);
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (e) {
    console.error(e);
  } finally {
    pool.end();
  }
}
run();
