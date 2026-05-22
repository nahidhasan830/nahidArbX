import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { ensureDbReady } from "@/lib/db/client";
import { db } from "@/lib/db/client";
import { bets } from "@/lib/db/schema";
import { computeRawStakeMultiplier } from "@/lib/ml/staker";
import {
  buildAnalysis,
  classifyAnalysisBucket,
  classifyEdgeTier,
  classifyModelStance,
  computeAnalysisMetrics,
  computeUnitPnl,
  getAnalysisSignals,
} from "@/lib/ml/analysis";
import type { AnalysisBucket, SimilarBetRow } from "@/lib/ml/analysis-types";

const querySchema = z.object({
  betId: z.string().min(1),
  from: z.string().optional(),
  to: z.string().optional(),
});

const DEFAULT_SIMILAR_RANGE_DAYS = 90;

export async function GET(req: NextRequest) {
  await ensureDbReady();

  const parsed = querySchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams.entries()),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const q = parsed.data;
  const [bet] = await db
    .select({
      id: bets.id,
      eventId: bets.eventId,
      homeTeam: bets.homeTeam,
      awayTeam: bets.awayTeam,
      competition: bets.competition,
      eventStartTime: bets.eventStartTime,
      marketType: bets.marketType,
      softOdds: bets.softOdds,
      mlScore: bets.mlScore,
      mlFeatures: bets.mlFeatures,
    })
    .from(bets)
    .where(eq(bets.id, q.betId))
    .limit(1);

  if (!bet) {
    return NextResponse.json({ error: "Bet not found" }, { status: 404 });
  }

  const features = bet.mlFeatures ?? [];
  if (bet.mlScore == null || features.length === 0) {
    return NextResponse.json(
      { error: "This bet has no ML score or feature vector to analyze." },
      { status: 422 },
    );
  }

  const multiplier = computeRawStakeMultiplier(Number(bet.mlScore), features);
  const currentMetrics = computeAnalysisMetrics({
    mlScore: Number(bet.mlScore),
    features,
    fallbackOdds: bet.softOdds,
  });
  const decision = classifyModelStance(multiplier);
  const currentBucket = classifyAnalysisBucket({
    decision,
    edgeTier: classifyEdgeTier(currentMetrics.modelEdgePct),
    signals: getAnalysisSignals(features),
  });
  const similarBets = await loadSimilarBets({
    betId: bet.id,
    bucket: currentBucket,
    decision,
    from: q.from,
    to: q.to,
  });

  return NextResponse.json(
    buildAnalysis({
      bet: {
        id: bet.id,
        homeTeam: bet.homeTeam,
        awayTeam: bet.awayTeam,
        competition: bet.competition,
        marketType: bet.marketType,
        softOdds: bet.softOdds,
        mlScore: Number(bet.mlScore),
      },
      features,
      multiplier,
      bucket: currentBucket,
      similarBets,
    }),
  );
}

async function loadSimilarBets(params: {
  betId: string;
  bucket: AnalysisBucket;
  decision: ReturnType<typeof classifyModelStance>;
  from?: string;
  to?: string;
}): Promise<SimilarBetRow[]> {
  const from =
    params.from ??
    new Date(
      Date.now() - DEFAULT_SIMILAR_RANGE_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

  const conditions = [
    isNotNull(bets.mlScore),
    sql`${bets.outcome} NOT IN ('pending', 'cancelled')`,
    sql`${bets.firstSeenAt} >= ${from}`,
  ];
  if (params.to) conditions.push(sql`${bets.firstSeenAt} <= ${params.to}`);

  const rows = await db
    .select({
      id: bets.id,
      eventId: bets.eventId,
      homeTeam: bets.homeTeam,
      awayTeam: bets.awayTeam,
      competition: bets.competition,
      eventStartTime: bets.eventStartTime,
      outcome: bets.outcome,
      softOdds: bets.softOdds,
      firstSeenAt: bets.firstSeenAt,
      mlScore: bets.mlScore,
      mlFeatures: bets.mlFeatures,
      marketType: bets.marketType,
    })
    .from(bets)
    .where(and(...conditions))
    .orderBy(desc(bets.firstSeenAt));

  const similar: SimilarBetRow[] = [];

  for (const row of rows) {
    if (row.id === params.betId) continue;
    const features = row.mlFeatures ?? [];
    if (row.mlScore == null || features.length === 0) continue;

    const multiplier = computeRawStakeMultiplier(Number(row.mlScore), features);
    const decision = classifyModelStance(multiplier);
    if (decision !== params.decision) continue;

    const metrics = computeAnalysisMetrics({
      mlScore: Number(row.mlScore),
      features,
      fallbackOdds: row.softOdds,
    });
    const bucket = classifyAnalysisBucket({
      decision,
      edgeTier: classifyEdgeTier(metrics.modelEdgePct),
      signals: getAnalysisSignals(features),
    });
    if (bucket !== params.bucket) continue;

    const softOdds = row.softOdds != null ? Number(row.softOdds) : null;
    const unitPnl = computeUnitPnl(row.outcome, softOdds);
    similar.push({
      id: row.id,
      eventId: row.eventId,
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      competition: row.competition,
      eventStartTime: row.eventStartTime,
      outcome: row.outcome,
      softOdds,
      unitPnl,
      unitPnlFormatted: `${unitPnl >= 0 ? "+" : ""}${unitPnl.toFixed(2)}u`,
      modelEdge: Math.round(metrics.modelEdgePct * 10) / 10,
      modelEdgeFormatted: `${metrics.modelEdgePct >= 0 ? "+" : ""}${(
        Math.round(metrics.modelEdgePct * 10) / 10
      ).toFixed(1)}%`,
      firstSeenAt: row.firstSeenAt,
      marketType: row.marketType,
    });
  }

  return similar;
}
