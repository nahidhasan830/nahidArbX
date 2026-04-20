/**
 * Given a proposed rule's filter shape, run the deterministic backtest on
 * the held-out (walk-forward OOS) portion of value_bets and return metrics.
 *
 * This is the "LLM disposes" half of propose/dispose. The LLM never sees the
 * held-out rows, so a rule that survives here is genuinely earned.
 */

import { NextRequest } from "next/server";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { valueBets } from "@/lib/db/schema";
import {
  apiBadRequest,
  apiServerError,
  apiSuccess,
} from "@/lib/shared/api-response";
import { derive, settlementPnl } from "@/lib/backtest/derive";
import { summarizeClv, winZScore, zToPValue } from "@/lib/backtest/metrics";
import { normalizeOutcome, type ValueBetRow } from "@/lib/backtest/types";

const FilterSchema = z.object({
  marketTypes: z.array(z.string()).optional(),
  softProviders: z.array(z.string()).optional(),
  minEv: z.number().optional(),
  maxEv: z.number().optional(),
  tickMin: z.number().int().optional(),
  oddsMin: z.number().optional(),
  oddsMax: z.number().optional(),
  timeScope: z.string().optional(),
  competition: z.string().optional(),
  atomId: z.string().optional(),
});

const BodySchema = z.object({
  filters: FilterSchema,
  /** 0 < fraction <= 1. 0.3 = last 30% of rows by firstSeenAt. */
  oosFraction: z.number().positive().max(1).default(0.3),
});

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiBadRequest("Invalid JSON body");
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest(parsed.error.issues[0]?.message ?? "Invalid request");
  }
  const { filters, oosFraction } = parsed.data;

  try {
    // Step 1: total row count → compute cutoff timestamp.
    // We slice walk-forward using first_seen_at.
    const total = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(valueBets);
    const totalN = total[0]?.n ?? 0;

    if (totalN === 0) {
      return apiSuccess(emptyResult());
    }

    const trainSize = Math.floor(totalN * (1 - oosFraction));
    let cutoffTs: string | null = null;
    if (trainSize > 0 && trainSize < totalN) {
      const cutoff = await db
        .select({ firstSeenAt: valueBets.firstSeenAt })
        .from(valueBets)
        .orderBy(asc(valueBets.firstSeenAt))
        .limit(1)
        .offset(trainSize - 1);
      cutoffTs = cutoff[0]?.firstSeenAt ?? null;
    }

    // Step 2: build rule clauses on top of the OOS cutoff.
    const clauses: ReturnType<typeof eq>[] = [];
    if (cutoffTs) clauses.push(gte(valueBets.firstSeenAt, cutoffTs));

    if (filters.marketTypes?.length)
      clauses.push(inArray(valueBets.marketType, filters.marketTypes));
    if (filters.softProviders?.length)
      clauses.push(inArray(valueBets.softProvider, filters.softProviders));
    if (filters.tickMin != null)
      clauses.push(gte(valueBets.tickCount, filters.tickMin));
    if (filters.oddsMin != null)
      clauses.push(gte(valueBets.softOddsFirst, filters.oddsMin));
    if (filters.oddsMax != null)
      clauses.push(lte(valueBets.softOddsFirst, filters.oddsMax));
    if (filters.timeScope)
      clauses.push(eq(valueBets.timeScope, filters.timeScope));
    if (filters.competition)
      clauses.push(eq(valueBets.competition, filters.competition));
    if (filters.atomId) clauses.push(eq(valueBets.atomId, filters.atomId));

    // EV% bounds are computed at entry price (soft_odds_first). Matches
    // derive.evPctFirst and the DB filter in listValueBets — entry EV is the
    // realistic value we'd have realised at placement.
    const evFirst = sql`((1 + (${valueBets.softOddsFirst} - 1) * (1 - ${valueBets.softCommissionPct} / 100)) * ${valueBets.sharpTrueProb} - 1) * 100`;
    if (filters.minEv != null)
      clauses.push(sql`${evFirst} >= ${filters.minEv}`);
    if (filters.maxEv != null)
      clauses.push(sql`${evFirst} <= ${filters.maxEv}`);

    const rows = (await db
      .select()
      .from(valueBets)
      .where(clauses.length ? and(...clauses) : undefined)) as ValueBetRow[];

    if (rows.length === 0) {
      return apiSuccess(emptyResult(totalN, cutoffTs));
    }

    // Step 3: compute metrics.
    let wins = 0;
    let halfWins = 0;
    let losses = 0;
    let halfLosses = 0;
    let voids = 0;
    let pendings = 0;
    let totalStaked = 0;
    let totalReturn = 0;

    for (const raw of rows) {
      // Defensive normalize: drizzle reads bypass the repo's read-side
      // coercion, so a stray legacy "push" row would otherwise slip through.
      const r: ValueBetRow = { ...raw, outcome: normalizeOutcome(raw.outcome) };
      switch (r.outcome) {
        case "won":
          wins++;
          break;
        case "half_won":
          halfWins++;
          break;
        case "lost":
          losses++;
          break;
        case "half_lost":
          halfLosses++;
          break;
        case "void":
          voids++;
          break;
        default:
          pendings++;
      }
      // Half outcomes count as half-a-bet of exposure: the other half is a
      // push / stake return. settlementPnl already applies the 0.5× multiplier
      // to the payoff, so we mirror that on the stake side here.
      if (r.outcome === "won" || r.outcome === "lost") {
        totalStaked += 1;
        totalReturn += settlementPnl(r, 1);
      } else if (r.outcome === "half_won" || r.outcome === "half_lost") {
        totalStaked += 0.5;
        totalReturn += settlementPnl(r, 1);
      }
    }

    // Weighted win-rate: treat a half-win as 0.5 of a win.
    const decided = wins + halfWins + losses + halfLosses;
    const weightedWins = wins + 0.5 * halfWins;
    const winRatePct = decided > 0 ? (weightedWins / decided) * 100 : null;
    const roiPct = totalStaked > 0 ? (totalReturn / totalStaked) * 100 : null;
    const avgEvPct =
      rows.reduce((s, r) => s + derive(r).evPctFirst, 0) / rows.length;
    const clv = summarizeClv(rows);
    const z = winZScore(rows);
    const p = z == null ? null : zToPValue(z);

    return apiSuccess({
      oosTotal: totalN,
      oosCutoffFirstSeenAt: cutoffTs,
      n: rows.length,
      wins,
      halfWins,
      losses,
      halfLosses,
      voids,
      pendings,
      winRatePct,
      roiPct,
      avgEvPct,
      clvPct: clv.meanPct,
      beatCloseRatePct: clv.beatRatePct,
      z,
      p,
    });
  } catch (err) {
    return apiServerError(err, "Backtest:backtest-rule");
  }
}

function emptyResult(totalN = 0, cutoffTs: string | null = null) {
  return {
    oosTotal: totalN,
    oosCutoffFirstSeenAt: cutoffTs,
    n: 0,
    wins: 0,
    halfWins: 0,
    losses: 0,
    halfLosses: 0,
    voids: 0,
    pendings: 0,
    winRatePct: null,
    roiPct: null,
    avgEvPct: 0,
    clvPct: null,
    beatCloseRatePct: null,
    z: null,
    p: null,
  };
}
