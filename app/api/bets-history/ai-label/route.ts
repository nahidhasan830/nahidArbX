import { NextRequest } from "next/server";
import { z } from "zod";
import {
  apiBadRequest,
  apiServerError,
  apiSuccess,
} from "@/lib/shared/api-response";
import { settleBatch } from "@/lib/settle/settle-batch";

/**
 * Settlement endpoint. Wraps the waterfall (`settleBatch`) — runs the
 * full free waterfall: Tier 0 (cache) → Tier 1 (live) → Tier 2a (ESPN)
 * → Tier 2b (API-Football) → Tier 2c (SofaScore) → Tier 2d (Groq+Search).
 *
 * No paid AI tiers. All resolution is free.
 *
 * Bets that remain pending after the waterfall are returned as-is so
 * the UI can surface them for manual verification.
 */
const MAX_IDS = 500;

const BodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(MAX_IDS),
  /**
   * Skip the DB cache so the waterfall re-resolves scores even when a
   * stale entry exists. "Re-run default pipeline" in the UI sends this.
   */
  bypassCache: z.boolean().default(false),
  // Legacy fields — accepted but ignored (Gemini removed from pipeline).
  forceAi: z.boolean().default(false),
  aiModel: z.enum(["lite", "flash", "pro"]).optional(),
});

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiBadRequest("Body must be valid JSON");
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest(parsed.error.issues[0]?.message ?? "Invalid body");
  }

  try {
    const result = await settleBatch(parsed.data.ids, {
      bypassCache: parsed.data.bypassCache || parsed.data.forceAi,
    });
    return apiSuccess({
      proposals: result.proposals,
      attempted: result.proposals.length,
      missing: result.missing,
      telemetry: result.telemetry,
      unresolvedEventCount: result.telemetry.unresolvedEvents,
    });
  } catch (err) {
    return apiServerError(err, "Backtest:settle");
  }
}
