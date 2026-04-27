import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function run() {
  const values = Array.from({ length: 8 }, (_, i) => {
    const id = `user-test-${i + 1}`;
    const pk = `upk-${i + 1}`;
    const home = `FC Testing ${i + 1}`;
    const away = `Demo United ${i + 1}`;
    const comp = `UI Validation League ${i % 2 === 0 ? "A" : "B"}`;
    return `('${id}', '${pk}', 'near-match', 'inbox', 'a${i + 10}', 'b${i + 10}', 'pinnacle', 'ninewickets-exchange', '${home}', '${away}', '${comp}', now(), '${home} FC', '${away} Club', '${comp}', now(), ${0.6 + i * 0.05})`;
  }).join(",");

  await pool.query(`
    INSERT INTO match_pairs (
      id, pair_key, source, stage, event_a_event_id, event_b_event_id,
      event_a_provider, event_b_provider,
      event_a_home_team, event_a_away_team, event_a_competition, event_a_start_time,
      event_b_home_team, event_b_away_team, event_b_competition, event_b_start_time,
      string_score
    ) VALUES 
    ${values}
    ON CONFLICT DO NOTHING
  `);
  console.log("Inserted 8 dummy pairs for user testing");
  process.exit(0);
}
run();
