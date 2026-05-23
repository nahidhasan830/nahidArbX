import { NextRequest } from "next/server";
import { z } from "zod";
import {
  apiBadRequest,
  apiServerError,
  apiSuccess,
} from "@/lib/shared/api-response";
import { settleBatch } from "@/lib/settle/settle-batch";

/**
 * Operator settlement endpoint. Wraps the source-only waterfall
 * (`settleBatch`). Operator-triggered runs bypass Tier 0 by default so
 * manual re-settle verifies against freshly resolved source data.
 *
 * Bets that remain pending after the waterfall are returned as-is so
 * the UI can surface them for manual verification.
 */
const MAX_IDS = 500;

const BodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(MAX_IDS),
  /**
   * Skip the DB cache so the waterfall re-resolves scores even when a
   * stale entry exists. Defaults true because this endpoint is only used
   * for operator-triggered settlement/re-settlement; the scheduler calls
   * settleBatch directly and keeps cache enabled.
   */
  bypassCache: z.boolean().default(true),
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
