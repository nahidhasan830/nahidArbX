/**
 * GET /api/optimizer/strategies — list every promoted strategy.
 *
 * Strategy creation goes through `/api/optimizer/promote` (which derives
 * filters/sizing from a trial id) — no direct POST here, since manual
 * authorship without a backing trial is not a Phase 3 deliverable.
 */

import { NextResponse } from "next/server";
import { listStrategies } from "@/lib/optimizer/strategies";

export async function GET() {
  const strategies = await listStrategies();
  return NextResponse.json({ strategies });
}
