import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ensureDbReady } from "@/lib/db/client";
import { db } from "@/lib/db/client";
import { bets } from "@/lib/db/schema";
import { desc, and, isNotNull, sql } from "drizzle-orm";
import { deriveEdge } from "@/lib/betting/sizing";
import { computeRawStakeMultiplier } from "@/lib/ml/staker";
import { classifyDecisionDriver } from "@/lib/ml/decision-reason";

const querySchema = z.object({
  decision: z.enum(["boost", "shrink", "skip", "agree"]),
  driver: z.enum([
    "strong_edge", "moderate_edge", "persistence", "steam", "convergence",
    "negative_edge", "low_edge", "no_signal",
  ]),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

function computeEvPct(row: {
  softOdds: number | string | null;
  softCommissionPct: number | string | null;
  sharpTrueProb: number | string | null;
}): number | null {
  const { adjustedOdds } = deriveEdge({
    softOdds: Number(row.softOdds ?? 0),
    softCommissionPct: Number(row.softCommissionPct ?? 0),
    sharpTrueProb: Number(row.sharpTrueProb ?? 0),
  });
  if (!adjustedOdds || !row.sharpTrueProb) return null;
  return (adjustedOdds * Number(row.sharpTrueProb) - 1) * 100;
}

export async function GET(req: NextRequest) {
  await ensureDbReady();
  const params = Object.fromEntries(req.nextUrl.searchParams.entries());
  const parsed = querySchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const q = parsed.data;

  const conditions = [
    isNotNull(bets.mlScore),
    sql`${bets.outcome} <> 'pending'`,
  ];
  if (q.from) conditions.push(sql`${bets.firstSeenAt} >= ${q.from}`);
  if (q.to) conditions.push(sql`${bets.firstSeenAt} <= ${q.to}`);

  const rows = await db
    .select({
      id: bets.id,
      eventId: bets.eventId,
      homeTeam: bets.homeTeam,
      awayTeam: bets.awayTeam,
      competition: bets.competition,
      eventStartTime: bets.eventStartTime,
      outcome: bets.outcome,
      pnl: bets.pnl,
      softOdds: bets.softOdds,
      softCommissionPct: bets.softCommissionPct,
      sharpTrueProb: bets.sharpTrueProb,
      firstSeenAt: bets.firstSeenAt,
      mlScore: bets.mlScore,
      mlFeatures: bets.mlFeatures,
      marketType: bets.marketType,
    })
    .from(bets)
    .where(and(...conditions))
    .orderBy(desc(bets.firstSeenAt))
    .limit(500); // fetch enough to filter down to q.limit

  // Compute decision+driver for each, filter, and deduplicate by event
  const seen = new Set<string>();
  const matched = rows
    .map((r) => {
      const features = r.mlFeatures ?? [];
      if (features.length === 0) return null;
      const rawMult = computeRawStakeMultiplier(r.mlScore!, features);
      const info = classifyDecisionDriver(r.mlScore, features, rawMult);
      if (info.decision !== q.decision || info.driver !== q.driver) return null;
      return {
        id: r.id,
        eventId: r.eventId,
        homeTeam: r.homeTeam,
        awayTeam: r.awayTeam,
        competition: r.competition,
        eventStartTime: r.eventStartTime,
        outcome: r.outcome,
        pnl: r.pnl != null ? Number(r.pnl) : null,
        evPct: computeEvPct(r),
        firstSeenAt: r.firstSeenAt,
        marketType: r.marketType,
        softOdds: r.softOdds != null ? Number(r.softOdds) : null,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .filter((x) => {
      if (seen.has(x.eventId)) return false;
      seen.add(x.eventId);
      return true;
    })
    .slice(0, q.limit);

  return NextResponse.json({ rows: matched, total: matched.length });
}
