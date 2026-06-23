
import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bets } from "@/lib/db/schema";
import { getOdds } from "@/lib/atoms/store";
import { logger } from "@/lib/shared/logger";
import { adjustOddsForCommission } from "@/lib/shared/commission";

const WINDOW_BEFORE_KICKOFF_MS = 30 * 60 * 1000;
const WINDOW_AFTER_KICKOFF_MS = 5 * 60 * 1000;
const MAX_SNAPSHOT_AGE_MS = 5 * 60 * 1000;

export type CaptureResult = {
  eligible: number;
  captured: number;
  skippedStale: number;
  skippedMissing: number;
};

export async function captureClosingOdds(): Promise<CaptureResult> {
  const now = Date.now();
  const lowerIso = new Date(now - WINDOW_AFTER_KICKOFF_MS).toISOString();
  const upperIso = new Date(now + WINDOW_BEFORE_KICKOFF_MS).toISOString();

  const candidates = await db
    .select({
      id: bets.id,
      eventId: bets.eventId,
      familyId: bets.familyId,
      atomId: bets.atomId,
      sharpProvider: bets.sharpProvider,
      softProvider: bets.softProvider,
      softOdds: bets.softOdds,
      softCommissionPct: bets.softCommissionPct,
      odds: bets.odds, // placed odds (null if not placed)
      placedAt: bets.placedAt, // non-null if placed
    })
    .from(bets)
    .where(
      and(
        gte(bets.eventStartTime, lowerIso),
        lte(bets.eventStartTime, upperIso),
      ),
    )
    .limit(1000);

  const result: CaptureResult = {
    eligible: candidates.length,
    captured: 0,
    skippedStale: 0,
    skippedMissing: 0,
  };

  for (const row of candidates) {
    const sharpSnap = getOdds(
      row.eventId,
      row.familyId,
      row.atomId,
      row.sharpProvider as Parameters<typeof getOdds>[3],
    );
    if (!sharpSnap) {
      result.skippedMissing++;
      continue;
    }
    if (now - sharpSnap.timestamp > MAX_SNAPSHOT_AGE_MS) {
      result.skippedStale++;
      continue;
    }

    const closingSharp = sharpSnap.odds;
    let clvPct: number | null = null;
    if (closingSharp > 0) {
      if (row.placedAt && row.odds) {
        clvPct = Number(
          ((Number(row.odds) / closingSharp - 1) * 100).toFixed(2),
        );
      } else if (row.softOdds) {
        const commission = Number(row.softCommissionPct ?? 0);
        const adjSoftOdds = adjustOddsForCommission(
          Number(row.softOdds),
          commission,
        );
        clvPct = Number(((adjSoftOdds / closingSharp - 1) * 100).toFixed(2));
      }
    }

    await db
      .update(bets)
      .set({
        closingSharpOdds: closingSharp,
        clvPct,
      })
      .where(eq(bets.id, row.id));

    result.captured++;
  }

  if (result.eligible > 0) {
    logger.info(
      "ClosingCapture",
      `Captured ${result.captured}/${result.eligible} closing snapshots ` +
        `(stale=${result.skippedStale}, missing=${result.skippedMissing})`,
    );
  }

  return result;
}
