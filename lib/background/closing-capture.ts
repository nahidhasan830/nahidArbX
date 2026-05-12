/**
 * Closing-odds capture.
 *
 * For each bet whose kickoff is within the capture window, snapshot the
 * freshest Pinnacle (and soft) odds from the in-memory atoms store and
 * persist them as the "closing" reference. Runs every heartbeat cycle.
 *
 * Semantics:
 *
 * - Window: 30 min BEFORE kickoff up to 5 min AFTER. A wider pre-kickoff
 *   window increases the chance of catching a fresh snapshot; the narrow
 *   post-kickoff tail accommodates events that kick off between sync cycles.
 *
 * - Overwrite: each successful capture REPLACES any prior capture for the
 *   row. The final persisted value is the most-recent snapshot observed
 *   before the window closes — i.e. the closest-to-kickoff data we had
 *   access to. This is preferable to "first capture wins" because snapshots
 *   continue to sharpen as kickoff approaches.
 *
 * - Staleness: snapshots older than MAX_SNAPSHOT_AGE_MS (5 min) are
 *   rejected. With a 60s sync cadence this tolerates up to 4 consecutive
 *   fetch failures before skipping a capture attempt.
 *
 * - CLV computation: CLV% is computed for ALL bets, not just placed ones.
 *   For placed bets: (placedOdds / closingSharpOdds - 1) * 100.
 *   For non-placed bets: (softOdds * (1 - commission/100) / closingSharpOdds - 1) * 100.
 *   This tells us whether the bet had genuine edge at detection time,
 *   regardless of whether it was actually placed.
 */

import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bets } from "@/lib/db/schema";
import { getOdds } from "@/lib/atoms/store";
import { logger } from "@/lib/shared/logger";

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
      odds: bets.odds,         // placed odds (null if not placed)
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

    // Compute CLV% using the best available odds for this bet.
    // Placed bets: use actual placed odds (current.odds).
    // Non-placed bets: use commission-adjusted soft odds at detection.
    const closingSharp = sharpSnap.odds;
    let clvPct: number | null = null;
    if (closingSharp > 0) {
      if (row.placedAt && row.odds) {
        // Placed bet: CLV = (placedOdds / closingSharp - 1) * 100
        clvPct = Number(
          ((Number(row.odds) / closingSharp - 1) * 100).toFixed(2),
        );
      } else if (row.softOdds) {
        // Non-placed bet: CLV = (adjSoftOdds / closingSharp - 1) * 100
        const commission = Number(row.softCommissionPct ?? 0);
        const adjSoftOdds = Number(row.softOdds) * (1 - commission / 100);
        clvPct = Number(
          ((adjSoftOdds / closingSharp - 1) * 100).toFixed(2),
        );
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
