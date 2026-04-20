/**
 * Closing-odds capture.
 *
 * For each value_bet whose kickoff is within the capture window, snapshot the
 * freshest Pinnacle (and soft) odds from the in-memory atoms store and
 * persist them as the "closing" reference. Runs every odds sync cycle.
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
 * Why the capture diverged from previous ±5 min / 3 min behaviour: coverage
 * was only ~34% on settled pre-match rows. Widening the window and allowing
 * overwrites drives coverage up without sacrificing signal quality (the
 * final value still converges to the latest available snapshot).
 */

import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { valueBets } from "@/lib/db/schema";
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
      id: valueBets.id,
      eventId: valueBets.eventId,
      familyId: valueBets.familyId,
      atomId: valueBets.atomId,
      sharpProvider: valueBets.sharpProvider,
      softProvider: valueBets.softProvider,
    })
    .from(valueBets)
    .where(
      and(
        gte(valueBets.eventStartTime, lowerIso),
        lte(valueBets.eventStartTime, upperIso),
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

    const softSnap = getOdds(
      row.eventId,
      row.familyId,
      row.atomId,
      row.softProvider as Parameters<typeof getOdds>[3],
    );

    await db
      .update(valueBets)
      .set({
        closingSharpOdds: sharpSnap.odds,
        closingSoftOdds:
          softSnap && now - softSnap.timestamp <= MAX_SNAPSHOT_AGE_MS
            ? softSnap.odds
            : null,
        closingCapturedAt: new Date().toISOString(),
      })
      .where(eq(valueBets.id, row.id));

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
