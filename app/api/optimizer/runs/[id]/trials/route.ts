/**
 * GET /api/optimizer/runs/[id]/trials
 *
 * Query params:
 *   limit       (default 100, max 500)
 *   offset      (default 0)
 *   paretoOnly  ("true" → only Pareto-frontier trials)
 *   sortBy      "composite" (default) | "roi" | "sample_size" | "drawdown"
 *   sortDir     "asc" | "desc" (default desc)
 */

import { NextResponse } from "next/server";
import { listTrials } from "@/lib/optimizer/repository";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 100);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const paretoOnly = url.searchParams.get("paretoOnly") === "true";
  const sortBy = (url.searchParams.get("sortBy") ?? "composite") as
    | "composite"
    | "roi"
    | "sample_size"
    | "drawdown";
  const sortDir = (url.searchParams.get("sortDir") ?? "desc") as "asc" | "desc";

  const trials = await listTrials(id, {
    limit,
    offset,
    paretoOnly,
    sortBy,
    sortDir,
  });
  return NextResponse.json({ trials, limit, offset });
}
