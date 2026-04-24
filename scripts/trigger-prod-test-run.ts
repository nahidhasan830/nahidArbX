/**
 * Production smoke test — queue a tiny optimizer run against the live
 * Cloud SQL + Cloud Run sidecar, then poll until it terminates. Prints
 * the terminal status + summary + error message (if any).
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/trigger-prod-test-run.ts
 *
 * Uses raw pg.Pool + Cloud SQL connector (same as apply-one-migration.ts)
 * to avoid the top-level-await incompat between tsx CJS and
 * lib/db/client.ts.
 */
import "dotenv/config";
import { Pool } from "pg";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";

const OPTIMIZER_URL = process.env.OPTIMIZER_URL;
const OPTIMIZER_TOKEN = process.env.OPTIMIZER_SHARED_SECRET;
const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = 20 * 60_000; // 20 minutes

async function buildPool(): Promise<Pool> {
  const cs = process.env.DATABASE_URL!;
  const instance = process.env.CLOUD_SQL_INSTANCE;
  if (!instance) return new Pool({ connectionString: cs, max: 1 });
  const url = new URL(cs);
  const c = new Connector();
  const opts = await c.getOptions({
    instanceConnectionName: instance,
    ipType: IpAddressTypes.PUBLIC,
  });
  return new Pool({
    ...opts,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    max: 1,
  });
}

const ulidLike = (): string => {
  const ts = Date.now().toString(36).padStart(10, "0");
  const rand = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 36).toString(36),
  ).join("");
  return `${ts}${rand}`.toUpperCase();
};

interface RunRow {
  id: string;
  status: string;
  n_trials_done: number;
  n_trials_target: number;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  summary: unknown;
}

async function main() {
  if (!OPTIMIZER_URL) throw new Error("OPTIMIZER_URL not set");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");

  const pool = await buildPool();
  const client = await pool.connect();

  const runId = ulidLike();
  const name = `Smoke ${new Date().toISOString().slice(11, 16)}`;

  try {
    console.log(`▶ Inserting run ${runId} (${name}) …`);
    await client.query(
      `INSERT INTO optimization_runs
        (id, name, status, search_space, search_algorithm, n_trials_target,
         n_trials_done, rng_seed, cv_strategy, data_filters,
         notify_on_complete, created_by)
       VALUES
        ($1, $2, 'queued', '{"dimensions":[]}'::jsonb, 'ensemble', 20,
         0, 42, $3::jsonb, '{}'::jsonb,
         true, 'manual:smoke-test')`,
      [
        runId,
        name,
        JSON.stringify({
          type: "cpcv",
          n_groups: 6,
          n_test_groups: 2,
          embargo_pct: 0.01,
        }),
      ],
    );

    console.log(`▶ Kicking sidecar at ${OPTIMIZER_URL}/run/start …`);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (OPTIMIZER_TOKEN) headers["X-Optimizer-Token"] = OPTIMIZER_TOKEN;
    const res = await fetch(`${OPTIMIZER_URL}/run/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({ run_id: runId }),
    });
    const text = await res.text();
    console.log(`  sidecar response: ${res.status} ${text.slice(0, 200)}`);
    if (!res.ok) throw new Error(`Sidecar returned ${res.status}: ${text}`);

    console.log(`▶ Polling every ${POLL_INTERVAL_MS / 1000}s …`);
    const deadline = Date.now() + MAX_WAIT_MS;
    let lastStatus = "";
    let lastDone = -1;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const { rows } = await client.query<RunRow>(
        `SELECT id, status, n_trials_done, n_trials_target,
                started_at, completed_at, error, summary
         FROM optimization_runs WHERE id = $1`,
        [runId],
      );
      const row = rows[0];
      if (!row) {
        console.log("  [row vanished]");
        break;
      }
      if (row.status !== lastStatus || row.n_trials_done !== lastDone) {
        const ts = new Date().toISOString().slice(11, 19);
        console.log(
          `  ${ts} · status=${row.status} · trials=${row.n_trials_done}/${row.n_trials_target}` +
            (row.started_at ? ` · started_at=${row.started_at}` : ""),
        );
        lastStatus = row.status;
        lastDone = row.n_trials_done;
      }
      if (
        row.status === "completed" ||
        row.status === "failed" ||
        row.status === "cancelled"
      ) {
        console.log("\n──── Final state ────");
        console.log(`  status:      ${row.status}`);
        console.log(
          `  trials:      ${row.n_trials_done} / ${row.n_trials_target}`,
        );
        console.log(`  started_at:  ${row.started_at ?? "(never)"}`);
        console.log(`  completed:   ${row.completed_at ?? "(never)"}`);
        if (row.error) console.log(`  error:       ${row.error.slice(0, 400)}`);
        if (row.summary)
          console.log(
            `  summary:     ${JSON.stringify(row.summary).slice(0, 400)}`,
          );
        if (row.status === "completed") {
          console.log("\n✅ Success");
          process.exit(0);
        } else {
          console.log("\n❌ Not completed — investigate sidecar logs");
          process.exit(1);
        }
      }
    }

    console.log("\n⏱ Timed out waiting for completion.");
    process.exit(2);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
