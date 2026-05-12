import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ensureDbReady } from "@/lib/db/client";
import {
  listAiActivityLog,
  aggregateAiActivityLog,
  type AiActivityLogFilters,
} from "@/lib/db/repositories/ai-activity-log";

const querySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  systems: z.string().optional(), // comma-separated
  statuses: z.string().optional(), // comma-separated
  triggers: z.string().optional(), // comma-separated
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  aggregate: z.enum(["true", "false"]).default("false"),
});

export async function GET(req: NextRequest) {
  try {
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
    const filters: AiActivityLogFilters = {
      from: q.from,
      to: q.to,
      systems: q.systems?.split(",").filter(Boolean),
      statuses: q.statuses?.split(",").filter(Boolean),
      triggers: q.triggers?.split(",").filter(Boolean),
      search: q.search,
      limit: q.limit,
      offset: q.offset,
    };

    if (q.aggregate === "true") {
      const stats = await aggregateAiActivityLog(filters);
      return NextResponse.json(stats);
    }

    const result = await listAiActivityLog(filters);
    return NextResponse.json(result);
  } catch (err) {
    console.error("AI Activity Log API error:", err);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
