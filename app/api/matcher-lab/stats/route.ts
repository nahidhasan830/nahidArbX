/**
 * Matcher Lab Stats API
 *
 * GET — per-stage counts + config from Postgres + run history from Postgres.
 * All data comes from the database — the ML server is the sole processor,
 * this route is read-only.
 */

import { NextRequest, NextResponse } from "next/server";
import { getStageCounts } from "@/lib/db/repositories/match-pairs";
import { db } from "@/lib/db/client";
import { matcherConfig, matcherRuns } from "@/lib/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { logger } from "@/lib/shared/logger";

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const historyLimit = Math.min(
      Number(url.searchParams.get("historyLimit")) || 10,
      50,
    );

    const [stageCounts, configRows, runs, totalProcessedResult] =
      await Promise.all([
        getStageCounts(),
        db.select().from(matcherConfig).where(eq(matcherConfig.id, "default")),
        db
          .select()
          .from(matcherRuns)
          .orderBy(desc(matcherRuns.startedAt))
          .limit(historyLimit),
        db
          .select({ total: sql<number>`SUM(processed)::int` })
          .from(matcherRuns),
      ]);

    const config = configRows[0] ?? null;

    const mlStats = config
      ? {
          active: config.enabled,
          processing: false,
          intervalMs: config.intervalMs,
          lastRunAt: runs[0]?.completedAt ?? null,
          lastBatchSize: runs[0]?.processed ?? 0,
          totalProcessed: totalProcessedResult[0]?.total ?? 0,
        }
      : null;

    const history = runs.map((r) => ({
      runAt: r.startedAt,
      durationMs: r.durationMs ?? 0,
      processed: r.processed,
      merged: r.merged,
      rejected: r.rejected,
      escalated: r.escalated,
      status: r.status as
        | "success"
        | "empty"
        | "service_unreachable"
        | "already_running",
      trigger: r.trigger as "scheduler" | "manual",
    }));

    return NextResponse.json({
      stageCounts,
      mlStats,
      history,
      historyTotal: history.length,
      hasMoreHistory: history.length >= historyLimit,
      config: config
        ? {
            enabled: config.enabled,
            intervalMs: config.intervalMs,
            teamMergeThreshold: config.teamMergeThreshold,
            compMergeThreshold: config.compMergeThreshold,
            combinedMergeThreshold: config.combinedMergeThreshold,
            combinedRejectThreshold: config.combinedRejectThreshold,
            xeEscalationEnabled: config.xeEscalationEnabled,
            xeMergeThreshold: config.xeMergeThreshold,
            xePvalueThreshold: config.xePvalueThreshold,
          }
        : null,
    });
  } catch (err) {
    logger.error("MatcherLabStats", `GET failed: ${(err as Error).message}`);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
