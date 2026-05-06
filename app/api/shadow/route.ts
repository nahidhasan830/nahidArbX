import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ensureDbReady } from "@/lib/db/client";
import { db } from "@/lib/db/client";
import { shadowDecisions } from "@/lib/db/schema";
import { desc, and, isNotNull, sql, count, avg } from "drizzle-orm";

const querySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  resolved: z.enum(["true", "false"]).optional(),
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

  if (q.aggregate === "true") {
    // Build resolved filter
    const conditions = [];
    if (q.from) conditions.push(sql`${shadowDecisions.placedAt} >= ${q.from}`);
    if (q.to) conditions.push(sql`${shadowDecisions.placedAt} <= ${q.to}`);
    if (q.resolved === "true") {
      conditions.push(isNotNull(shadowDecisions.outcome));
    } else if (q.resolved === "false") {
      conditions.push(sql`${shadowDecisions.outcome} IS NULL`);
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [row] = await db
      .select({
        total: count(),
        resolved: count(shadowDecisions.outcome),
        avgMlMultiplier: avg(shadowDecisions.mlMultiplier),
        avgKellyRaw: avg(shadowDecisions.kellyRaw),
        wins: sql<number>`COUNT(*) FILTER (WHERE ${shadowDecisions.outcome} = 'win')`,
        losses: sql<number>`COUNT(*) FILTER (WHERE ${shadowDecisions.outcome} = 'lose')`,
        voids: sql<number>`COUNT(*) FILTER (WHERE ${shadowDecisions.outcome} = 'void')`,
      })
      .from(shadowDecisions)
      .where(where);

    return NextResponse.json({
      total: Number(row.total),
      resolved: Number(row.resolved),
      unresolved: Number(row.total) - Number(row.resolved),
      avgMlMultiplier: Number(row.avgMlMultiplier ?? 0).toFixed(4),
      avgKellyRaw: Number(row.avgKellyRaw ?? 0).toFixed(4),
      wins: Number(row.wins),
      losses: Number(row.losses),
      voids: Number(row.voids),
      winRate: Number(row.resolved) > 0
        ? (Number(row.wins) / Number(row.resolved) * 100).toFixed(1) + "%"
        : "—",
    });
  }

  // List individual shadow decisions
  const conditions = [];
  if (q.from) conditions.push(sql`${shadowDecisions.placedAt} >= ${q.from}`);
  if (q.to) conditions.push(sql`${shadowDecisions.placedAt} <= ${q.to}`);
  if (q.resolved === "true") {
    conditions.push(isNotNull(shadowDecisions.outcome));
  } else if (q.resolved === "false") {
    conditions.push(sql`${shadowDecisions.outcome} IS NULL`);
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select()
    .from(shadowDecisions)
    .where(where)
    .orderBy(desc(shadowDecisions.placedAt))
    .limit(q.limit)
    .offset(q.offset);

  return NextResponse.json({ rows, total: rows.length });
}
