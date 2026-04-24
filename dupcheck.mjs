import pg from "pg";
import fs from "fs";
const env = fs
  .readFileSync("/Users/nahidhasan/nahidArbX/.env", "utf8")
  .split(/\r?\n/)
  .reduce((a, l) => {
    const m = l.match(/^([A-Z_]+)=(.*)$/);
    if (m) a[m[1]] = m[2];
    return a;
  }, {});
const c = new pg.Client({ connectionString: env.DATABASE_URL });
await c.connect();
async function q(sql) {
  const r = await c.query(sql);
  console.log("---", sql.split("\n")[0]);
  console.table(r.rows);
}
await q(
  `SELECT COUNT(*) AS total, COUNT(DISTINCT (event_id, family_id, atom_id)) AS unique_selections FROM bets`,
);
await q(
  `SELECT COUNT(*) AS total_unplaced, COUNT(DISTINCT (event_id, family_id, atom_id)) AS unique_unplaced FROM bets WHERE placed_at IS NULL`,
);
await q(
  `SELECT event_id, family_id, atom_id, COUNT(*) AS c FROM bets WHERE placed_at IS NULL GROUP BY 1,2,3 HAVING COUNT(*) > 1 ORDER BY c DESC LIMIT 10`,
);
await q(
  `SELECT CASE WHEN id LIKE 'vb-%' THEN 'vb-prefix' WHEN id LIKE '%|%|%' THEN 'deterministic' ELSE 'other' END AS id_format, COUNT(*) FROM bets GROUP BY 1`,
);
await q(
  `SELECT id, event_id, family_id, atom_id, soft_provider, tick_count, first_seen_at FROM bets WHERE placed_at IS NULL AND (event_id, family_id, atom_id) IN (SELECT event_id, family_id, atom_id FROM bets WHERE placed_at IS NULL GROUP BY 1,2,3 HAVING COUNT(*) > 1) ORDER BY event_id, family_id, atom_id LIMIT 20`,
);
await c.end();
