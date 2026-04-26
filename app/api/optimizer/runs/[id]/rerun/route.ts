/**
 * POST /api/optimizer/runs/[id]/rerun
 *
 * Clones an existing run's configuration (search space, algorithm, trial
 * count, CV strategy, data filters, notification toggles) into a fresh
 * `queued` row and kicks the scheduler. Useful when a run failed for a
 * transient reason (Cloud Run hiccup, sidecar deploy mid-flight) or when
 * the operator wants to re-explore the same scope with a new seed.
 *
 * The new row gets:
 *   - a fresh ULID-like id
 *   - a name suffixed with " (rerun HH:MM)"
 *   - a fresh random rng_seed (so re-running an unlucky seed actually
 *     explores different territory; pass `keepSeed: true` in the body to
 *     reuse the original seed for strict reproducibility)
 *   - status='queued' — scheduler picks it up within 5s
 *   - empty summary / best_trial_id / started_at / completed_at — those
 *     belong to the prior run, not this one
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { kickRunNow } from "@/lib/optimizer/scheduler";
import {
  createRun,
  getRun,
  type OptimizationRunRow,
} from "@/lib/optimizer/repository";
import type {
  CvStrategyJson,
  DataFiltersJson,
  SearchAlgorithm,
  SearchSpaceJson,
} from "@/lib/optimizer/types";

const body = z
  .object({
    keepSeed: z.boolean().optional(),
  })
  .optional();

function buildRerunName(original: string): string {
  // Strip any prior "(rerun HH:MM)" suffix to avoid stacking on repeated
  // reruns (e.g. "Quick (rerun 14:32) (rerun 16:01)" → "Quick (rerun 16:01)").
  const stripped = original.replace(/\s*\(rerun \d{2}:\d{2}\)\s*$/, "").trim();
  const stamp = new Date().toISOString().slice(11, 16); // HH:MM UTC-ish
  return `${stripped} (rerun ${stamp})`;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let parsed: z.infer<typeof body> = undefined;
  try {
    const text = await req.text();
    if (text) parsed = body.parse(JSON.parse(text));
  } catch (err) {
    return NextResponse.json(
      {
        error: "invalid_body",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 400 },
    );
  }

  const original: OptimizationRunRow | null = await getRun(id);
  if (!original) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const cloned = await createRun({
    name: buildRerunName(original.name),
    searchAlgorithm: original.searchAlgorithm as SearchAlgorithm,
    nTrialsTarget: original.nTrialsTarget,
    rngSeed: parsed?.keepSeed ? (original.rngSeed ?? undefined) : undefined,
    cvStrategy: (original.cvStrategy as CvStrategyJson) ?? undefined,
    searchSpace: (original.searchSpace as SearchSpaceJson) ?? undefined,
    dataFilters: (original.dataFilters as DataFiltersJson) ?? undefined,
    notifyOnComplete: original.notifyOnComplete,
    notifyOnStart: original.notifyOnStart,
  });

  // Fire-and-forget — don't block the response on the Cloud Run trigger.
  void kickRunNow(cloned.id);

  return NextResponse.json({ run: cloned }, { status: 201 });
}
