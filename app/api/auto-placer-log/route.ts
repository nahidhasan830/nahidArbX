import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ensureDbReady } from "@/lib/db/client";
import {
  listAutoPlacerLog,
  aggregateAutoPlacerLog,
  type AutoPlacerLogFilters,
} from "@/lib/db/repositories/auto-placer-log";

const querySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  statuses: z.string().optional(), // comma-separated
  gates: z.string().optional(), // comma-separated
  softProviders: z.string().optional(), // comma-separated
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  aggregate: z.enum(["true", "false"]).default("false"),
});

export async function GET(req: NextRequest) {
  await ensureDbReady();
  const params = Object.fromEntries(req.nextUrl.searchParams.entries());
  const parsed = querySchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const q = parsed.data;
  const filters: AutoPlacerLogFilters = {
    from: q.from,
    to: q.to,
    statuses: q.statuses?.split(",").filter(Boolean),
    gates: q.gates?.split(",").filter(Boolean),
    softProviders: q.softProviders?.split(",").filter(Boolean),
    search: q.search,
    limit: q.limit,
    offset: q.offset,
  };

  if (q.aggregate === "true") {
    const stats = await aggregateAutoPlacerLog(filters);
    return NextResponse.json(stats);
  }

  const result = await listAutoPlacerLog(filters);
  return NextResponse.json(result);
}
