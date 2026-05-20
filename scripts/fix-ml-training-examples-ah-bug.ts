/**
 * Fix ml_training_examples rows that still have wrong labels from the
 * away-handicap settlement bug (fixed in lib/settle/settle-bet.ts).
 *
 * Problem: the backfill (resettle-away-handicap-fix.ts) corrected 537 bet
 * outcomes via applySettlementOutcomes, which calls writeSettledExamples().
 * But writeSettledExamples() skips existing rows (unique on
 * source_bet_id + example_type), so the primary settled_detected /
 * placed_settled examples retained the old wrong label.
 *
 * This script finds all ml_training_examples rows whose source bet was
 * corrected (settled_by_source ending in "+ah-fix-2026-05") and updates
 * them from the current (correct) bets row.
 *
 *   npx tsx scripts/fix-ml-training-examples-ah-bug.ts            # dry-run
 *   npx tsx scripts/fix-ml-training-examples-ah-bug.ts --execute  # apply
 */

import "dotenv/config";
import { ensureDbReady, db } from "../lib/db/client";
import { bets, mlTrainingExamples } from "../lib/db/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import { deriveLabel, deriveSampleWeight, type ExampleType } from "../lib/ml/outcomes";

const EXECUTE = process.argv.includes("--execute");

interface AffectedRow {
  exampleId: number;
  betId: string;
  exampleType: string;
  oldLabel: string | null;
  oldOutcome: string | null;
  newLabel: string | null;
  newOutcome: string | null;
}

async function main(): Promise<void> {
  await ensureDbReady();

  console.log(`[fix-ml-training-examples] mode=${EXECUTE ? "EXECUTE" : "DRY-RUN"}`);

  // 1. Find all bets corrected by the AH fix backfill
  const correctedBets = await db
    .select({
      id: bets.id,
      outcome: bets.outcome,
      pnl: bets.pnl,
      clvPct: bets.clvPct,
      settledAt: bets.settledAt,
      placedAt: bets.placedAt,
      settledBySource: bets.settledBySource,
    })
    .from(bets)
    .where(
      and(
        sql`${bets.settledBySource} LIKE '%+ah-fix-2026-05'`,
        sql`${bets.outcome} IN ('won','lost','half_won','half_lost','void')`,
      ),
    );

  if (correctedBets.length === 0) {
    console.log("[fix-ml-training-examples] no corrected bets found — nothing to do.");
    process.exit(0);
  }

  console.log(
    `[fix-ml-training-examples] found ${correctedBets.length} bets with +ah-fix-2026-05 source`,
  );

  // 2. Find all ml_training_examples rows for these bets (any example type)
  const betIds = correctedBets.map((b) => b.id);
  const affectedExamples = await db
    .select()
    .from(mlTrainingExamples)
    .where(inArray(mlTrainingExamples.sourceBetId, betIds));

  console.log(
    `[fix-ml-training-examples] found ${affectedExamples.length} linked training examples`,
  );

  // 3. Cross-reference: which examples have wrong labels?
  const betById = new Map(correctedBets.map((b) => [b.id, b]));
  const diffs: AffectedRow[] = [];

  for (const ex of affectedExamples) {
    const bet = betById.get(ex.sourceBetId!);
    if (!bet) continue;

    const correctLabel = deriveLabel(bet.outcome!);
    const correctSampleWeight = bet.outcome
      ? deriveSampleWeight(bet.outcome, ex.exampleType as ExampleType, bet.pnl)
      : ex.sampleWeight;

    const needsFix =
      ex.outcome !== bet.outcome ||
      ex.label !== correctLabel ||
      ex.pnl !== bet.pnl ||
      ex.clvPct !== bet.clvPct ||
      ex.settledAt !== bet.settledAt;

    if (needsFix) {
      diffs.push({
        exampleId: ex.id,
        betId: ex.sourceBetId!,
        exampleType: ex.exampleType,
        oldLabel: ex.label,
        oldOutcome: ex.outcome,
        newLabel: correctLabel,
        newOutcome: bet.outcome!,
      });
    } else if (
      Math.abs((ex.sampleWeight ?? 0) - (correctSampleWeight ?? 0)) > 0.001
    ) {
      diffs.push({
        exampleId: ex.id,
        betId: ex.sourceBetId!,
        exampleType: ex.exampleType,
        oldLabel: ex.label,
        oldOutcome: ex.outcome,
        newLabel: correctLabel,
        newOutcome: bet.outcome!,
      });
    }
  }

  console.log(
    `[fix-ml-training-examples] training examples that need correction: ${diffs.length}`,
  );

  if (diffs.length === 0) {
    console.log("[fix-ml-training-examples] no corrections needed.");
    process.exit(0);
  }

  // 4. Distribution before vs after
  const beforeLabelDist: Record<string, number> = {};
  const afterLabelDist: Record<string, number> = {};
  for (const d of diffs) {
    if (d.oldLabel) beforeLabelDist[d.oldLabel] = (beforeLabelDist[d.oldLabel] ?? 0) + 1;
    if (d.newLabel) afterLabelDist[d.newLabel] = (afterLabelDist[d.newLabel] ?? 0) + 1;
  }
  console.log("\n[fix-ml-training-examples] label shifts:");
  console.log("  Before →", beforeLabelDist);
  console.log("  After  →", afterLabelDist);

  // Show sample
  const sample = diffs.slice(0, 5);
  if (sample.length > 0) {
    console.log("\n[fix-ml-training-examples] sample diffs (first 5):");
    for (const d of sample) {
      console.log(
        `  [${d.exampleType}] ${d.betId.slice(0, 40)}...  ` +
          `${d.oldOutcome}/${d.oldLabel} → ${d.newOutcome}/${d.newLabel}`,
      );
    }
  }

  if (!EXECUTE) {
    console.log(
      "\n[fix-ml-training-examples] DRY-RUN — no writes. " +
        "Re-run with --execute to apply.",
    );
    process.exit(0);
  }

  // 5. Apply corrections
  let updated = 0;
  for (const d of diffs) {
    const bet = betById.get(d.betId);
    if (!bet) continue;

    // Void bets: clear label/outcome (no predictive signal).  Non-void
    // bets: derive the correct label and sample weight from the bet row.
    const isVoid = bet.outcome === "void";
    const label = isVoid ? null : deriveLabel(bet.outcome!);
    const sampleWeight = isVoid
      ? 1.0
      : deriveSampleWeight(bet.outcome!, d.exampleType as ExampleType, bet.pnl);

    const [result] = await db
      .update(mlTrainingExamples)
      .set({
        label,
        outcome: bet.outcome,
        sampleWeight,
        pnl: isVoid ? null : bet.pnl,
        clvPct: bet.clvPct,
        settledAt: isVoid ? null : bet.settledAt,
      })
      .where(eq(mlTrainingExamples.id, d.exampleId))
      .returning({ id: mlTrainingExamples.id });
    if (result) updated++;
  }

  console.log(`\n[fix-ml-training-examples] corrected ${updated} training examples.`);

  // 6. Verify: count remaining mismatches
  const remaining = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(mlTrainingExamples)
    .innerJoin(bets, eq(mlTrainingExamples.sourceBetId, bets.id))
    .where(
      and(
        sql`${bets.settledBySource} LIKE '%+ah-fix-2026-05'`,
        sql`${mlTrainingExamples.label} IS NOT NULL`,
        sql`${mlTrainingExamples.label} !=
          CASE WHEN ${bets.outcome} IN ('won','half_won') THEN 'positive'
               WHEN ${bets.outcome} IN ('lost','half_lost') THEN 'negative'
               ELSE ${mlTrainingExamples.label} END`,
      ),
    );
  console.log(
    `[fix-ml-training-examples] remaining mismatches after fix: ${remaining[0].count}`,
  );

  // 7. Also fix shadow_scored rows that never got resolved (outcome=NULL
  //    but bet has settled). These are pre-shadow_scored-era bets.
  const unresolved = await db
    .select({ id: mlTrainingExamples.id, betOutcome: bets.outcome })
    .from(mlTrainingExamples)
    .innerJoin(bets, eq(mlTrainingExamples.sourceBetId, bets.id))
    .where(
      and(
        eq(mlTrainingExamples.exampleType, "shadow_scored"),
        sql`${mlTrainingExamples.outcome} IS NULL`,
        sql`${bets.outcome} IN ('won','lost','half_won','half_lost')`,
      ),
    );
  if (unresolved.length > 0) {
    console.log(
      `\n[fix-ml-training-examples] resolving ${unresolved.length} unresolved shadow_scored snapshots...`,
    );
    for (const row of unresolved) {
      const label =
        row.betOutcome === "won" || row.betOutcome === "half_won"
          ? "positive"
          : "negative";
      await db
        .update(mlTrainingExamples)
        .set({ outcome: row.betOutcome, label })
        .where(eq(mlTrainingExamples.id, row.id));
    }
    console.log(
      `[fix-ml-training-examples] resolved ${unresolved.length} shadow_scored snapshots.`,
    );
  }

  console.log(
    "\nNext step: retrain the model. Either wait for the auto-retrain " +
      "scheduler or POST /api/ml/retrain.",
  );
  console.log("\n[fix-ml-training-examples] done.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[fix-ml-training-examples] FAILED:", err);
    process.exit(1);
  });
