/**
 * Run scripts/ml-rebuild-residual-cleanup.sql in a single transaction.
 *
 * Mirrors the SQL exactly: BEFORE counts → DELETE/UPDATE → AFTER counts.
 * Commits only if the AFTER counts match the documented expected deltas.
 * Otherwise rolls back and prints the discrepancy.
 *
 * Run from repo root:
 *   node --import tsx scripts/run-ml-residual-cleanup.ts
 */

import "dotenv/config";
import { ensureDbReady, db } from "@/lib/db/client";
import { sql } from "drizzle-orm";

interface Counts {
  beforeMlModels: number;
  beforeMlModelsFv3: number;
  beforeTrainingExamples: number;
  beforeTrainingExamplesFv3: number;
  beforeBetsFv3WithFeatures: number;
  beforeBetsFv1WithFeatures: number;
}

async function main(): Promise<void> {
  await ensureDbReady();

  const result = await db.transaction(async (tx) => {
    // ── BEFORE ──
    const before: Counts = {
      beforeMlModels: await scalar(tx, sql`SELECT count(*)::int AS n FROM ml_models`),
      beforeMlModelsFv3: await scalar(tx, sql`SELECT count(*)::int AS n FROM ml_models WHERE feature_version <> 1`),
      beforeTrainingExamples: await scalar(tx, sql`SELECT count(*)::int AS n FROM ml_training_examples`),
      beforeTrainingExamplesFv3: await scalar(tx, sql`SELECT count(*)::int AS n FROM ml_training_examples WHERE feature_version <> 1`),
      beforeBetsFv3WithFeatures: await scalar(tx, sql`SELECT count(*)::int AS n FROM bets WHERE ml_features IS NOT NULL AND ml_feature_version <> 1`),
      beforeBetsFv1WithFeatures: await scalar(tx, sql`SELECT count(*)::int AS n FROM bets WHERE ml_features IS NOT NULL AND ml_feature_version = 1`),
    };

    console.log("BEFORE:");
    for (const [k, v] of Object.entries(before)) console.log(`  ${k}=${v}`);

    // ── 1. ml_models pre-rebuild ghost(s) ──
    const deletedModels = await scalar(tx, sql`
      WITH d AS (DELETE FROM ml_models WHERE feature_version <> 1 RETURNING 1)
      SELECT count(*)::int AS n FROM d
    `);

    // ── 2. legacy ml_training_examples ──
    const deletedExamples = await scalar(tx, sql`
      WITH d AS (DELETE FROM ml_training_examples WHERE feature_version <> 1 RETURNING 1)
      SELECT count(*)::int AS n FROM d
    `);

    // ── 3. clear ml_features* on v3 bets ──
    const updatedBets = await scalar(tx, sql`
      WITH u AS (
        UPDATE bets
        SET ml_features = NULL,
            ml_feature_version = NULL,
            ml_feature_count = NULL,
            ml_feature_names_hash = NULL,
            ml_score = NULL,
            ml_stake_fraction = NULL
        WHERE ml_features IS NOT NULL
          AND ml_feature_version <> 1
        RETURNING 1
      )
      SELECT count(*)::int AS n FROM u
    `);

    console.log("MUTATIONS:");
    console.log(`  ml_models deleted=${deletedModels}`);
    console.log(`  ml_training_examples deleted=${deletedExamples}`);
    console.log(`  bets cleared=${updatedBets}`);

    // ── AFTER ──
    const afterMlModels = await scalar(tx, sql`SELECT count(*)::int AS n FROM ml_models`);
    const afterTrainingExamples = await scalar(tx, sql`SELECT count(*)::int AS n FROM ml_training_examples`);
    const afterTrainingExamplesFv1 = await scalar(tx, sql`SELECT count(*)::int AS n FROM ml_training_examples WHERE feature_version = 1`);
    const afterBetsFv1WithFeatures = await scalar(tx, sql`SELECT count(*)::int AS n FROM bets WHERE ml_features IS NOT NULL AND ml_feature_version = 1`);
    const afterBetsAnyWithFeatures = await scalar(tx, sql`SELECT count(*)::int AS n FROM bets WHERE ml_features IS NOT NULL`);

    console.log("AFTER:");
    console.log(`  afterMlModels=${afterMlModels}`);
    console.log(`  afterTrainingExamples=${afterTrainingExamples}`);
    console.log(`  afterTrainingExamplesFv1=${afterTrainingExamplesFv1}`);
    console.log(`  afterBetsFv1WithFeatures=${afterBetsFv1WithFeatures}`);
    console.log(`  afterBetsAnyWithFeatures=${afterBetsAnyWithFeatures}`);

    // ── Invariants ──
    const errors: string[] = [];

    // 1. Deleting fv!=1 ml_models must not lose any fv=1 model rows
    //    (we have no fv=1 models yet, so afterMlModels = before - beforeFv3).
    const expectedAfterMlModels = before.beforeMlModels - before.beforeMlModelsFv3;
    if (afterMlModels !== expectedAfterMlModels) {
      errors.push(`ml_models invariant: after=${afterMlModels}, expected=${expectedAfterMlModels}`);
    }

    // 2. Training examples: only fv=1 should remain.
    if (afterTrainingExamples !== afterTrainingExamplesFv1) {
      errors.push(`ml_training_examples still has non-fv1 rows: total=${afterTrainingExamples}, fv1=${afterTrainingExamplesFv1}`);
    }
    const expectedAfterExamples = before.beforeTrainingExamples - before.beforeTrainingExamplesFv3;
    if (afterTrainingExamples !== expectedAfterExamples) {
      errors.push(`ml_training_examples invariant: after=${afterTrainingExamples}, expected=${expectedAfterExamples}`);
    }

    // 3. The protected v=1 corpus must be untouched.
    if (afterBetsFv1WithFeatures !== before.beforeBetsFv1WithFeatures) {
      errors.push(`v=1 corpus changed: before=${before.beforeBetsFv1WithFeatures}, after=${afterBetsFv1WithFeatures}`);
    }

    // 4. After cleanup, every bet with features must be fv=1.
    if (afterBetsAnyWithFeatures !== afterBetsFv1WithFeatures) {
      errors.push(`bets still carry non-fv1 features: total=${afterBetsAnyWithFeatures}, fv1=${afterBetsFv1WithFeatures}`);
    }

    // 5. Mutation counts must match the deltas observed.
    if (deletedModels !== before.beforeMlModelsFv3) {
      errors.push(`deleted ml_models mismatch: deleted=${deletedModels}, expected=${before.beforeMlModelsFv3}`);
    }
    if (deletedExamples !== before.beforeTrainingExamplesFv3) {
      errors.push(`deleted ml_training_examples mismatch: deleted=${deletedExamples}, expected=${before.beforeTrainingExamplesFv3}`);
    }
    if (updatedBets !== before.beforeBetsFv3WithFeatures) {
      errors.push(`cleared bets mismatch: cleared=${updatedBets}, expected=${before.beforeBetsFv3WithFeatures}`);
    }

    if (errors.length > 0) {
      console.error("INVARIANT VIOLATIONS — rolling back:");
      for (const e of errors) console.error(`  ✗ ${e}`);
      throw new Error("residual cleanup invariants violated");
    }

    console.log("INVARIANTS OK — committing");
    return { deletedModels, deletedExamples, updatedBets };
  });

  console.log("COMMITTED:", result);
  process.exit(0);
}

async function scalar(
  tx: { execute: typeof db.execute },
  query: ReturnType<typeof sql>,
): Promise<number> {
  const r = await tx.execute(query);
  const row = r.rows[0] as Record<string, unknown> | undefined;
  const n = row?.n;
  return typeof n === "number" ? n : Number(n ?? 0);
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
