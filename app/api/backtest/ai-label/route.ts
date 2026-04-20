import { NextRequest } from "next/server";
import { z } from "zod";
import {
  apiBadRequest,
  apiServerError,
  apiSuccess,
} from "@/lib/shared/api-response";
import { settleBatch } from "@/lib/settle/settle-batch";
import { AiBudgetError } from "@/lib/settle/cost-guard";

/**
 * Settlement endpoint. Wraps the waterfall (`settleBatch`) — cheap
 * tiers first, AI last (only if the kill switch is enabled upstream).
 *
 * Bets that remain pending after the waterfall are returned as-is so
 * the UI can surface them for manual verification (Google AI Mode link).
 *
 * Historical note: this route used to have a per-bet legacy-AI fallback.
 * That path was removed once ESPN + SofaScore drove coverage above 95%
 * and the existing alias-learning feature was able to close remaining
 * team-name mismatches organically.
 */
const MAX_IDS = 500;

const BodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(MAX_IDS),
  /**
   * Opt into the paid AI fallback (Gemini url_context) for events the
   * free tiers can't resolve. Default false — the automatic settlement
   * loop never sends this; only the UI "AI settle" button does.
   */
  useAi: z.boolean().default(false),
  /**
   * Skip the DB cache so the waterfall re-resolves scores even when a
   * stale entry exists. "Re-run default pipeline" in the UI sends this.
   */
  bypassCache: z.boolean().default(false),
  /**
   * Skip every free tier and go directly to AI. "Re-run with Lite/
   * Flash/Pro" sends this along with aiModel.
   */
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
      allowAi: parsed.data.useAi,
      bypassCache: parsed.data.bypassCache,
      forceAi: parsed.data.forceAi,
      aiModel: parsed.data.aiModel,
    });
    return apiSuccess({
      proposals: result.proposals,
      attempted: result.proposals.length,
      missing: result.missing,
      telemetry: result.telemetry,
      unresolvedEventCount: result.telemetry.unresolvedEvents,
    });
  } catch (err) {
    // Budget violations are user-actionable — surface the message as a
    // 400 rather than a generic 500 so the UI shows it intact.
    if (err instanceof AiBudgetError) {
      return apiBadRequest(err.message);
    }
    return apiServerError(err, "Backtest:settle");
  }
}
