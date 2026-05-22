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
 *   - shadow_scored: feature snapshot at detection (outcome later)
 *
 * Uniqueness:
 *   - Rows with source_bet_id: unique on (source_bet_id, example_type)
 *   - Rows without source_bet_id: unique on (event_id, family_id, atom_id, example_type)
 *
 * Notes:
 *   - Uses shared outcomes module for label derivation and weights
 *   - Computes unit returns for financial metrics
 *   - Writer counts only increment on actual DB changes
 */

import { db } from "@/lib/db/client";
import { bets, mlTrainingExamples, type BetRow } from "@/lib/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { logger } from "@/lib/shared/logger";
import { ML_FEATURE_COUNT, ML_FEATURE_VERSION } from "@/lib/shared/constants";
import { FEATURE_NAMES_HASH } from "@/lib/ml/feature-contract";
import {
  computeUnitReturn,
  deriveLabel,
  deriveSampleWeight,
  type ExampleType,
} from "@/lib/ml/outcomes";

const tag = "TrainingExampleWriter";

const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === "23505" || e.cause?.code === "23505";
};

/**
 * Write training examples from settled bets.
 *
 * Called after settlement outcomes are applied. Only creates examples
 * for bets that have features and a non-void outcome.
 *
 * Uses ON CONFLICT on (source_bet_id, example_type) unique index to
 * prevent duplicate rows. If a row already exists for the same bet+type,
 * the insert is skipped (settled data doesn't change once written).
 *
 * Also stores unit_return for simulated financial metrics.
 *
 * @param settledBets - Bet rows that just had their outcome set.
 * @returns Number of examples actually written (not skipped).
 */
export async function writeSettledExamples(
  settledBets: BetRow[],
): Promise<number> {
  let written = 0;

  for (const bet of settledBets) {
    // Skip bets without features — can't train on them
    if (!bet.mlFeatures || bet.mlFeatures.length === 0) continue;

    const label = deriveLabel(bet.outcome);
    if (label === null) continue; // void/pending — skip

    const exampleType: ExampleType = bet.placedAt
      ? "placed_settled"
      : "settled_detected";
    const unitReturn = computeUnitReturn(
      bet.outcome,
      Number(bet.softOdds ?? 0),
      Number(bet.softCommissionPct ?? 0),
    );

    try {
      const [existing] = await db
        .select({
          id: mlTrainingExamples.id,
          featureVersion: mlTrainingExamples.featureVersion,
          features: mlTrainingExamples.features,
        })
        .from(mlTrainingExamples)
        .where(
          and(
            eq(mlTrainingExamples.sourceBetId, bet.id),
            eq(mlTrainingExamples.exampleType, exampleType),
          ),
        )
        .limit(1);

      const featureVersion = bet.mlFeatureVersion ?? ML_FEATURE_VERSION;
      const featureCount = bet.mlFeatures.length;
      const sampleWeight = deriveSampleWeight(bet.outcome, unitReturn);

      if (existing) {
        const alreadyCurrent =
          existing.featureVersion === featureVersion &&
          Array.isArray(existing.features) &&
          existing.features.length === featureCount;
        if (alreadyCurrent) continue;

        const result = await db
          .update(mlTrainingExamples)
          .set({
            eventId: bet.eventId,
            familyId: bet.familyId,
            atomId: bet.atomId,
            features: bet.mlFeatures,
            featureVersion,
            label,
            labelSource: "outcome",
            sampleWeight,
            outcome: bet.outcome,
            pnl: bet.pnl,
            clvPct: bet.clvPct,
            settledAt: bet.settledAt,
          })
          .where(eq(mlTrainingExamples.id, existing.id))
          .returning({ id: mlTrainingExamples.id });
        if (result.length > 0) {
          written++;
        }
        continue;
      }

      const result = await db
        .insert(mlTrainingExamples)
        .values({
          sourceBetId: bet.id,
          exampleType,
          eventId: bet.eventId,
          familyId: bet.familyId,
          atomId: bet.atomId,
          features: bet.mlFeatures,
          featureVersion,
          label,
          labelSource: "outcome",
          sampleWeight,
          outcome: bet.outcome,
          pnl: bet.pnl,
          clvPct: bet.clvPct,
          settledAt: bet.settledAt,
        })
        .returning({ id: mlTrainingExamples.id });
      if (result.length > 0) {
        written++;
      }
    } catch (err) {
      if (isUniqueViolation(err)) continue;
      logger.warn(
        tag,
        `Failed to write example for ${bet.id}: ${(err as Error).message}`,
      );
    }
  }

  if (written > 0) {
    logger.info(
      tag,
      `Wrote ${written}/${settledBets.length} training examples`,
    );
  }

  return written;
}

export async function writeMissingSettledExamples(
  limit = 1000,
): Promise<number> {
  const missing = await db
    .select()
    .from(bets)
    .where(
      sql`
      ${bets.outcome} NOT IN ('pending', 'void')
      AND ${bets.mlFeatures} IS NOT NULL
      AND ${bets.mlFeatureVersion} = ${ML_FEATURE_VERSION}
      AND ${bets.mlFeatureNamesHash} = ${FEATURE_NAMES_HASH}
      AND array_length(${bets.mlFeatures}, 1) = ${ML_FEATURE_COUNT}
      AND NOT EXISTS (
        SELECT 1
        FROM ${mlTrainingExamples} m
        WHERE m.source_bet_id = ${bets.id}
          AND m.example_type IN ('placed_settled', 'settled_detected')
          AND m.label IS NOT NULL
          AND m.features IS NOT NULL
          AND m.feature_version = ${ML_FEATURE_VERSION}
          AND array_length(m.features, 1) = ${ML_FEATURE_COUNT}
      )
    `,
    )
    .orderBy(bets.settledAt, bets.firstSeenAt)
    .limit(limit);

  if (missing.length === 0) return 0;

  const written = await writeSettledExamples(missing);
  if (written > 0) {
    logger.info(
      tag,
      `Reconciled ${written}/${missing.length} missing settled training examples`,
    );
  }
  return written;
}

export async function reconcileMissingSettledExamples(
  batchSize = 500,
  writeBatch: (limit?: number) => Promise<number> = writeMissingSettledExamples,
): Promise<number> {
  let totalWritten = 0;

  while (true) {
    const written = await writeBatch(batchSize);
    totalWritten += written;
    if (written === 0) break;
  }

  if (totalWritten > 0) {
    logger.info(
      tag,
      `Reconciled ${totalWritten} missing settled training examples`,
    );
  }

  return totalWritten;
}

/**
 * Write a shadow-scored detection snapshot.
 *
 * Called at detection time to capture the feature state. The outcome
 * and label are null — they get attached when the bet settles via
 * `resolveDetectionSnapshot()`.
 *
 * Uses ON CONFLICT on (source_bet_id, example_type) to upsert: if a
 * shadow_scored row already exists for this bet, update the features
 * to the latest snapshot (features change as odds move).
 */
export async function writeDetectionSnapshot(
  betId: string,
  eventId: string,
  familyId: string,
  atomId: string,
  features: number[],
): Promise<void> {
  try {
    const updated = await db
      .update(mlTrainingExamples)
      .set({
        features,
        featureVersion: ML_FEATURE_VERSION,
      })
      .where(
        and(
          eq(mlTrainingExamples.sourceBetId, betId),
          eq(mlTrainingExamples.exampleType, "shadow_scored"),
        ),
      )
      .returning({ id: mlTrainingExamples.id });

    if (updated.length > 0) return;

    try {
      await db.insert(mlTrainingExamples).values({
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
      });
    } catch (insertErr) {
      if (!isUniqueViolation(insertErr)) throw insertErr;
      await db
        .update(mlTrainingExamples)
        .set({
          features,
          featureVersion: ML_FEATURE_VERSION,
        })
        .where(
          and(
            eq(mlTrainingExamples.sourceBetId, betId),
            eq(mlTrainingExamples.exampleType, "shadow_scored"),
          ),
        );
    }
  } catch (err) {
    logger.warn(
      tag,
      `Failed to write detection snapshot for ${betId}: ${(err as Error).message}`,
    );
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
  softOdds: number | null,
  softCommissionPct: number | null,
  pnl: number | null,
  clvPct: number | null,
  settledAt: string | null,
): Promise<void> {
  const label = deriveLabel(outcome);
  if (label === null) return; // void — don't resolve

  try {
    const unitReturn = computeUnitReturn(
      outcome,
      Number(softOdds ?? 0),
      Number(softCommissionPct ?? 0),
    );

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
        sampleWeight: deriveSampleWeight(outcome, unitReturn),
        outcome,
        pnl,
        clvPct,
        settledAt,
      })
      .where(eq(mlTrainingExamples.id, existing.id));
  } catch (err) {
    logger.warn(
      tag,
      `Failed to resolve snapshot for ${betId}: ${(err as Error).message}`,
    );
  }
}
