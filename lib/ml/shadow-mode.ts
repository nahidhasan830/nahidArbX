/**
 * Shadow Mode — tracks shadow Kelly vs ML Kelly decisions.
 *
 * Every time the reactive detector places a bet, we compute:
 *   shadowKelly = kellyFraction * SHADOW_KELLY_MULTIPLIER (0.5)
 *   mlKelly    = computeAdjustedKelly() output
 *
 * Both are persisted to the `shadow_decisions` table. After settlement,
 * outcomes are updated for side-by-side performance analysis.
 */

import { db } from "@/lib/db/client";
import { shadowDecisions } from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { logger } from "@/lib/shared/logger";

/** Shadow Kelly is always 50% of raw Kelly. */
export const SHADOW_KELLY_MULTIPLIER = 0.5;

/** Shadow-mode decision persisted to DB. */
export interface ShadowDecision {
  betId: string;
  eventId: string;
  kellyFraction: number;   // raw Kelly fraction
  shadowKelly: number;      // kellyFraction * SHADOW_KELLY_MULTIPLIER
  mlKelly: number;          // computeAdjustedKelly output
  mlMultiplier: number;   // mlKelly / kellyFraction
  placedAt: Date;
}

/**
 * Log a shadow decision to DB when a bet is placed.
 * Called by reactive-detector after placing — does not block placement.
 */
export async function logShadowDecision(decision: ShadowDecision): Promise<void> {
  try {
    await db.insert(shadowDecisions).values({
      id: decision.betId,
      betId: decision.betId,
      eventId: decision.eventId,
      placedAt: decision.placedAt.toISOString(),
      kellyRaw: decision.kellyFraction,
      shadowKelly: decision.shadowKelly,
      mlKelly: decision.mlKelly,
      mlMultiplier: decision.mlMultiplier,
      outcome: null,
      settledAt: null,
      createdAt: new Date().toISOString(),
    }).onConflictDoUpdate({
      target: [shadowDecisions.id],
      set: {
        kellyRaw: decision.kellyFraction,
        shadowKelly: decision.shadowKelly,
        mlKelly: decision.mlKelly,
        mlMultiplier: decision.mlMultiplier,
        placedAt: decision.placedAt.toISOString(),
      },
    });
  } catch (err) {
    logger.warn("[shadow-mode]", `failed to log shadow decision | betId=${decision.betId} | err=${(err as Error).message}`);
  }
}

/**
 * Resolve a shadow decision when the corresponding bet settles.
 * Called by auto-settler after outcomes are written.
 *
 * @param betId     The bet ID (matches shadow_decisions.id)
 * @param outcome  "win" | "lose" | "void" | "half_win" | "half_lose"
 * @param settledAt Settlement timestamp
 */
export async function resolveShadowDecision(
  betId: string,
  outcome: string,
  settledAt: Date,
): Promise<void> {
  try {
    await db.update(shadowDecisions)
      .set({ outcome, settledAt: settledAt.toISOString() })
      .where(eq(shadowDecisions.id, betId));
  } catch (err) {
    logger.warn("[shadow-mode]", `failed to resolve shadow decision | betId=${betId} | err=${(err as Error).message}`);
  }
}

/**
 * Fetch unresolved shadow decisions for an event — used by auto-settler
 * to resolve them in batch after settlement outcomes are applied.
 */
export async function getUnresolvedByEvent(
  eventId: string,
): Promise<Array<{ betId: string; shadowKelly: number; mlKelly: number }>> {
  const rows = await db
    .select({
      betId: shadowDecisions.betId,
      shadowKelly: shadowDecisions.shadowKelly,
      mlKelly: shadowDecisions.mlKelly,
    })
    .from(shadowDecisions)
    .where(
      and(
        eq(shadowDecisions.eventId, eventId),
        sql`${shadowDecisions.outcome} IS NULL`,
      ),
    );
  return rows;
}
