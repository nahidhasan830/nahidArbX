"use client";

/**
 * Overview tab — at-a-glance health of the entity-resolution system.
 *
 *   • KPI strip (entities active, candidate names, observations 24h,
 *                promotions today, retirements today, avg classifier score)
 *   • Sparkline of observations / hour, last 24h
 *   • Per-source donut (where observations come from)
 *   • Classifier-score histogram (bimodal = healthy)
 *   • Active Job card (live progress if a Cloud Run Job is running)
 */

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Activity, GitMerge, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { fetchHealth, triggerResolverJob } from "./api";
import {
  BarChart,
  KpiCard,
  RunStatusPill,
  Sparkline,
  relativeTime,
} from "./atoms";
import type { HealthSnapshot } from "./types";

const REFRESH_MS_IDLE = 30_000;
const REFRESH_MS_ACTIVE = 3_000;

export function OverviewPanel({ onJumpToRuns }: { onJumpToRuns: () => void }) {
  const [data, setData] = useState<HealthSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const d = await fetchHealth();
        if (alive) {
          setData(d);
        }
      } catch {
        /* ignore */
      }
    };
    // Initial fetch.
    void refresh();
    // Adaptive cadence: while a Job is active the interval is short,
    // otherwise we poll lazily.
    const interval = data?.activeRun ? REFRESH_MS_ACTIVE : REFRESH_MS_IDLE;
    const t = setInterval(() => {
      void refresh();
    }, interval);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [data?.activeRun]);

  // 1-second tick so the "next promoter run" countdown actually decrements
  // smoothly instead of snapping every 30 s.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const onTrigger = async () => {
    const r = await triggerResolverJob();
    if (r.error) {
      toast.error("Trigger failed", { description: r.error });
      return;
    }
    toast.success("Cleanup Job triggered", { description: `Run ${r.runId}` });
    void (async () => setData(await fetchHealth()))();
  };

  const onRefresh = async () => {
    setLoading(true);
    try {
      setData(await fetchHealth());
    } finally {
      setLoading(false);
    }
  };

  // Per-hour totals across outcomes for the sparkline
  const hourlyTotals = (() => {
    if (!data?.observationsTimeline.length) return [] as number[];
    const buckets = new Map<string, number>();
    for (const r of data.observationsTimeline) {
      buckets.set(r.bucket, (buckets.get(r.bucket) ?? 0) + r.n);
    }
    return Array.from(buckets.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, n]) => n);
  })();

  const histogramValues = data?.classifierHistogram?.length
    ? Array.from({ length: 10 }, (_, i) => {
        const m = data.classifierHistogram.find((b) => b.bucket === i + 1);
        return m?.n ?? 0;
      })
    : [];
  const histogramLabels = ["0", "", "", "", "0.5", "", "", "", "", "1"];

  const totalObs = data?.observationsBySource.reduce((s, r) => s + r.n, 0) ?? 0;

  const sched = data?.scheduler;
  const promoterRunningSoon = sched?.nextPromoteAt
    ? Math.max(0, Math.round((sched.nextPromoteAt - now) / 1000))
    : null;
  const promoterLastRan = sched?.lastPromoteAt
    ? new Date(sched.lastPromoteAt).toISOString()
    : null;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="p-4 space-y-4 overflow-y-auto h-full">
        <div className="flex items-center justify-between">
          <div className="text-[11px] text-zinc-500">
            Updated {relativeTime(new Date(now).toISOString())} · auto-refresh{" "}
            {data?.activeRun
              ? `${REFRESH_MS_ACTIVE / 1000}s`
              : `${REFRESH_MS_IDLE / 1000}s`}
          </div>
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onRefresh}
                  disabled={loading}
                  className="h-8 w-8 p-0"
                  aria-label="Refresh"
                >
                  <RefreshCw
                    className={
                      loading ? "w-3.5 h-3.5 animate-spin" : "w-3.5 h-3.5"
                    }
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh stats now</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  onClick={onTrigger}
                  disabled={!!data?.activeRun}
                  className="h-8 px-3 text-xs font-medium gap-1.5 bg-violet-500 hover:bg-violet-400 text-white border border-violet-400/40 shadow-sm disabled:opacity-60"
                >
                  {data?.activeRun ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <GitMerge className="w-3.5 h-3.5" />
                  )}
                  {data?.activeRun ? "Running…" : "Run cleanup"}
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-sm leading-snug">
                Run the entity-resolver Cloud Run Job. It scans every alias for
                duplicates, merges high-confidence pairs (Splink prob &gt;
                0.99), and queues the rest for review. Safe to run any time —
                billed per execution, ~3 min on a normal dataset.
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Live pipeline status — proves the system is alive */}
        <div className="rounded border border-zinc-800 bg-zinc-900/50 px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-2 text-[11px]">
                <span
                  className={
                    sched?.active
                      ? "size-2 rounded-full bg-emerald-400 animate-pulse"
                      : "size-2 rounded-full bg-zinc-600"
                  }
                />
                <span className="text-zinc-400 font-medium">Promoter</span>
                <span className="text-zinc-500">
                  {sched?.active ? "running" : "stopped"}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-sm leading-snug">
              The promoter is an in-process scheduler that wakes every 5 minutes
              and moves candidate aliases to active when their evidence weight
              clears the threshold. It runs inside the Next.js server, not as a
              Cloud Run Job — no external trigger needed.
            </TooltipContent>
          </Tooltip>
          {promoterLastRan && (
            <div className="text-[11px] text-zinc-500">
              last tick{" "}
              <span className="text-zinc-300">
                {relativeTime(promoterLastRan)}
              </span>
            </div>
          )}
          {promoterRunningSoon != null && (
            <div className="text-[11px] text-zinc-500 tabular-nums">
              next in{" "}
              <span className="text-zinc-300">
                {promoterRunningSoon < 60
                  ? `${promoterRunningSoon}s`
                  : `${Math.floor(promoterRunningSoon / 60)}m ${promoterRunningSoon % 60}s`}
              </span>
            </div>
          )}
          {sched && (
            <div className="text-[11px] text-zinc-500 tabular-nums">
              promoted{" "}
              <span className="text-emerald-300">{sched.totalPromoted}</span>
              {" · "}
              demoted{" "}
              <span className="text-amber-300">{sched.totalDemoted}</span>
              {" · "}
              retired{" "}
              <span className="text-zinc-300">{sched.totalRetired}</span>
              {" since boot"}
            </div>
          )}
          {sched?.lastError && (
            <div className="text-[11px] text-rose-400 truncate">
              last error: {sched.lastError}
            </div>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="ml-auto flex items-center gap-2 text-[11px]">
                <span className="size-2 rounded-full bg-zinc-600" />
                <span className="text-zinc-400 font-medium">Cleanup Job</span>
                <span className="text-zinc-500 tabular-nums">
                  {data?.activeRun
                    ? "in flight"
                    : sched?.lastDecayAt
                      ? `${data ? "" : "—"}idle`
                      : "never run"}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-sm leading-snug">
              The Cloud Run cleanup Job (Splink + Leiden) is a separate,
              operator-triggered task. It does not auto-run — click the
              &ldquo;Run cleanup&rdquo; button to fire one. Track per-run
              progress in the Job runs tab.
            </TooltipContent>
          </Tooltip>
        </div>

        {/* KPI grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
          <KpiCard
            label="Active entities"
            value={data?.stats.entitiesActive ?? "—"}
          />
          <KpiCard
            label="Active surfaces"
            value={data?.stats.namesActive ?? "—"}
            tone="good"
          />
          <KpiCard
            label="Candidate"
            value={data?.stats.namesCandidate ?? "—"}
            tone="warn"
            hint="awaiting promotion"
          />
          <KpiCard
            label="Retired"
            value={data?.stats.namesRetired ?? "—"}
            tone="bad"
          />
          <KpiCard
            label="Observations / 24h"
            value={data?.stats.observations24h ?? "—"}
          />
          <KpiCard
            label="Entities retired"
            value={data?.stats.entitiesRetired ?? "—"}
            tone="bad"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <Card title="Observations · last 24h">
            <Sparkline
              values={hourlyTotals}
              width={400}
              height={60}
              stroke="rgb(167 139 250)"
              fill="rgb(167 139 250)"
            />
            <div className="text-[10px] text-zinc-500 mt-1 tabular-nums">
              Total {hourlyTotals.reduce((a, b) => a + b, 0)} ·{" "}
              {hourlyTotals.length} hour buckets
            </div>
          </Card>

          <Card title="Writers · last 24h">
            {data?.observationsBySource?.length ? (
              <ul className="space-y-1.5">
                {data.observationsBySource.map((r) => {
                  const pct = totalObs > 0 ? (r.n / totalObs) * 100 : 0;
                  return (
                    <li key={r.source} className="text-[11px]">
                      <div className="flex justify-between text-zinc-400">
                        <span>{r.source}</span>
                        <span className="tabular-nums">
                          {r.n}{" "}
                          <span className="text-zinc-600">
                            ({pct.toFixed(1)}%)
                          </span>
                        </span>
                      </div>
                      <div className="h-1.5 mt-0.5 bg-zinc-800 rounded overflow-hidden">
                        <div
                          className="h-full bg-violet-500/70"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="text-[11px] text-zinc-500 py-6 text-center">
                No observations in last 24h
              </div>
            )}
          </Card>

          <Card title="Classifier-score distribution">
            <BarChart
              values={histogramValues}
              labels={histogramLabels}
              width={400}
              height={70}
            />
            <div className="text-[10px] text-zinc-500 mt-1">
              Bimodal (peaks at 0 and 1) = healthy classifier; flat =
              under-trained.
            </div>
          </Card>
        </div>

        {/* Active Job card */}
        {data?.activeRun && (
          <div className="rounded border border-sky-700/50 bg-sky-950/30 p-4">
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-sky-400 animate-pulse" />
                <div>
                  <div className="text-sm font-semibold text-zinc-100">
                    Cleanup Job in flight
                  </div>
                  <div className="text-[10px] text-zinc-500 font-mono">
                    {data.activeRun.id}
                  </div>
                </div>
              </div>
              <RunStatusPill status={data.activeRun.status} />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2">
              <KpiCard
                label="Current pass"
                value={
                  <span className="text-sm">
                    {data.activeRun.currentPass ?? "—"}
                  </span>
                }
              />
              <KpiCard
                label="Started"
                value={
                  <span className="text-sm">
                    {relativeTime(data.activeRun.startedAt)}
                  </span>
                }
              />
              <KpiCard
                label="Embeddings written"
                value={String(
                  (data.activeRun.progress?.embeddings_written as number) ?? 0,
                )}
              />
              <KpiCard
                label="Splink merges"
                value={String(
                  (data.activeRun.progress?.splink_merges as number) ?? 0,
                )}
              />
            </div>
            <div className="flex justify-end mt-2">
              <button
                onClick={onJumpToRuns}
                className="text-[11px] text-sky-300 hover:text-sky-200"
              >
                Open Job runs panel →
              </button>
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded border border-zinc-800/60 bg-zinc-900/30 p-3">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-2">
        {title}
      </div>
      {children}
    </div>
  );
}
