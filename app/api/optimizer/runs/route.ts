/**
 * GET  /api/optimizer/runs        — list recent runs
 * POST /api/optimizer/runs        — create + queue a new run, kick sidecar
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { kickRunNow } from "@/lib/optimizer/scheduler";
import { createRun, listRuns } from "@/lib/optimizer/repository";

const createBody = z.object({
  name: z.string().min(1).max(120),
  searchAlgorithm: z.enum(["random", "tpe", "nsga2", "ensemble", "ml-xgboost"]),
  nTrialsTarget: z.number().int().min(10).max(50_000),
  rngSeed: z.number().int().optional(),
  cvStrategy: z
    .object({
      type: z.enum(["cpcv", "walkforward"]).optional(),
      n_groups: z.number().int().min(2).max(20).optional(),
      n_test_groups: z.number().int().min(1).max(10).optional(),
      embargo_pct: z.number().min(0).max(0.2).optional(),
    })
    .optional(),
  searchSpace: z
    .object({
      dimensions: z.array(z.record(z.string(), z.unknown())),
    })
    .optional(),
  // Pre-search data scope. Empty/omitted = include every settled bet.
  dataFilters: z
    .object({
      excludeSoftProviders: z.array(z.string()).optional(),
      includeSoftProviders: z.array(z.string()).optional(),
      excludeMarketTypes: z.array(z.string()).optional(),
      includeMarketTypes: z.array(z.string()).optional(),
      eventStartFrom: z.string().datetime().optional(),
      eventStartTo: z.string().datetime().optional(),
      placedOnly: z.boolean().optional(),
    })
    .optional(),
});

export async function GET() {
  const rows = await listRuns(200);
  return NextResponse.json({ runs: rows });
}

export async function POST(req: Request) {
  let parsed: z.infer<typeof createBody>;
  try {
    parsed = createBody.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      {
        error: "invalid_body",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 400 },
    );
  }

  // Cast through unknown — Zod validated the JSON shape; the optimizer types
  // accept arbitrary dimension objects. The Python sidecar is the schema
  // authority for what's actually a valid SearchSpace.
  const run = await createRun({
    name: parsed.name,
    searchAlgorithm: parsed.searchAlgorithm,
    nTrialsTarget: parsed.nTrialsTarget,
    rngSeed: parsed.rngSeed,
    cvStrategy: parsed.cvStrategy as never,
    searchSpace: parsed.searchSpace as never,
    dataFilters: parsed.dataFilters,
  });

  // Fire-and-forget kick — don't block the response on the sidecar.
  void kickRunNow(run.id);

  return NextResponse.json({ run }, { status: 201 });
}
