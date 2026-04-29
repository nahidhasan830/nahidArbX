import { Pool } from "pg";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await pool.query(`
      INSERT INTO unmapped_markets (provider, raw_market_key, raw_market_name, sample_payload, occurrence_count)
      VALUES 
        ('betconstruct', 'TotalGoalsHome', 'Total Goals Home', '{"base": 1.5, "selectionsCount": 2}'::jsonb, 150),
        ('ninewickets-sportsbook', '12_2', 'Home Team Total', '{"line": "1.5", "selectionId": "Over"}'::jsonb, 140),
        ('pinnacle', 'Team1Total', 'Team 1 Total', '{"base": 1.5, "selections": ["Over", "Under"]}'::jsonb, 130),
        ('betconstruct', 'YellowCards', 'Player Yellow Cards', '{"player": "Saka"}'::jsonb, 5)
      ON CONFLICT DO NOTHING;
      
      INSERT INTO market_anomalies (event_id, family_id, atom_id, soft_provider, sharp_provider, soft_odds, sharp_odds, ip_soft, ip_sharp, deviation_pct, anomaly_type)
      VALUES 
        ('sr:match:123', 'match_result', 'match_result_home', 'betconstruct', 'pinnacle', 5.00, 1.50, 0.2, 0.66, 46.0, 'participant_reversal'),
        ('sr:match:124', 'asian_handicap', 'asian_handicap_home_-0.5', 'velki-sportsbook', 'pinnacle', 2.10, 1.85, 0.47, 0.54, 17.0, 'extreme_deviation')
      ON CONFLICT DO NOTHING;
    `);
    console.log("Seed data created successfully");
  } catch (err) {
    console.error("Error seeding tables:", err);
  } finally {
    process.exit(0);
  }
}

main();
