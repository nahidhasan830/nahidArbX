/**
 * POST /api/optimizer/schedules/[id]/run-now
 *
 * Manually fire a one-off run from the schedule's current snapshot, without
 * affecting the schedule's `next_fire_at`. Useful for testing a schedule's
 * config without waiting for its next natural firing.
 */

import { NextResponse } from "next/server";
import { createRun } from "@/lib/optimizer/repository";
import { kickRunNow } from "@/lib/optimizer/scheduler";
import { getSchedule, scheduleCreatedBy } from "@/lib/optimizer/schedules";
import type {
  CvStrategyJson,
  DataFiltersJson,
  SearchSpaceJson,
} from "@/lib/optimizer/types";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sched = await getSchedule(id);
  if (!sched) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const run = await createRun({
    name: `${sched.name} — manual ${stamp}`,
    searchAlgorithm: sched.searchAlgorithm as never,
    nTrialsTarget: sched.nTrialsTarget,
    cvStrategy: sched.cvStrategy as Partial<CvStrategyJson>,
    searchSpace: sched.searchSpace as SearchSpaceJson,
    dataFilters: sched.dataFilters as DataFiltersJson,
    createdBy: scheduleCreatedBy(sched.id),
  });

  // Don't update last_fire_at / next_fire_at — this was a manual fire.
  void kickRunNow(run.id);
  return NextResponse.json({ run }, { status: 201 });
}
