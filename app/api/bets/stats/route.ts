import { NextRequest } from "next/server";
import { z } from "zod";
import {
  apiBadRequest,
  apiServerError,
  apiSuccess,
} from "@/lib/shared/api-response";
import { aggregateBets, type ListFilters } from "@/lib/db/repositories/bets";

// Same outcome enum as /api/bets — keeps filter parity so the summary numbers
// always reflect what's currently visible in the table.
const OUTCOME_VALUES = [
  "pending",
  "won",
  "half_won",
  "lost",
  "half_lost",
  "void",
  "push",
  "settled",
  "unsettled",
] as const;

const csvList = z
  .string()
  .min(1)
  .optional()
  .transform((v) =>
    v
      ? v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
  );

const QuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  eventFrom: z.string().datetime().optional(),
  eventTo: z.string().datetime().optional(),
  marketTypes: csvList,
  softProviders: csvList,
  settledBySources: csvList,
  outcome: z
    .enum(OUTCOME_VALUES)
    .optional()
    .transform((v) => (v === "push" ? ("void" as const) : v)),
  minEv: z.coerce.number().optional(),
  maxEv: z.coerce.number().optional(),
  search: z.string().min(1).max(120).optional(),
  readyToSettle: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  needsReview: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  placedOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  preMatchOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  oddsMin: z.coerce.number().positive().optional(),
  oddsMax: z.coerce.number().positive().optional(),
  minSharpProb: z.coerce.number().min(0).max(1).optional(),
  maxOddsAgeMs: z.coerce.number().int().nonnegative().optional(),
  minTickCount: z.coerce.number().int().nonnegative().optional(),
});

export async function GET(request: NextRequest) {
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  const parsed = QuerySchema.safeParse(params);
  if (!parsed.success) {
    return apiBadRequest(
      parsed.error.issues[0]?.message ?? "Invalid query parameters",
    );
  }
  try {
    const filters: ListFilters = parsed.data;
    const agg = await aggregateBets(filters);
    return apiSuccess(agg);
  } catch (err) {
    return apiServerError(err, "BetsStats");
  }
}
