/**
 * POST /api/optimizer/promote
 * Body: { trialId, name, description? }
 *
 * Derives `filters` + `sizing` from the trial's `params` JSON and a
 * `metrics_snapshot` from the trial's OOS metrics, then creates a
 * candidate-status strategy. Activate later via /strategies/[id]/status.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { optimizationTrials } from "@/lib/db/schema";
import { promoteStrategy } from "@/lib/optimizer/strategies";
import type {
  StrategyFilters,
  StrategySizing,
} from "@/lib/optimizer/strategies";

const body = z.object({
  trialId: z.string().min(1),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
});

const KNOWN_FILTER_KEYS: Array<keyof StrategyFilters> = [
  "min_ev_pct",

  "min_sharp_prob",
  "odds_lo",
  "odds_hi",
  "min_tick_count",
  "pre_match_only",
  "soft_providers",
  "market_types",
];

export async function POST(req: Request) {
  let parsed: z.infer<typeof body>;
  try {
    parsed = body.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      {
        error: "invalid_body",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 400 },
    );
  }

  const [trial] = await db
    .select()
    .from(optimizationTrials)
    .where(eq(optimizationTrials.id, parsed.trialId))
    .limit(1);
  if (!trial)
    return NextResponse.json({ error: "trial_not_found" }, { status: 404 });

  const params = (trial.params as Record<string, unknown>) ?? {};

  // Derive filters: pick out keys we know about; ignore the rest.
  const filters: StrategyFilters = {};
  for (const k of KNOWN_FILTER_KEYS) {
    if (k in params) {
      // Type assertion is safe: we trust the trial-row JSON shape.
      (filters as Record<string, unknown>)[k] = params[k];
    }
  }

  // Derive sizing.
  const sizing: StrategySizing = {
    kelly_fraction:
      typeof params["kelly_fraction"] === "number"
        ? (params["kelly_fraction"] as number)
        : 0.25,
    kelly_cap_pct:
      typeof params["kelly_cap_pct"] === "number"
        ? (params["kelly_cap_pct"] as number)
        : 10,
    staking_scheme:
      typeof params["staking_scheme"] === "string"
        ? (params["staking_scheme"] as string)
        : "kelly",
  };

  // Snapshot the OOS metrics that justified the promotion (audit trail).
  const metricsSnapshot = {
    oosRoiMean: trial.oosRoiMean,
    oosRoiCiLow: trial.oosRoiCiLow,
    oosRoiCiHigh: trial.oosRoiCiHigh,
    oosSortino: trial.oosSortino,
    oosSharpe: trial.oosSharpe,
    deflatedSharpe: trial.deflatedSharpe,
    probabilisticSharpe: trial.probabilisticSharpe,
    maxDrawdown: trial.maxDrawdown,
    sampleSize: trial.sampleSize,
    compositeScore: trial.compositeScore,
    onPareto: trial.onPareto,
    promotedAt: new Date().toISOString(),
  };

  const strategy = await promoteStrategy({
    trialId: trial.id,
    runId: trial.runId,
    name: parsed.name,
    description: parsed.description,
    filters,
    sizing,
    metricsSnapshot,
  });

  return NextResponse.json({ strategy }, { status: 201 });
}
