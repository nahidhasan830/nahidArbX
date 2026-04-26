/**
 * Override blocklist — Layer 1 of the error-mitigation strategy
 * (reversibility). When the operator overrides an auto-decision, the
 * (provider, surface, competition, blocked_entity) tuple lands here for
 * 30 days. The auto-resolver consults this BEFORE any potential
 * auto-confirm so the same wrong decision can't be re-applied by the
 * next sync.
 *
 * After 30 days the entry expires (the model has had time to retrain on
 * the negative training signal by then).
 */

import { db } from "../../db/client";
import { sql } from "drizzle-orm";
import { logger } from "../../shared/logger";

const tag = "EntityBlocklist";

export interface BlocklistEntry {
  provider: string;
  surfaceNormalized: string;
  competitionId: string | null;
  blockedEntityId: string;
  reason: "manual-reject" | "manual-confirm-undone" | "tainted-cascade";
}

/**
 * Add a blocklist entry. Defaults to a 30-day expiry; callers can
 * override for tainted-cascade entries (which should expire when the
 * model has retrained, ~7 days).
 */
export async function addBlocklistEntry(
  entry: BlocklistEntry,
  expiryDays = 30,
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO entity_decision_blocklist
        (provider, surface_normalized, competition_id, blocked_entity_id, reason, expires_at)
      VALUES
        (${entry.provider}, ${entry.surfaceNormalized}, ${entry.competitionId},
         ${entry.blockedEntityId}, ${entry.reason},
         now() + (${expiryDays} || ' days')::interval)
    `);
  } catch (err) {
    logger.warn(tag, `addBlocklistEntry failed: ${(err as Error).message}`);
  }
}

/**
 * Check if an auto-confirm is blocked. True = blocked → auto-resolver
 * must NOT auto-confirm; if the candidate is otherwise strong, it goes
 * to the operator inbox instead.
 *
 * Filters by `expires_at > now()` at query time (the index can't be
 * partial because now() isn't IMMUTABLE — see migration 0034).
 */
export async function isBlocked(opts: {
  provider: string;
  surfaceNormalized: string;
  competitionId: string | null;
  candidateEntityId: string;
}): Promise<boolean> {
  try {
    const r = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM entity_decision_blocklist
      WHERE provider = ${opts.provider}
        AND surface_normalized = ${opts.surfaceNormalized}
        AND competition_id IS NOT DISTINCT FROM ${opts.competitionId}
        AND blocked_entity_id = ${opts.candidateEntityId}
        AND expires_at > now()
      LIMIT 1
    `);
    const n = r.rows?.[0]?.n ?? 0;
    return n > 0;
  } catch (err) {
    logger.warn(tag, `isBlocked check failed: ${(err as Error).message}`);
    // Fail-open: if the blocklist check itself errors, don't auto-confirm
    // (we'd rather over-escalate than re-apply a known-bad decision).
    return true;
  }
}

/**
 * Sweep expired entries. Called from a tiny daily cron — keeps the table
 * bounded so the partial-index workaround stays cheap.
 */
export async function sweepExpiredBlocklist(): Promise<number> {
  try {
    const r = await db.execute<{ n: number }>(sql`
      WITH deleted AS (
        DELETE FROM entity_decision_blocklist
        WHERE expires_at <= now()
        RETURNING 1
      )
      SELECT count(*)::int AS n FROM deleted
    `);
    const n = r.rows?.[0]?.n ?? 0;
    if (n > 0) logger.info(tag, `Swept ${n} expired blocklist entries`);
    return n;
  } catch (err) {
    logger.warn(tag, `sweep failed: ${(err as Error).message}`);
    return 0;
  }
}
