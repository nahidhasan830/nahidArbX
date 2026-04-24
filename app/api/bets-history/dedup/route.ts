/**
 * One-off dedup endpoint — removes duplicate rows in the unified `bets`
 * table created by the pre-fix matcher that produced unstable event ids.
 *
 * POST /api/bets-history/dedup?dryRun=true   → preview counts only
 * POST /api/bets-history/dedup               → delete losing rows in each dup group
 *
 * Dev-only: guarded by NODE_ENV check. Delete this file once executed.
 */

import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  apiError,
  apiServerError,
  apiSuccess,
} from "@/lib/shared/api-response";

export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV !== "development") {
    return apiError("dev-only endpoint", 403);
  }

  const dryRun = request.nextUrl.searchParams.get("dryRun") === "true";

  try {
    const groups = await db.execute<{
      group_key: string;
      rows_in_group: number;
    }>(
      sql`SELECT
            home_team || '|' || away_team || '|' || event_start_time || '|' || family_id || '|' || atom_id AS group_key,
            COUNT(*)::int AS rows_in_group
          FROM bets
          GROUP BY 1
          HAVING COUNT(*) > 1
          ORDER BY COUNT(*) DESC
          LIMIT 200`,
    );

    const dupGroups = groups.rows as {
      group_key: string;
      rows_in_group: number;
    }[];
    const totalGroups = dupGroups.length;
    const totalExtraRows = dupGroups.reduce(
      (s, g) => s + (g.rows_in_group - 1),
      0,
    );
    const topSamples = dupGroups.slice(0, 5);

    if (totalGroups === 0 || dryRun) {
      return apiSuccess({
        dryRun: true,
        totalGroups,
        totalExtraRows,
        topSamples,
        deleted: 0,
      });
    }

    const result = await db.execute<{ deleted: number }>(
      sql`WITH ranked AS (
            SELECT id,
                   ROW_NUMBER() OVER (
                     PARTITION BY home_team, away_team, event_start_time,
                                  family_id, atom_id
                     ORDER BY soft_odds DESC, first_seen_at ASC, id ASC
                   ) AS rn
            FROM bets
          ),
          deleted AS (
            DELETE FROM bets
            WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
            RETURNING 1
          )
          SELECT COUNT(*)::int AS deleted FROM deleted`,
    );

    const deleted =
      (result.rows[0] as { deleted: number } | undefined)?.deleted ?? 0;

    const remaining = await db.execute<{ total: number }>(
      sql`SELECT COUNT(*)::int AS total FROM bets`,
    );

    return apiSuccess({
      dryRun: false,
      totalGroups,
      totalExtraRows,
      deleted,
      remaining: (remaining.rows[0] as { total: number }).total,
    });
  } catch (err) {
    return apiServerError(err, "Backtest:dedup");
  }
}
