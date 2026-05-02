import { NextRequest } from "next/server";
import { z } from "zod";
import {
  apiBadRequest,
  apiNotFound,
  apiServerError,
  apiSuccess,
} from "@/lib/shared/api-response";
import { getBetById, markOutcome, deleteBet } from "@/lib/db/repositories/bets";
import { applySettlementOutcomes } from "@/lib/settle/apply-outcomes";

const BodySchema = z.object({
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
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) return apiBadRequest("Missing id");
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
    if (parsed.data.outcome === "pending") {
      const row = await markOutcome(id, parsed.data.outcome);
      if (!row) return apiNotFound(`Bet ${id} not found`);
      return apiSuccess({ row });
    }

    await applySettlementOutcomes([
      { id, outcome: parsed.data.outcome, source: "manual" },
    ]);
    const row = await getBetById(id);
    if (!row) return apiNotFound(`Bet ${id} not found`);
    return apiSuccess({ row });
  } catch (err) {
    return apiServerError(err, "Backtest:markOutcome");
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) return apiBadRequest("Missing id");
  try {
    const deleted = await deleteBet(id);
    if (!deleted) return apiNotFound(`Bet ${id} not found`);
    return apiSuccess({ deleted: true });
  } catch (err) {
    return apiServerError(err, "Backtest:deleteBet");
  }
}
