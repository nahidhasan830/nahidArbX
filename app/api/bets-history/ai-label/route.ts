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
 * Settlement endpoint. Wraps the waterfall (`settleBatch`) — Tier 0/1/2
 * deterministic resolution by default; Gemini Tier 3 only when the
 * caller explicitly sets `forceAi`.
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
  /**
   * Operator-triggered: send events straight to Gemini Tier 3. The ONLY
   * way to invoke paid AI from this route. "Re-run with Lite/Flash/Pro"
   * sends this along with aiModel.
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
