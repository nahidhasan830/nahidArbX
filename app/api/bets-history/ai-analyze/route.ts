import { NextRequest } from "next/server";
import { z } from "zod";
import {
  apiBadRequest,
  apiServerError,
  apiSuccess,
} from "@/lib/shared/api-response";
import { getBetsByIds, listBets } from "@/lib/db/repositories/bets";
import { analyzeBetsHistory } from "@/lib/ai/analyze-bets-history";

const MAX_BETS = 500;

const BodySchema = z.union([
  z.object({
    ids: z.array(z.string().min(1)).min(1).max(MAX_BETS),
    model: z.enum(["flash", "pro"]).default("flash"),
  }),
  z.object({
    filters: z.object({
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      marketType: z.string().min(1).optional(),
      softProvider: z.string().min(1).optional(),
      outcome: z
        .enum([
          "pending",
          "won",
          "half_won",
          "lost",
          "half_lost",
          "void",
          "push",
          "settled",
          "unsettled",
        ])
        .optional()
        .transform((v) => (v === "push" ? ("void" as const) : v)),
      minEv: z.number().optional(),
      limit: z.number().int().min(1).max(MAX_BETS).default(MAX_BETS),
    }),
    model: z.enum(["flash", "pro"]).default("flash"),
  }),
]);

export async function POST(request: NextRequest) {
  if (!process.env.GEMINI_API_KEY) {
    return apiBadRequest("GEMINI_API_KEY is not configured");
  }
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
    const rows =
      "ids" in parsed.data
        ? await getBetsByIds(parsed.data.ids)
        : (
            await listBets({
              ...parsed.data.filters,
              limit: parsed.data.filters.limit,
            })
          ).rows;

    if (rows.length === 0) {
      return apiBadRequest("No bets matched the request");
    }

    const analysis = await analyzeBetsHistory(rows, {
      model: parsed.data.model,
    });
    return apiSuccess({ analysis, analyzed: rows.length });
  } catch (err) {
    return apiServerError(err, "Backtest:aiAnalyze");
  }
}
