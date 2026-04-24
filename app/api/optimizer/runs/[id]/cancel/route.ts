/**
 * POST /api/optimizer/runs/[id]/cancel
 *
 * Flips the row to status='cancelled' and tells the sidecar so it stops
 * the trial loop on the next iteration. No response payload — the run
 * detail GET will reflect the new status.
 */

import { NextResponse } from "next/server";
import { cancelRun } from "@/lib/optimizer/repository";
import { cancelSidecarRun } from "@/lib/optimizer/api-client";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const flipped = await cancelRun(id);
  if (!flipped) {
    return NextResponse.json(
      {
        error: "not_cancellable",
        message: "Run is not in a queued/running state",
      },
      { status: 409 },
    );
  }
  // Best-effort — the DB flip is the source of truth; this just speeds it up.
  await cancelSidecarRun(id).catch(() => undefined);
  return NextResponse.json({ status: "cancelled", id });
}
