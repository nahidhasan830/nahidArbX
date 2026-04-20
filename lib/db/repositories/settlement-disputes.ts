/**
 * Repository for settlement_disputes — the cross-check log.
 *
 * Flow:
 *   1. A secondary tier (url_context, etc.) resolves an event that already
 *      has a cached score.
 *   2. If the new FT score disagrees with the cached one, we log a
 *      dispute row instead of blindly overwriting the cache.
 *   3. A human reviews the row and either accepts the new score (with
 *      upsertScoreForce) or keeps the cached one.
 */

import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../client";
import {
  settlementDisputes,
  type NewSettlementDisputeRow,
  type SettlementDisputeRow,
} from "../schema";
import type { MatchScore } from "../../settle/types";

export const maybeLogDispute = async (
  cached: MatchScore,
  fresh: MatchScore,
): Promise<boolean> => {
  // Ignore when the cached FT and the fresh FT match — no disagreement.
  if (cached.ftHome === fresh.ftHome && cached.ftAway === fresh.ftAway) {
    return false;
  }
  const row: NewSettlementDisputeRow = {
    id: randomUUID(),
    eventId: cached.eventId,
    cachedSource: cached.source,
    cachedFtHome: cached.ftHome,
    cachedFtAway: cached.ftAway,
    newSource: fresh.source,
    newFtHome: fresh.ftHome,
    newFtAway: fresh.ftAway,
    cachedConfidence: cached.confidence,
    newConfidence: fresh.confidence,
  };
  await db.insert(settlementDisputes).values(row);
  return true;
};

export const listUnresolvedDisputes = async (
  limit = 50,
): Promise<SettlementDisputeRow[]> => {
  return db
    .select()
    .from(settlementDisputes)
    .where(eq(settlementDisputes.resolved, false))
    .orderBy(desc(settlementDisputes.detectedAt))
    .limit(limit);
};

export const resolveDispute = async (
  id: string,
  resolution: "kept-cached" | "accepted-new" | "manual-override",
): Promise<void> => {
  await db
    .update(settlementDisputes)
    .set({
      resolved: true,
      resolution,
      resolvedAt: new Date().toISOString(),
    })
    .where(and(eq(settlementDisputes.id, id)));
};
