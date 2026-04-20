import { NextRequest } from "next/server";
import { z } from "zod";
import {
  apiBadRequest,
  apiServerError,
  apiSuccess,
} from "@/lib/shared/api-response";
import { proposeRules } from "@/lib/ai/propose-rules";

const SliceSchema = z.object({
  label: z.string(),
  dimensions: z.record(z.string(), z.string()),
  n: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  roiPct: z.number().nullable(),
  shrunkRoiPct: z.number().nullable(),
  clvPct: z.number().nullable(),
  avgEvPct: z.number(),
  z: z.number().nullable(),
  pAdj: z.number().nullable(),
});

const HeadlineSchema = z.object({
  totalRows: z.number().int().nonnegative(),
  settledRows: z.number().int().nonnegative(),
  winRatePct: z.number().nullable(),
  flatRoiPct: z.number().nullable(),
  meanClvPct: z.number().nullable(),
  beatCloseRatePct: z.number().nullable(),
  brier: z.number().nullable(),
});

const BodySchema = z.object({
  topSlices: z.array(SliceSchema).min(1).max(60),
  headline: HeadlineSchema,
  maxRules: z.number().int().min(1).max(10).optional(),
});

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiBadRequest("Invalid JSON body");
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest(
      parsed.error.issues[0]?.message ?? "Invalid propose payload",
    );
  }

  try {
    const result = await proposeRules(parsed.data);
    return apiSuccess(result);
  } catch (err) {
    return apiServerError(err, "Backtest:ai-propose");
  }
}
