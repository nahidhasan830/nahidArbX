import { NextRequest } from "next/server";
import { z } from "zod";
import {
  apiBadRequest,
  apiServerError,
  apiSuccess,
} from "@/lib/shared/api-response";
import {
  insertStrategy,
  listStrategies,
} from "@/lib/db/repositories/strategies";
import { summarizeStrategies } from "@/lib/db/repositories/strategy-executions";

const filtersSchema = z.record(z.string(), z.unknown());

const PostSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).nullish(),
  filters: filtersSchema,
  stakeMultiplier: z.number().positive().max(10).optional(),
  origin: z.enum(["manual", "ai"]).optional(),
  rationale: z.string().max(8000).nullish(),
  status: z.enum(["candidate", "live", "paused", "retired"]).optional(),
  metricsSnapshot: z.record(z.string(), z.unknown()).nullish(),
});

export async function GET(request: NextRequest) {
  const status = request.nextUrl.searchParams.get("status") ?? undefined;
  const origin = request.nextUrl.searchParams.get("origin") ?? undefined;
  try {
    const rows = await listStrategies({
      status: status as never,
      origin: origin as never,
    });
    const summaries = await summarizeStrategies(rows.map((r) => r.id));
    const withSummary = rows.map((r) => ({
      ...r,
      summary: summaries[r.id] ?? null,
    }));
    return apiSuccess({ rows: withSummary });
  } catch (err) {
    return apiServerError(err, "Strategies:list");
  }
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiBadRequest("Invalid JSON body");
  }
  const parsed = PostSchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest(
      parsed.error.issues[0]?.message ?? "Invalid strategy payload",
    );
  }

  try {
    const row = await insertStrategy({
      ...parsed.data,
      description: parsed.data.description ?? null,
      rationale: parsed.data.rationale ?? null,
      metricsSnapshot: parsed.data.metricsSnapshot ?? null,
    });
    return apiSuccess({ row });
  } catch (err) {
    return apiServerError(err, "Strategies:create");
  }
}
