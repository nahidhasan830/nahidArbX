/**
 * POST /api/optimizer/strategies/[id]/status
 * Body: { status: "candidate" | "live" | "paused" | "retired" }
 *
 * The single mutation endpoint for status transitions. Side effects:
 *   - "live" sets activated_at and clears the live-strategies cache so
 *     the value-detector picks it up on the next tick.
 *   - "paused" / "retired" set their respective timestamps and clear cache.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  invalidateLiveStrategiesCache,
  setStrategyStatus,
} from "@/lib/optimizer/live-strategies-cache";
import type { StrategyStatus } from "@/lib/optimizer/strategies";

const body = z.object({
  status: z.enum(["candidate", "live", "paused", "retired"]),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
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
  const next = parsed.status as StrategyStatus;
  const updated = await setStrategyStatus(id, next);
  if (!updated)
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  invalidateLiveStrategiesCache();
  return NextResponse.json({ strategy: updated });
}
