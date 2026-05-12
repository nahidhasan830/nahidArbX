import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ensureDbReady } from "@/lib/db/client";
import { db } from "@/lib/db/client";
import { bets } from "@/lib/db/schema";
import { desc, and, isNotNull, sql } from "drizzle-orm";
import { computeRawMultiplierForShadow } from "@/lib/ml/staker";
import { deriveEdge } from "@/lib/betting/sizing";
import { getBettingSettings } from "@/lib/db/repositories/betting-settings";

const querySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  resolved: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  aggregate: z.enum(["true", "false"]).default("false"),
});

function computeRawKelly(row: {
  softOdds: number | string | null;
  softCommissionPct: number | string | null;
  sharpTrueProb: number | string | null;
}): number {
  const { fullKelly } = deriveEdge({
    softOdds: Number(row.softOdds ?? 0),
    softCommissionPct: Number(row.softCommissionPct ?? 0),
    sharpTrueProb: Number(row.sharpTrueProb ?? 0),
  });
  return Math.max(0, fullKelly);
}

function computeAdjustedOdds(row: {
  softOdds: number | string | null;
  softCommissionPct: number | string | null;
  sharpTrueProb: number | string | null;
}): number {
  const { adjustedOdds } = deriveEdge({
    softOdds: Number(row.softOdds ?? 0),
    softCommissionPct: Number(row.softCommissionPct ?? 0),
    sharpTrueProb: Number(row.sharpTrueProb ?? 0),
  });
  return adjustedOdds;
}

function configuredStakeFraction(
  fullKelly: number,
  multiplier: number,
  settings: { kellyFraction: number | string | null; kellyCapPct: number | string | null },
): number {
  if (!Number.isFinite(fullKelly) || fullKelly <= 0) return 0;
  if (!Number.isFinite(multiplier) || multiplier <= 0) return 0;

  const kellyFraction = Math.max(
    0,
    Math.min(1, Number(settings.kellyFraction ?? 0.25)),
  );
  const capFraction = Math.max(0, Number(settings.kellyCapPct ?? 10) / 100);
  const boundedMultiplier = Math.min(multiplier, 2);
  return Math.min(fullKelly * boundedMultiplier * kellyFraction, capFraction);
}

/**
 * Return per unit of stake for a given outcome.
 * win → (adjustedOdds − 1), lose → −1, void → 0, pending → null.
 */
function unitReturn(
  outcome: string,
  adjustedSoftOdds: number,
): number | null {
  switch (outcome) {
    case "won":
      return adjustedSoftOdds - 1;
    case "half_won":
      return (adjustedSoftOdds - 1) / 2;
    case "lost":
      return -1;
    case "half_lost":
      return -0.5;
    case "void":
      return 0;
    default:
      return null; // pending
  }
}

function computeShadowMultiplier(row: {
  mlScore: number | null;
  mlFeatures: number[] | null;
}): number {
  const features = row.mlFeatures ?? [];
  const score = row.mlScore ?? 0;
  return features.length > 0 && score > 0
    ? computeRawMultiplierForShadow(score, features)
    : 1.0;
}

/**
 * Canonical outcome mapping: bets.outcome → shadow analytics vocabulary.
 * The bets table uses 'won'/'lost' while the old shadow_decisions table
 * used 'win'/'lose'. We now derive everything from bets.outcome directly.
 */
function outcomeToShadowOutcome(
  outcome: string,
): "win" | "half_win" | "lose" | "half_lose" | "void" | null {
  switch (outcome) {
    case "won":
      return "win";
    case "half_won":
      return "half_win";
    case "lost":
      return "lose";
    case "half_lost":
      return "half_lose";
    case "void":
      return "void";
    default:
      return null; // pending
  }
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
  const { row: settings } = await getBettingSettings();

  // Base conditions: only bets with ML scores
  const baseConditions = [isNotNull(bets.mlScore)];
  if (q.from) baseConditions.push(sql`${bets.firstSeenAt} >= ${q.from}`);
  if (q.to) baseConditions.push(sql`${bets.firstSeenAt} <= ${q.to}`);
  if (q.resolved === "true") {
    baseConditions.push(sql`${bets.outcome} <> 'pending'`);
  } else if (q.resolved === "false") {
    baseConditions.push(sql`${bets.outcome} = 'pending'`);
  }
  const where = and(...baseConditions);

  if (q.aggregate === "true") {
    const rows = await db
      .select({
        outcome: bets.outcome,
        mlScore: bets.mlScore,
        mlFeatures: bets.mlFeatures,
        softOdds: bets.softOdds,
        softCommissionPct: bets.softCommissionPct,
        sharpTrueProb: bets.sharpTrueProb,
      })
      .from(bets)
      .where(where);

    const totalResolved = rows.filter((r) => r.outcome !== "pending").length;
    const totalWins = rows.filter(
      (r) => r.outcome === "won" || r.outcome === "half_won",
    ).length;
    const totalLosses = rows.filter(
      (r) => r.outcome === "lost" || r.outcome === "half_lost",
    ).length;
    const totalVoids = rows.filter((r) => r.outcome === "void").length;
    const avgKellyRaw =
      rows.length > 0
        ? rows.reduce((sum, r) => sum + computeRawKelly(r), 0) / rows.length
        : 0;
    const avgMlMultiplier =
      rows.length > 0
        ? rows.reduce((sum, r) => sum + computeShadowMultiplier(r), 0) /
          rows.length
        : 1;

    // ── PnL comparison & outcome-conditional ML× ────────────────────────
    let shadowPnl = 0;
    let mlPnl = 0;
    const winsMultipliers: number[] = [];
    const lossesMultipliers: number[] = [];

    for (const r of rows) {
      const rawKelly = computeRawKelly(r);
      const mlMult = computeShadowMultiplier(r);
      const shadowK = configuredStakeFraction(rawKelly, 1, settings);
      const mlK = configuredStakeFraction(rawKelly, mlMult, settings);
      const adjOdds = computeAdjustedOdds(r);
      const uRet = unitReturn(r.outcome, adjOdds);

      if (uRet != null) {
        shadowPnl += shadowK * uRet;
        mlPnl += mlK * uRet;
      }

      if (r.outcome === "won" || r.outcome === "half_won") {
        winsMultipliers.push(mlMult);
      } else if (r.outcome === "lost" || r.outcome === "half_lost") {
        lossesMultipliers.push(mlMult);
      }
    }

    const avgMlxWins =
      winsMultipliers.length > 0
        ? winsMultipliers.reduce((a, b) => a + b, 0) / winsMultipliers.length
        : null;
    const avgMlxLosses =
      lossesMultipliers.length > 0
        ? lossesMultipliers.reduce((a, b) => a + b, 0) /
          lossesMultipliers.length
        : null;

    return NextResponse.json({
      total: rows.length,
      resolved: totalResolved,
      unresolved: rows.length - totalResolved,
      avgKellyRaw: avgKellyRaw.toFixed(4),
      avgMlMultiplier: avgMlMultiplier.toFixed(4),
      wins: totalWins,
      losses: totalLosses,
      voids: totalVoids,
      winRate:
        totalResolved > 0
          ? ((totalWins / totalResolved) * 100).toFixed(1) + "%"
          : "—",
      // Cumulative PnL comparison in bankroll-percentage points, using the
      // same Kelly fraction and cap as auto-placement.
      shadowPnlPct: (shadowPnl * 100).toFixed(3),
      mlPnlPct: (mlPnl * 100).toFixed(3),
      pnlDeltaPct: ((mlPnl - shadowPnl) * 100).toFixed(3),
      // Outcome-conditional ML× averages
      avgMlxWins: avgMlxWins?.toFixed(4) ?? null,
      avgMlxLosses: avgMlxLosses?.toFixed(4) ?? null,
    });
  }

  // List individual shadow-derived rows from bets
  const rows = await db
    .select({
      id: bets.id,
      eventId: bets.eventId,
      homeTeam: bets.homeTeam,
      awayTeam: bets.awayTeam,
      competition: bets.competition,
      eventStartTime: bets.eventStartTime,
      marketType: bets.marketType,
      timeScope: bets.timeScope,
      familyLine: bets.familyLine,
      atomLabel: bets.atomLabel,
      sharpProvider: bets.sharpProvider,
      sharpOdds: bets.sharpOdds,
      softProvider: bets.softProvider,
      softOdds: bets.softOdds,
      softCommissionPct: bets.softCommissionPct,
      sharpTrueProb: bets.sharpTrueProb,
      stake: bets.stake,
      pnl: bets.pnl,
      mlScore: bets.mlScore,
      mlFeatures: bets.mlFeatures,
      mlKellyAdjusted: bets.mlKellyAdjusted,
      oddsMovement: bets.oddsMovement,
      outcome: bets.outcome,
      settledAt: bets.settledAt,
      firstSeenAt: bets.firstSeenAt,
      placedAt: bets.placedAt,
    })
    .from(bets)
    .where(where)
    .orderBy(desc(bets.firstSeenAt))
    .limit(q.limit)
    .offset(q.offset);

  // Derive shadow Kelly comparison metrics from bets data
  const enrichedRows = rows.map((r) => {
    const rawMultiplier = computeShadowMultiplier(r);
    const kellyRaw = computeRawKelly(r);
    const mlKelly = configuredStakeFraction(kellyRaw, rawMultiplier, settings);
    const shadowKelly = configuredStakeFraction(kellyRaw, 1, settings);
    const mlMultiplier = rawMultiplier;
    const adjustedSoftOdds = computeAdjustedOdds(r);
    const evPct =
      adjustedSoftOdds > 0 && r.sharpTrueProb != null
        ? (adjustedSoftOdds * Number(r.sharpTrueProb) - 1) * 100
        : null;

    // PnL impact: (mlKelly − shadowKelly) × unitReturn — positive = ML better.
    // Fractions are already after configured Kelly fraction and stake cap.
    const uRet = unitReturn(r.outcome, adjustedSoftOdds);
    const pnlImpact =
      uRet != null ? (mlKelly - shadowKelly) * uRet * 100 : null; // in pct

    return {
      id: r.id,
      betId: r.id,
      eventId: r.eventId,
      placedAt: r.placedAt,
      kellyRaw,
      shadowKelly,
      mlKelly,
      mlMultiplier,
      pnlImpact,
      outcome: outcomeToShadowOutcome(r.outcome),
      settledAt: r.settledAt,
      createdAt: r.firstSeenAt,
      // Enriched bets fields
      homeTeam: r.homeTeam,
      awayTeam: r.awayTeam,
      competition: r.competition,
      eventStartTime: r.eventStartTime,
      marketType: r.marketType,
      timeScope: r.timeScope,
      familyLine: r.familyLine,
      atomLabel: r.atomLabel,
      sharpProvider: r.sharpProvider,
      sharpOdds: r.sharpOdds,
      softProvider: r.softProvider,
      softOdds: r.softOdds,
      evPct,
      stake: r.stake,
      pnl: r.pnl,
      mlScore: r.mlScore,
      oddsMovement: r.oddsMovement ?? null,
    };
  });

  return NextResponse.json({ rows: enrichedRows, total: enrichedRows.length });
}
