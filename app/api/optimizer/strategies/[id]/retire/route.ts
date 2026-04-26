/**
 * Soft-delete a strategy.
 *
 *   POST   /api/optimizer/strategies/[id]/retire   → set retired_at = now()
 *   DELETE /api/optimizer/strategies/[id]/retire   → clear retired_at (restore)
 *
 * Strategy "lifecycle" used to be a four-state enum (candidate / live /
 * paused / retired) but the live-vs-not distinction stopped meaning
 * anything once the value-detector stopped consulting strategies. The only
 * useful state left is "available vs archived" — that's what this endpoint
 * mutates.
 */

import { NextResponse } from "next/server";
import { retireStrategy, unretireStrategy } from "@/lib/optimizer/strategies";
import { invalidateActiveStrategiesCache } from "@/lib/optimizer/active-strategies";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const updated = await retireStrategy(id);
  if (!updated)
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  // A retired strategy lingering in settings.active_strategy_ids becomes a
  // no-op (we filter retired out of the active set), but invalidate the
  // cache so the next auto-place tick rebuilds without it.
  invalidateActiveStrategiesCache();
  return NextResponse.json({ strategy: updated });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const updated = await unretireStrategy(id);
  if (!updated)
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  invalidateActiveStrategiesCache();
  return NextResponse.json({ strategy: updated });
}
