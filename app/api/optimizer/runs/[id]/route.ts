/**
 * GET /api/optimizer/runs/[id] — run detail (header + summary).
 *
 * Trial rows live at /api/optimizer/runs/[id]/trials so the run-detail
 * page can poll header at one cadence and trial table at another.
 */

import { NextResponse } from "next/server";
import { getRun } from "@/lib/optimizer/repository";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ run });
}
