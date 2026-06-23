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
            "push",
          ])
          .transform((v) => (v === "push" ? ("void" as const) : v)),
        source: z.string().max(40).optional(),
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
