/**
 * GET  /api/optimizer/runs        — list recent runs
 * POST /api/optimizer/runs        — create + queue a new run, kick sidecar
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { kickRunNow } from "@/lib/optimizer/scheduler";
import {
  createRun,
  getEstimatedRunDurationSec,
  listRuns,
} from "@/lib/optimizer/repository";

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
  // Send a Telegram notification when the run hits a terminal status.
  // Omitted = true (defaults to ON; user opts out via the UI switch).
  notifyOnComplete: z.boolean().optional(),
  // Send a Telegram ping the moment the sidecar picks the run up. Independent
  // of notifyOnComplete — user can check either, both, or neither.
  notifyOnStart: z.boolean().optional(),
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
    notifyOnComplete: parsed.notifyOnComplete,
    notifyOnStart: parsed.notifyOnStart,
  });

  // ETA for the submit-sheet toast + the RunProgressPanel chip.
  // Failing to look this up must NOT block the run — any DB hiccup here is
  // a cosmetic loss, not a blocker, so swallow errors and omit the field.
  let estimate: Awaited<ReturnType<typeof getEstimatedRunDurationSec>> | null =
    null;
  try {
    estimate = await getEstimatedRunDurationSec({
      nTrialsTarget: run.nTrialsTarget,
      cvStrategy: (run.cvStrategy as { type?: string })?.type ?? "cpcv",
      searchAlgorithm: run.searchAlgorithm,
    });
  } catch {
    estimate = null;
  }

  // Fire-and-forget kick — don't block the response on the sidecar.
  void kickRunNow(run.id);

  return NextResponse.json(
    {
      run,
      estimate: estimate
        ? {
            estimatedSec: estimate.estimatedSec,
            basis: estimate.basis,
            sampleSize: estimate.sampleSize,
          }
        : null,
    },
    { status: 201 },
  );
}
