import { NextResponse } from "next/server";
import { z } from "zod";
import { listPredictionAuditRows } from "@/lib/db/repositories/ml-prediction-audit";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const querySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  modelVersion: z.coerce.number().int().positive().optional(),
  decision: z.string().optional(),
  marketType: z.string().optional(),
  eventId: z.string().min(1).optional(),
  settled: z.enum(["all", "settled", "pending"]).default("all"),
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

function splitParam(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", issues: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const q = parsed.data;
  const result = await listPredictionAuditRows({
    from: q.from,
    to: q.to,
    modelVersion: q.modelVersion,
    decisions: splitParam(q.decision),
    marketTypes: splitParam(q.marketType),
    eventId: q.eventId,
    settled: q.settled === "all" ? undefined : q.settled === "settled",
    search: q.search || undefined,
    limit: q.limit,
    offset: q.offset,
  });

  return NextResponse.json(result, {
    headers: { "Cache-Control": "private, no-cache" },
  });
}
