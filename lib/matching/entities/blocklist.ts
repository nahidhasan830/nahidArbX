
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
    return true;
  }
}

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
