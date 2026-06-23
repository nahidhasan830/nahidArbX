
import { NextRequest } from "next/server";
import { z } from "zod";
import {
  apiBadRequest,
  apiServerError,
  apiSuccess,
} from "@/lib/shared/api-response";
import { listRecentSettlementRuns } from "@/lib/db/repositories/settlement-runs";
import { db } from "@/lib/db/client";
import { bets } from "@/lib/db/schema";
import { and, eq, sql as dsql } from "drizzle-orm";
import { engineGet, enginePost } from "@/lib/engine-proxy";

const BodySchema = z
  .object({
    action: z
      .enum(["run", "start", "stop", "restart", "pause", "resume"])
      .default("run"),
    intervalMs: z.number().int().positive().optional(),
  })
  .optional();

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const runsParam = url.searchParams.get("runs");
  const logParam = url.searchParams.get("log");
  const runsLimit = Math.min(Math.max(Number(runsParam ?? 20), 0), 200);
  const logLimit = Math.min(Math.max(Number(logParam ?? 100), 0), 200);

  const [recentRuns, queuedRow] = await Promise.all([
    runsLimit > 0 ? listRecentSettlementRuns(runsLimit) : [],
    db
      .select({ n: dsql<number>`count(*)::int` })
      .from(bets)
      .where(
        and(
          eq(bets.outcome, "pending"),
          dsql`${bets.eventStartTime} <= NOW() - INTERVAL '2 hours 15 minutes'`,
        ),
      ),
  ]);
  const queuedCount = queuedRow[0]?.n ?? 0;

  const engineStatus = await engineGet<Record<string, unknown>>(
    `/engine/settlement?log=${logLimit}`,
  );

  if (engineStatus) {
    return apiSuccess({
      ...engineStatus,
      queuedCount,
      recentRuns,
    });
  }

  return apiSuccess({
    active: false,
    paused: false,
    intervalMs: null,
    tickInFlight: false,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastDurationMs: null,
    lastResult: null,
    lastError: null,
    totalTicks: 0,
    totalApplied: 0,
    skippedTicks: 0,
    queuedCount,
    recentRuns,
    activity: [],
    _engineOffline: true,
  });
}

export async function POST(request: NextRequest) {
  let raw: unknown = undefined;
  try {
    const text = await request.text();
    raw = text ? JSON.parse(text) : undefined;
  } catch {
    return apiBadRequest("Body must be valid JSON (or empty).");
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return apiBadRequest(parsed.error.issues[0]?.message ?? "Invalid body");
  }

  const action = parsed.data?.action ?? "run";
  const intervalMs = parsed.data?.intervalMs;

  try {
    const result = await enginePost("/engine/settlement", {
      action,
      intervalMs,
    });
    if (result === null) {
      return apiServerError(
        new Error("Engine unreachable — cannot control settlement scheduler"),
        "Settlement:proxy",
      );
    }
    return apiSuccess(result);
  } catch (err) {
    return apiServerError(err, "Settlement:autoSettle");
  }
}
