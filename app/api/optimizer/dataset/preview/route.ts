/**
 * POST /api/optimizer/dataset/preview
 *
 * Returns: { total, included, byProvider[], byMarket[] }
 *
 * Lets the submit-run sheet show "X of Y bets included" + per-provider /
 * per-market breakdown of what survives the user's data-scope filters,
 * BEFORE they actually queue a run.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { previewDataset } from "@/lib/optimizer/repository";

const body = z.object({
  excludeSoftProviders: z.array(z.string()).optional(),
  includeSoftProviders: z.array(z.string()).optional(),
  excludeMarketTypes: z.array(z.string()).optional(),
  includeMarketTypes: z.array(z.string()).optional(),
  eventStartFrom: z.string().datetime().optional(),
  eventStartTo: z.string().datetime().optional(),
  placedOnly: z.boolean().optional(),
});

export async function POST(req: Request) {
  let filters: z.infer<typeof body>;
  try {
    filters = body.parse(await req.json().catch(() => ({})));
  } catch (err) {
    return NextResponse.json(
      {
        error: "invalid_body",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 400 },
    );
  }
  const preview = await previewDataset(filters);
  return NextResponse.json(preview);
}
