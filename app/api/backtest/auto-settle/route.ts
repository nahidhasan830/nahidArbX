import { NextRequest } from "next/server";
import { z } from "zod";
import {
  apiBadRequest,
  apiServerError,
  apiSuccess,
} from "@/lib/shared/api-response";
import {
  disableAutoSettleScheduler,
  enableAutoSettleScheduler,
  getAutoSettleStatus,
  isAutoSettleActive,
  pauseAutoSettleScheduler,
  restartAutoSettleScheduler,
  resumeAutoSettleScheduler,
  startAutoSettleScheduler,
  stopAutoSettleScheduler,
  triggerAutoSettleNow,
} from "@/lib/settle/scheduler";
import { listRecentSettlementRuns } from "@/lib/db/repositories/settlement-runs";
import { getActivityLog } from "@/lib/settle/activity-log";
import { db } from "@/lib/db/client";
import { valueBets } from "@/lib/db/schema";
import { and, eq, sql as dsql } from "drizzle-orm";

/**
 * GET  → current scheduler status + recent settlement_runs (query
 *        `?runs=50`) + in-memory activity log (query `?log=100`).
 *
 * POST → body { action, intervalMs?, reason? }.
 *        Actions:
 *          - run      — single tick synchronously, return result.
 *                       (default when body is missing)
 *          - start    — start the scheduler.
 *          - stop     — stop the scheduler (timer torn down).
 *          - restart  — stop + start, optionally with new `intervalMs`.
 *          - pause    — keep timer running, skip ticks.
 *          - resume   — un-pause.
 *          - disable  — engage persistent kill switch + stop.
 *                       Accepts optional `reason`.
 *          - enable   — lift persistent kill switch (does NOT auto-start;
 *                       caller issues `start` if they want that).
 */

const BodySchema = z
  .object({
    action: z
      .enum([
        "run",
        "start",
        "stop",
        "restart",
        "pause",
        "resume",
        "disable",
        "enable",
      ])
      .default("run"),
    intervalMs: z.number().int().positive().optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .optional();

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const runsParam = url.searchParams.get("runs");
  const logParam = url.searchParams.get("log");
  const runsLimit = Math.min(Math.max(Number(runsParam ?? 20), 0), 200);
  const logLimit = Math.min(Math.max(Number(logParam ?? 100), 0), 200);
  const recentRuns =
    runsLimit > 0 ? await listRecentSettlementRuns(runsLimit) : [];
  const activity = logLimit > 0 ? getActivityLog(logLimit) : [];

  // Count of bets the next tick will sweep — mirrors the "Ready to settle"
  // tab filter (outcome='pending' AND kickoff < NOW - 2h15m). Cheap
  // indexed count query, runs in a couple of ms.
  const queuedRow = await db
    .select({ n: dsql<number>`count(*)::int` })
    .from(valueBets)
    .where(
      and(
        eq(valueBets.outcome, "pending"),
        dsql`${valueBets.eventStartTime} <= NOW() - INTERVAL '2 hours 15 minutes'`,
      ),
    );
  const queuedCount = queuedRow[0]?.n ?? 0;

  return apiSuccess({
    ...getAutoSettleStatus(),
    queuedCount,
    recentRuns,
    activity,
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
  const reason = parsed.data?.reason;

  try {
    switch (action) {
      case "start":
        startAutoSettleScheduler(intervalMs);
        return apiSuccess(getAutoSettleStatus());
      case "stop":
        stopAutoSettleScheduler();
        return apiSuccess(getAutoSettleStatus());
      case "restart":
        restartAutoSettleScheduler(intervalMs);
        return apiSuccess(getAutoSettleStatus());
      case "pause":
        pauseAutoSettleScheduler();
        return apiSuccess(getAutoSettleStatus());
      case "resume":
        resumeAutoSettleScheduler();
        return apiSuccess(getAutoSettleStatus());
      case "disable":
        disableAutoSettleScheduler(reason);
        return apiSuccess(getAutoSettleStatus());
      case "enable":
        enableAutoSettleScheduler();
        // If the scheduler isn't running yet, bring it up — lifting
        // the switch without starting would be surprising UX.
        if (!isAutoSettleActive()) startAutoSettleScheduler(intervalMs);
        return apiSuccess(getAutoSettleStatus());
      case "run":
      default: {
        const result = await triggerAutoSettleNow();
        return apiSuccess({ result, status: getAutoSettleStatus() });
      }
    }
  } catch (err) {
    return apiServerError(err, "Backtest:autoSettle");
  }
}
