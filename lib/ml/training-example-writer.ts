/**
 * ML Training Example Writer
 *
 * Decouples ML training data from the operational bets table.
 * Converts settled bets into labeled training examples stored in
 * the `ml_training_examples` table, which the Python training
 * pipeline reads directly.
 *
 * Example types:
 *   - settled_detected: detected value bet that eventually settled
 *   - placed_settled: actually placed bet with real outcome
 *   - near_miss: sub-threshold edge (Phase 9, survival bias)
 *   - shadow_scored: feature snapshot at detection (outcome later)
 */

import { db } from "@/lib/db/client";
import { mlTrainingExamples, type BetRow } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { logger } from "@/lib/shared/logger";
import { ML_FEATURE_VERSION } from "@/lib/shared/constants";

const tag = "TrainingExampleWriter";

type ExampleType = "settled_detected" | "placed_settled" | "near_miss" | "shadow_scored";

/**
 * Derive label from bet outcome.
 *   won, half_won → positive
 *   lost, half_lost → negative
 *   void → excluded (returns null)
 */
function deriveLabel(outcome: string): "positive" | "negative" | null {
  switch (outcome) {
    case "won":
    case "half_won":
      return "positive";
    case "lost":
    case "half_lost":
      return "negative";
    default:
      return null; // void, pending, cancelled — excluded
  }
}

/** PnL-magnitude boost scale and cap — must match Python _pnl_boost(). */
const PNL_BOOST_SCALE = 5.0;
const PNL_BOOST_CAP = 2.0;

/**
 * Multiplicative boost from absolute PnL — higher impact → more weight.
 * Returns a multiplier in [1.0, PNL_BOOST_CAP]. Zero PnL → 1.0.
 */
function pnlBoost(pnlAbs: number): number {
  if (pnlAbs <= 0) return 1.0;
  const boost = 1.0 + Math.log1p(pnlAbs / PNL_BOOST_SCALE) * 0.3;
  return Math.min(boost, PNL_BOOST_CAP);
}

/**
 * Derive sample weight from outcome, example type, and PnL magnitude.
 *
 * Weight formula:
 *   base = 0.4 for near_miss, 0.5 for half outcomes, 1.0 otherwise
 *   boost = pnlBoost(|pnl|)
 *   final = base × boost
 *
 * Shadow-scored examples start at 1.0 (adjusted when resolved).
 */
function deriveSampleWeight(outcome: string, exampleType: ExampleType, pnl: number | null): number {
  if (exampleType === "near_miss") return 0.4;
  let base: number;
  switch (outcome) {
    case "half_won":
    case "half_lost":
      base = 0.5;
      break;
    default:
      base = 1.0;
  }
  return base * pnlBoost(Math.abs(pnl ?? 0));
}

/**
 * Write training examples from settled bets.
 *
 * Called after settlement outcomes are applied. Only creates examples
 * for bets that have features and a non-void outcome.
 *
 * @param settledBets - Bet rows that just had their outcome set.
 * @returns Number of examples written.
 */
export async function writeSettledExamples(settledBets: BetRow[]): Promise<number> {
  let written = 0;

  for (const bet of settledBets) {
    // Skip bets without features — can't train on them
    if (!bet.mlFeatures || bet.mlFeatures.length === 0) continue;

    const label = deriveLabel(bet.outcome);
    if (label === null) continue; // void/pending — skip

    const exampleType: ExampleType = bet.placedAt ? "placed_settled" : "settled_detected";

    try {
      await db
        .insert(mlTrainingExamples)
        .values({
          sourceBetId: bet.id,
          exampleType,
          eventId: bet.eventId,
          familyId: bet.familyId,
          atomId: bet.atomId,
          features: bet.mlFeatures,
          featureVersion: bet.mlFeatureVersion ?? ML_FEATURE_VERSION,
          label,
          labelSource: "outcome",
          sampleWeight: deriveSampleWeight(bet.outcome, exampleType, bet.pnl),
          outcome: bet.outcome,
          pnl: bet.pnl,
          clvPct: bet.clvPct,
          settledAt: bet.settledAt,
        })
        .onConflictDoNothing();
      written++;
    } catch (err) {
      logger.warn(tag, `Failed to write example for ${bet.id}: ${(err as Error).message}`);
    }
  }

  if (written > 0) {
    logger.info(tag, `Wrote ${written}/${settledBets.length} training examples`);
  }

  return written;
}

/**
 * Write a shadow-scored detection snapshot.
 *
 * Called at detection time to capture the feature state. The outcome
 * and label are null — they get attached when the bet settles via
 * `resolveDetectionSnapshot()`.
 */
export async function writeDetectionSnapshot(
  betId: string,
  eventId: string,
  familyId: string,
  atomId: string,
  features: number[],
): Promise<void> {
  try {
    await db
      .insert(mlTrainingExamples)
      .values({
        sourceBetId: betId,
        exampleType: "shadow_scored" as ExampleType,
        eventId,
        familyId,
        atomId,
        features,
        featureVersion: ML_FEATURE_VERSION,
        label: null,
        labelSource: null,
        sampleWeight: 1.0,
        outcome: null,
        pnl: null,
        clvPct: null,
        settledAt: null,
      })
      .onConflictDoNothing();
  } catch (err) {
    logger.warn(tag, `Failed to write detection snapshot for ${betId}: ${(err as Error).message}`);
  }
}

/**
 * Resolve a previously written detection snapshot with its settlement outcome.
 *
 * Finds the most recent shadow_scored example for the bet and updates
 * it with the outcome, label, and weight.
 */
export async function resolveDetectionSnapshot(
  betId: string,
  outcome: string,
  pnl: number | null,
  clvPct: number | null,
  settledAt: string | null,
): Promise<void> {
  const label = deriveLabel(outcome);
  if (label === null) return; // void — don't resolve

  try {
    // Find the latest shadow_scored example for this bet
    const [existing] = await db
      .select({ id: mlTrainingExamples.id })
      .from(mlTrainingExamples)
      .where(
        and(
          eq(mlTrainingExamples.sourceBetId, betId),
          eq(mlTrainingExamples.exampleType, "shadow_scored"),
        ),
      )
      .orderBy(desc(mlTrainingExamples.createdAt))
      .limit(1);

    if (!existing) return;

    await db
      .update(mlTrainingExamples)
      .set({
        label,
        labelSource: "outcome",
        sampleWeight: deriveSampleWeight(outcome, "shadow_scored", pnl),
        outcome,
        pnl,
        clvPct,
        settledAt,
      })
      .where(eq(mlTrainingExamples.id, existing.id));
  } catch (err) {
    logger.warn(tag, `Failed to resolve snapshot for ${betId}: ${(err as Error).message}`);
  }
}

/**
 * Write near-miss examples from sub-threshold edges.
 *
 * Phase 9: Near-miss bets are atoms with NEAR_MISS_MIN_EV_PCT ≤ EV% < MIN_EV_PCT.
 * They're stored as lower-weight negatives to reduce survival bias —
 * the model learns what "almost good enough" looks like, not just
 * what cleared the threshold.
 *
 * Labels are set to "negative" immediately (not pending) with
 * labelSource="near_miss" and weight=0.4. The outcome is unknown at
 * collection time, but these bets weren't placed, so we label them
 * as negatives by design (they didn't meet the value threshold).
 *
 * Uses onConflictDoNothing keyed on sourceBetId to naturally rate-limit:
 * the same bet key can only produce one near-miss row. The caller
 * handles per-pass caps and cooldown timing.
 *
 * @param nearMisses - Near-miss bets with extracted features.
 * @returns Number of examples written.
 */
export async function writeNearMissExamples(
  nearMisses: Array<{
    id: string;       // deterministic bet key: eventId|familyId|atomId
    eventId: string;
    familyId: string;
    atomId: string;
    features: number[];
  }>,
): Promise<number> {
  let written = 0;

  for (const nm of nearMisses) {
    if (!nm.features || nm.features.length === 0) continue;

    try {
      await db
        .insert(mlTrainingExamples)
        .values({
          sourceBetId: nm.id,
          exampleType: "near_miss" as ExampleType,
          eventId: nm.eventId,
          familyId: nm.familyId,
          atomId: nm.atomId,
          features: nm.features,
          featureVersion: ML_FEATURE_VERSION,
          label: "negative",
          labelSource: "near_miss",
          sampleWeight: 0.4,
          outcome: null,
          pnl: null,
          clvPct: null,
          settledAt: null,
        })
        .onConflictDoNothing();
      written++;
    } catch (err) {
      logger.warn(tag, `Failed to write near-miss for ${nm.id}: ${(err as Error).message}`);
    }
  }

  if (written > 0) {
    logger.info(tag, `Wrote ${written}/${nearMisses.length} near-miss examples`);
  }

  return written;
}
