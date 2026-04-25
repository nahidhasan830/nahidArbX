/**
 * GET /api/optimizer/runs/estimate
 *
 * Returns an ETA for a hypothetical run matching the given shape. Used by
 * the Submit-run sheet's Review step so the user sees "Estimated: ≈ 23m —
 * based on 12 prior runs" before they click Start Run.
 *
 * Query params:
 *   nTrials         integer 10..50000
 *   cvStrategy      "cpcv" | "walkforward"
 *   searchAlgorithm "ensemble" | "tpe" | "nsga2" | "random" | "ml-xgboost"
 *
 * Returns:
 *   { estimatedSec: number | null, basis: string, sampleSize: number }
 *
 * All errors downgrade to an empty estimate so the UI never blocks.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getEstimatedRunDurationSec } from "@/lib/optimizer/repository";

const querySchema = z.object({
  nTrials: z.coerce.number().int().min(10).max(50_000),
  cvStrategy: z.enum(["cpcv", "walkforward"]).default("cpcv"),
  searchAlgorithm: z
    .enum(["random", "tpe", "nsga2", "ensemble", "ml-xgboost"])
    .default("ensemble"),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  let parsed: z.infer<typeof querySchema>;
  try {
    parsed = querySchema.parse({
      nTrials: url.searchParams.get("nTrials"),
      cvStrategy: url.searchParams.get("cvStrategy") ?? undefined,
      searchAlgorithm: url.searchParams.get("searchAlgorithm") ?? undefined,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "invalid_query",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 400 },
    );
  }

  try {
    const est = await getEstimatedRunDurationSec({
      nTrialsTarget: parsed.nTrials,
      cvStrategy: parsed.cvStrategy,
      searchAlgorithm: parsed.searchAlgorithm,
    });
    return NextResponse.json(est);
  } catch {
    return NextResponse.json({
      estimatedSec: null,
      basis: "unavailable",
      sampleSize: 0,
    });
  }
}
