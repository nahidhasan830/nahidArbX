/**
 * GET /api/optimizer/strategies/[id]/validations
 *
 * Returns the strategy's auto-validation history (most recent 50). Powers
 * the validation timeline shown in the strategy detail UI — drift trend +
 * any auto-pause events.
 */

import { NextResponse } from "next/server";
import { listValidationsForStrategy } from "@/lib/optimizer/auto-validation";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const validations = await listValidationsForStrategy(id, 50);
  return NextResponse.json({ validations });
}
