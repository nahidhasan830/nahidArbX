/**
 * GET /api/optimizer/strategies/[id] — strategy detail (metrics + recent
 * bets that the strategy's filters currently select).
 */

import { NextResponse } from "next/server";
import { and, desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bets } from "@/lib/db/schema";
import { getStrategy, type StrategyFilters } from "@/lib/optimizer/strategies";
import { buildStrategyFilterClauses } from "@/lib/optimizer/strategy-filter-sql";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const strategy = await getStrategy(id);
  if (!strategy)
    return NextResponse.json({ error: "not_found" }, { status: 404 });

  const clauses = buildStrategyFilterClauses(
    strategy.filters as StrategyFilters,
  );
  const where = clauses.length ? and(...clauses) : undefined;

  const recentBets = await db
    .select({
      id: bets.id,
      eventId: bets.eventId,
      homeTeam: bets.homeTeam,
      awayTeam: bets.awayTeam,
      marketType: bets.marketType,
      softOdds: bets.softOdds,
      outcome: bets.outcome,
      pnl: bets.pnl,
      clvPct: bets.clvPct,
      firstSeenAt: bets.firstSeenAt,
    })
    .from(bets)
    .where(where)
    .orderBy(desc(bets.firstSeenAt))
    .limit(100);

  return NextResponse.json({ strategy, recentBets });
}
