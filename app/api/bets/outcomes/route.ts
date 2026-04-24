import { NextRequest } from "next/server";
import { z } from "zod";
import {
  apiBadRequest,
  apiServerError,
  apiSuccess,
} from "@/lib/shared/api-response";
import { applySettlementOutcomes } from "@/lib/settle/apply-outcomes";

const BodySchema = z.object({
  updates: z
    .array(
      z.object({
        id: z.string().min(1),
        outcome: z
          .enum([
            "pending",
            "won",
            "half_won",
            "lost",
            "half_lost",
            "void",
            // Legacy alias — collapsed to void below.
            "push",
          ])
          .transform((v) => (v === "push" ? ("void" as const) : v)),
        /**
         * Which part of the pipeline produced this outcome. Optional —
         * manual edits from the UI default to "manual" on the server.
         */
        source: z.string().max(40).optional(),
        /** Optional scoped final score (`home-away`) for placed-bet notifications. */
        score: z.string().max(20).optional(),
      }),
    )
    .min(1)
    .max(500),
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
    // Default missing source to "manual" — the backtest UI sends this
    // route when a human applied overrides via the settle dialog or
    // inline outcome dropdown.
    const updates = parsed.data.updates.map((u) => ({
      ...u,
      source: u.source ?? "manual",
    }));
    const applied = await applySettlementOutcomes(updates);
    return apiSuccess({
      applied,
      attempted: updates.length,
      skipped: updates.length - applied,
    });
  } catch (err) {
    return apiServerError(err, "Backtest:bulkMarkOutcomes");
  }
}
