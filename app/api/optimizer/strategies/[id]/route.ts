/**
 * GET /api/optimizer/strategies/[id] — strategy detail (metrics + recent bets).
 */

import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { getStrategy } from "@/lib/optimizer/strategies";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const strategy = await getStrategy(id);
  if (!strategy)
    return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Recent bets attributed to this strategy — feeds the strategy detail UI.
  const recentBets = await db.execute(
    sql`SELECT id, event_id AS "eventId", home_team AS "homeTeam",
               away_team AS "awayTeam", market_type AS "marketType",
               soft_odds AS "softOdds", outcome, pnl, clv_pct AS "clvPct",
               first_seen_at AS "firstSeenAt"
        FROM bets
        WHERE strategy_id = ${id}
        ORDER BY first_seen_at DESC
        LIMIT 100`,
  );
  return NextResponse.json({ strategy, recentBets: recentBets.rows });
}
