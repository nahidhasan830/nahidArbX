/**
 * One-shot runner for pending migrations against the production
 * Cloud SQL instance. Every migration file is idempotent
 * (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), so it's
 * safe to re-run — only the pending DDL executes.
 *
 * Why this script exists: Drizzle's `db.select().from(table)` expands
 * to a SELECT that names every schema column. When we add a new column
 * in the schema, Postgres rejects the whole statement until the
 * matching migration lands — and any endpoint doing a row-level read
 * returns 500.
 *
 * Connection path mirrors `lib/db/client.ts` exactly:
 *   - If `CLOUD_SQL_INSTANCE` is set, use the @google-cloud/cloud-sql-connector
 *     with IAM ADC (no proxy needed; same path the app uses in prod).
 *   - Otherwise, fall back to the raw DATABASE_URL string (local dev
 *     with a proxy, if anyone's still running one).
 *
 * Usage:
 *   npx tsx scripts/apply-pending-migrations.ts
 *   npx tsx scripts/apply-pending-migrations.ts 0025   # apply just one
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool, type PoolConfig } from "pg";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import "dotenv/config";

// Keep this list in order. Idempotent DDL means re-running a past
// migration is a no-op, so we don't track which ones already ran.
const MIGRATIONS = [
  // Legacy optimizer migrations 0018-0029 removed — tables dropped by 0051.
  "0030_drop_strategy_validations.sql",
  "0031_entities.sql",
  "0032_entity_review_queue.sql",
  "0033_entity_resolver_runs.sql",
  "0034_matcher_rebuild.sql",
  "0035_match_pairs.sql",
  "0036_matcher_config.sql",
  "0044_drop_auto_settle_ai_config.sql",
  "0045_competition_tiers.sql",
  "0046_ml_feature_contract.sql",
  "0047_competition_enrichments.sql",
  "0048_shadow_decisions.sql",
  "0049_ml_training_examples.sql",
  "0050_ml_deployment_gate.sql",
  "0051_drop_legacy_optimizer_tables.sql",
  "0052_ml_scheduler_settings.sql",
  "0053_ml_schema_truth.sql",
  "0054_drop_shadow_decisions.sql",
  "0055_betting_settings_market_phases.sql",
  "0056_match_scores_bookings.sql",
  "0057_name_obs_outcome_check.sql",
  "0058_purge_near_miss.sql",
  "0059_ml_champion_columns.sql",
];

let cloudSqlConnector: Connector | null = null;

async function buildPool(): Promise<Pool> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set — check .env");

  const instance = process.env.CLOUD_SQL_INSTANCE;
  if (!instance) {
    console.log("[migrate] no CLOUD_SQL_INSTANCE — using plain DATABASE_URL");
    return new Pool({ connectionString: url, max: 4 });
  }

  console.log(`[migrate] connecting via Cloud SQL connector → ${instance}`);
  const parsed = new URL(url);
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const database = parsed.pathname.slice(1);

  cloudSqlConnector = new Connector();
  const opts = await cloudSqlConnector.getOptions({
    instanceConnectionName: instance,
    ipType: IpAddressTypes.PUBLIC,
  });
  const cfg: PoolConfig = { ...opts, user, password, database, max: 4 };
  return new Pool(cfg);
}

async function main() {
  const onlyArg = process.argv[2];
  const selection = onlyArg
    ? MIGRATIONS.filter((m) => m.startsWith(onlyArg))
    : MIGRATIONS;

  if (onlyArg && selection.length === 0) {
    console.error(
      `No migration matches "${onlyArg}". Known: ${MIGRATIONS.join(", ")}`,
    );
    process.exit(1);
  }

  const pool = await buildPool();

  for (const file of selection) {
    const path = join(process.cwd(), "lib/db/migrations", file);
    const body = readFileSync(path, "utf8");
    process.stdout.write(`→ ${file} … `);
    try {
      await pool.query(body);
      process.stdout.write("ok\n");
    } catch (err) {
      process.stdout.write("FAILED\n");
      throw err;
    }
  }

  // Post-checks — these are the columns/tables that matter for current
  // Drizzle schema coverage. If any of them are missing, the app will
  // 500 on corresponding reads.
  console.log("\nSchema post-checks:");
  const checks: Array<{ what: string; sql: string; expect: number }> = [
    {
      what: "strategy_validations table dropped",
      sql: `SELECT count(*)::int AS n FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'strategy_validations'`,
      expect: 0,
    },
    {
      what: "entities table",
      sql: `SELECT count(*)::int AS n FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'entities'`,
      expect: 1,
    },
    {
      what: "entity_names table",
      sql: `SELECT count(*)::int AS n FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'entity_names'`,
      expect: 1,
    },
    {
      what: "name_observations table",
      sql: `SELECT count(*)::int AS n FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'name_observations'`,
      expect: 1,
    },
    {
      what: "entity_review_queue table dropped (matcher rebuild)",
      sql: `SELECT count(*)::int AS n FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'entity_review_queue'`,
      expect: 0,
    },
    {
      what: "entity_resolver_runs table dropped (matcher rebuild)",
      sql: `SELECT count(*)::int AS n FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'entity_resolver_runs'`,
      expect: 0,
    },
    {
      what: "entity_trainer_runs table",
      sql: `SELECT count(*)::int AS n FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'entity_trainer_runs'`,
      expect: 1,
    },
    {
      what: "entity_decision_blocklist table",
      sql: `SELECT count(*)::int AS n FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'entity_decision_blocklist'`,
      expect: 1,
    },
    {
      what: "match_pairs table",
      sql: `SELECT count(*)::int AS n FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'match_pairs'`,
      expect: 1,
    },
    {
      what: "entity_names.surface_embedding migrated to vector(1024)",
      sql: `SELECT count(*)::int AS n FROM pg_attribute a
              JOIN pg_class c ON c.oid = a.attrelid
              WHERE c.relname = 'entity_names' AND a.attname = 'surface_embedding'
                AND format_type(a.atttypid, a.atttypmod) = 'vector(1024)'`,
      expect: 1,
    },
    {
      what: "bets.ml_feature_version column",
      sql: `SELECT count(*)::int AS n FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'bets'
                AND column_name = 'ml_feature_version'`,
      expect: 1,
    },
    {
      what: "bets.ml_feature_count column",
      sql: `SELECT count(*)::int AS n FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'bets'
                AND column_name = 'ml_feature_count'`,
      expect: 1,
    },
    {
      what: "bets.ml_feature_names_hash column",
      sql: `SELECT count(*)::int AS n FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'bets'
                AND column_name = 'ml_feature_names_hash'`,
      expect: 1,
    },
    {
      what: "ml_models.feature_version column",
      sql: `SELECT count(*)::int AS n FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'ml_models'
                AND column_name = 'feature_version'`,
      expect: 1,
    },
    {
      what: "ml_models.permission_level column",
      sql: `SELECT count(*)::int AS n FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'ml_models'
                AND column_name = 'permission_level'`,
      expect: 1,
    },
    {
      what: "competition_enrichments table",
      sql: `SELECT count(*)::int AS n FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'competition_enrichments'`,
      expect: 1,
    },
    {
      what: "shadow_decisions table dropped (Phase 6)",
      sql: `SELECT count(*)::int AS n FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'shadow_decisions'`,
      expect: 0,
    },
    {
      what: "ml_training_examples table",
      sql: `SELECT count(*)::int AS n FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'ml_training_examples'`,
      expect: 1,
    },
    {
      what: "ml_scheduler_settings table",
      sql: `SELECT count(*)::int AS n FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'ml_scheduler_settings'`,
      expect: 1,
    },
    // Phase 1 — Schema & Migration Truth
    {
      what: "ml_models.onnx_blob column",
      sql: `SELECT count(*)::int AS n FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'ml_models'
                AND column_name = 'onnx_blob'`,
      expect: 1,
    },
    {
      what: "ml_models.notified_at column",
      sql: `SELECT count(*)::int AS n FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'ml_models'
                AND column_name = 'notified_at'`,
      expect: 1,
    },
    {
      what: "ml_model_version_seq sequence",
      sql: `SELECT count(*)::int AS n FROM pg_class
              WHERE relname = 'ml_model_version_seq' AND relkind = 'S'`,
      expect: 1,
    },
    {
      what: "ml_training_examples bet_type unique index",
      sql: `SELECT count(*)::int AS n FROM pg_indexes
              WHERE tablename = 'ml_training_examples'
                AND indexname = 'ml_training_examples_bet_type_uq'`,
      expect: 1,
    },
    {
      what: "ml_training_examples selection_type unique index",
      sql: `SELECT count(*)::int AS n FROM pg_indexes
              WHERE tablename = 'ml_training_examples'
                AND indexname = 'ml_training_examples_selection_type_uq'`,
      expect: 1,
    },
    {
      what: "betting_settings.value_detection_phases column",
      sql: `SELECT count(*)::int AS n FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'betting_settings'
                AND column_name = 'value_detection_phases'`,
      expect: 1,
    },
    {
      what: "betting_settings.bet_placement_phases column",
      sql: `SELECT count(*)::int AS n FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'betting_settings'
                AND column_name = 'bet_placement_phases'`,
      expect: 1,
    },
    {
      what: "match_scores.bookings_home column",
      sql: `SELECT count(*)::int AS n FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'match_scores'
                AND column_name = 'bookings_home'`,
      expect: 1,
    },
    {
      what: "ml_models.is_champion column",
      sql: `SELECT count(*)::int AS n FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'ml_models'
                AND column_name = 'is_champion'`,
      expect: 1,
    },
    {
      what: "ml_models.champion_psr column",
      sql: `SELECT count(*)::int AS n FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'ml_models'
                AND column_name = 'champion_psr'`,
      expect: 1,
    },
  ];
  let failures = 0;
  for (const c of checks) {
    const r = await pool.query<{ n: number }>(c.sql);
    const n = r.rows[0]?.n ?? 0;
    const mark = n === c.expect ? "✓" : "✗";
    if (n !== c.expect) failures += 1;
    console.log(`  ${mark} ${c.what} (found ${n}, expected ${c.expect})`);
  }

  await pool.end();
  if (cloudSqlConnector) {
    await cloudSqlConnector.close();
  }
  if (failures > 0) {
    console.error(`\n${failures} post-check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll migrations applied. Schema is in sync with Drizzle.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
