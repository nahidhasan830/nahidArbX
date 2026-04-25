/**
 * POST /api/optimizer/runs/[id]/cancel
 *
 * Flips the row to status='cancelled'. The running Cloud Run Job's
 * `_cancel_watcher` (services/optimizer/app/runner.py) polls this flag
 * every 2s and exits cleanly within one trial-time. No HTTP call to
 * the sidecar is needed — DB is the source of truth.
 */

import { NextResponse } from "next/server";
import { cancelRun } from "@/lib/optimizer/repository";

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
  return NextResponse.json({ status: "cancelled", id });
}
