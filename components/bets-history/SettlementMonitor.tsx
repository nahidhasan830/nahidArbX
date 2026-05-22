"use client";

/**
 * Settlement Activity Monitor — operator control panel for the
 * auto-settlement scheduler. Surfaces:
 *   - Live status + pause / resume / start / stop controls
 *   - Stream of in-memory activity entries (tick starts/ends, errors)
 *   - Persistent `settlement_runs` history with tier-hit breakdown
 *
 * Opened via a toolbar button on `/bets`. Uses SSE where possible,
 * falls back to 5s polling.
 */

import { useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { toast } from "sonner";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Gauge,
  Pause,
  Play,
  RefreshCw,
  Square,
  Zap,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { useSettlementMonitor } from "@/lib/bets-history/use-settlement-monitor";

import {
  postSettlementAction,
  type SettlementAction,
  type SettlementActivityEntry,
  type SettlementRunRowApi,
} from "@/lib/bets-history/api-client";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function statusTone(
  active: boolean,
  paused: boolean,
  tickInFlight: boolean,
): { label: string; className: string; Icon: typeof Activity } {
  if (!active) {
    return {
      label: "Stopped",
      className: "bg-zinc-500/20 text-zinc-300 border-zinc-500/40",
      Icon: Square,
    };
  }
  if (paused) {
    return {
      label: "Paused",
      className: "bg-amber-500/20 text-amber-300 border-amber-500/40",
      Icon: Pause,
    };
  }
  if (tickInFlight) {
    return {
      label: "Running tick…",
      className: "bg-sky-500/20 text-sky-300 border-sky-500/40",
      Icon: Activity,
    };
  }
  return {
    label: "Healthy",
    className: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
    Icon: CheckCircle2,
  };
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatRelative(ts: number | null, now: number): string {
  if (!ts) return "—";
  const diffMs = ts - now;
  const isFuture = diffMs > 0;
  const absDiff = Math.abs(diffMs);

  const val = (() => {
    if (absDiff < 60_000) return `${Math.round(absDiff / 1000)}s`;
    if (absDiff < 3_600_000) return `${Math.round(absDiff / 60_000)}m`;
    return `${Math.round(absDiff / 3_600_000)}h`;
  })();

  return isFuture ? `in ${val}` : `${val} ago`;
}

const LEVEL_CLASS: Record<SettlementActivityEntry["level"], string> = {
  debug: "text-zinc-400",
  info: "text-sky-300",
  warn: "text-amber-300",
  error: "text-red-300",
};

export function SettlementMonitor({ open, onOpenChange }: Props) {
  const { status, activity, loading, error, sseConnected, refresh } =
    useSettlementMonitor(open);
  const [busy, setBusy] = useState<SettlementAction | null>(null);
  const [intervalInput, setIntervalInput] = useState("");

  const ACTION_LABELS: Record<string, { success: string; emoji: string }> = {
    run: { success: "Tick triggered", emoji: "⚡" },
    pause: { success: "Scheduler paused", emoji: "⏸️" },
    resume: { success: "Scheduler resumed", emoji: "▶️" },
    start: { success: "Scheduler started", emoji: "🚀" },
    stop: { success: "Scheduler stopped", emoji: "⏹️" },
    restart: { success: "Scheduler restarted", emoji: "🔄" },
  };

  const runAction = async (
    action: SettlementAction,
    opts?: { intervalMs?: number; reason?: string },
    successMessage?: string,
  ) => {
    setBusy(action);
    try {
      await postSettlementAction(action, opts);
      const meta = ACTION_LABELS[action];
      const msg = successMessage ?? meta?.success ?? `${action} completed`;
      const emoji = meta?.emoji ?? "⚙️";
      toast.success(`${emoji} ${msg}`);
      await refresh();
    } catch (err) {
      toast.error(`❌ ${action} failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const handleRestartWithInterval = async () => {
    const seconds = Number(intervalInput);
    if (!Number.isFinite(seconds) || seconds < 30) {
      toast.error("⚠️ Interval must be at least 30 seconds");
      return;
    }
    await runAction(
      "restart",
      { intervalMs: Math.round(seconds * 1000) },
      `Scheduler restarted at ${seconds}s interval`,
    );
    setIntervalInput("");
  };

  const tone = status
    ? statusTone(status.active, status.paused, status.tickInFlight)
    : null;

  const now = Date.now();
  const recentActivity = useMemo(() => [...activity].reverse(), [activity]);

  // Fallback to database history if the in-memory scheduler state was reset (e.g. after server restart)
  const lastFinishedTs =
    status?.lastFinishedAt ??
    (status?.recentRuns?.[0]
      ? new Date(status.recentRuns[0].finishedAt).getTime()
      : null);

  const lastDurationMs =
    status?.lastDurationMs ??
    (status?.recentRuns?.[0] ? status.recentRuns[0].durationMs : null);

  // Next-trigger estimate — based on last-finished-at + interval. Only
  // meaningful while the scheduler is running and not paused/disabled.
  const nextTriggerAt: number | null = (() => {
    if (!status) return null;
    if (!status.active || status.paused) return null;
    const base = status.lastStartedAt ?? lastFinishedTs;
    if (!base) return now; // just started — next tick any moment
    return base + status.intervalMs;
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl w-[95vw] h-[85vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 pt-4 pb-3 border-b border-border space-y-1">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Activity className="size-4 text-muted-foreground" />
              <DialogTitle className="text-[15px]">
                Settlement Activity Monitor
              </DialogTitle>
            </div>
            {/* Live indicator, refresh, and the dialog's implicit close sit
                in the top-right. Refresh is pushed further from the Live
                pill with `mr-8` so it doesn't crash into the built-in X
                that Radix renders. */}
            <div className="flex items-center gap-3">
              <span
                className={cn(
                  "inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border",
                  sseConnected
                    ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
                    : "bg-zinc-500/10 text-zinc-400 border-zinc-500/30",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    sseConnected
                      ? "bg-emerald-400 animate-pulse"
                      : "bg-zinc-500",
                  )}
                />
                {sseConnected ? "Live" : "Polling"}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 mr-6"
                onClick={() => refresh()}
                disabled={loading}
                title={
                  sseConnected
                    ? "Force manual refresh (Live updates are already active)"
                    : "Refresh data"
                }
              >
                <RefreshCw
                  className={cn("size-3.5", loading && "animate-spin")}
                />
              </Button>
            </div>
          </div>
          <DialogDescription className="text-[11px]">
            Control the auto-settlement scheduler and inspect its recent
            activity. Ticks sweep bets past their settlement threshold every
            interval.
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-3 border-b border-border bg-muted/30 space-y-3">
          {/* Status header */}
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              {tone && (
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium border",
                    tone.className,
                  )}
                >
                  <tone.Icon className="size-3.5" />
                  {tone.label}
                </span>
              )}
              {status && (
                <>
                  <span className="text-[10px] text-muted-foreground">
                    Interval:{" "}
                    <span className="tabular-nums text-foreground">
                      {Math.round(status.intervalMs / 1000)}s
                    </span>
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    Queued:{" "}
                    <span
                      className={cn(
                        "tabular-nums",
                        (status.queuedCount ?? 0) > 0
                          ? "text-amber-300"
                          : "text-foreground",
                      )}
                      title="Pending bets whose kickoff was >2h15m ago — next tick will sweep them."
                    >
                      {status.queuedCount ?? 0}
                    </span>
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    Ticks:{" "}
                    <span className="tabular-nums text-foreground">
                      {status.totalTicks}
                    </span>
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    Applied:{" "}
                    <span className="tabular-nums text-foreground">
                      {status.totalApplied}
                    </span>
                  </span>
                  {status.skippedTicks > 0 && (
                    <span className="text-[10px] text-muted-foreground">
                      Skipped:{" "}
                      <span className="tabular-nums text-amber-300">
                        {status.skippedTicks}
                      </span>
                    </span>
                  )}
                  <span className="text-[10px] text-muted-foreground">
                    Last run:{" "}
                    <span className="tabular-nums text-foreground">
                      {formatRelative(lastFinishedTs, now)}
                    </span>{" "}
                    ({formatDuration(lastDurationMs)})
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    Next run:{" "}
                    <span className="tabular-nums text-foreground">
                      {nextTriggerAt ? formatRelative(nextTriggerAt, now) : "—"}
                    </span>
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="default"
              size="sm"
              className="h-7 px-2.5 text-[11px]"
              onClick={() => runAction("run", undefined, "Tick triggered")}
              disabled={!!busy || !status || status.tickInFlight}
            >
              <Zap className="size-3.5" /> Run now
            </Button>

            {status?.paused ? (
              <Button
                variant="secondary"
                size="sm"
                className="h-7 px-2.5 text-[11px]"
                onClick={() =>
                  runAction("resume", undefined, "Scheduler resumed")
                }
                disabled={!!busy}
              >
                <Play className="size-3.5" /> Resume
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                className="h-7 px-2.5 text-[11px]"
                onClick={() =>
                  runAction("pause", undefined, "Scheduler paused")
                }
                disabled={!!busy || !status || !status.active}
              >
                <Pause className="size-3.5" /> Pause
              </Button>
            )}

            {status?.active ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2.5 text-[11px]"
                onClick={() =>
                  runAction("stop", undefined, "Scheduler stopped")
                }
                disabled={!!busy}
              >
                <Square className="size-3.5" /> Stop
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2.5 text-[11px]"
                onClick={() =>
                  runAction("start", undefined, "Scheduler started")
                }
                disabled={!!busy}
              >
                <Play className="size-3.5" /> Start
              </Button>
            )}

            <div className="flex items-center gap-1.5">
              <Input
                type="number"
                min={30}
                step={30}
                value={intervalInput}
                onChange={(e) => setIntervalInput(e.target.value)}
                placeholder="interval seconds"
                className="h-7 w-40 text-[11px]"
              />
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2.5 text-[11px]"
                onClick={handleRestartWithInterval}
                disabled={!!busy || !intervalInput}
              >
                <Gauge className="size-3.5" /> Apply
              </Button>
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-1.5 text-[11px] text-red-300">
              <AlertTriangle className="size-3.5" /> {error}
            </div>
          )}
          {status?.lastError && (
            <div className="flex items-center gap-1.5 text-[11px] text-red-300">
              <AlertTriangle className="size-3.5" /> Last tick error:{" "}
              {status.lastError}
            </div>
          )}
          {status?.lastResult?.sourceIssues &&
            status.lastResult.sourceIssues.length > 0 && (
              <div className="flex items-start gap-1.5 text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2.5 py-1.5">
                <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
                <div className="space-y-0.5">
                  <span className="font-medium">Data source degraded</span>
                  {status.lastResult.sourceIssues.map((issue, i) => (
                    <div key={i} className="text-amber-200/80">
                      {issue}
                    </div>
                  ))}
                </div>
              </div>
            )}
        </div>

        {/* Tabs */}
        <Tabs defaultValue="activity" className="flex-1 min-h-0 flex flex-col">
          <TabsList variant="line" className="mx-5 mt-2 shrink-0 justify-start">
            <TabsTrigger value="activity" className="text-[12px]">
              Live activity{" "}
              <Badge variant="secondary" className="ml-1.5 h-4 text-[10px]">
                {activity.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="runs" className="text-[12px]">
              Recent runs{" "}
              <Badge variant="secondary" className="ml-1.5 h-4 text-[10px]">
                {status?.recentRuns.length ?? 0}
              </Badge>
            </TabsTrigger>
          </TabsList>

          <TabsContent
            value="activity"
            className="flex-1 min-h-0 px-5 pb-4 mt-2"
          >
            <ScrollArea className="h-full rounded border border-border bg-background/50">
              {recentActivity.length === 0 ? (
                <div className="p-6 text-center text-[12px] text-muted-foreground">
                  No activity yet. Ticks will appear here as they run.
                </div>
              ) : (
                <div className="divide-y divide-border/60">
                  {recentActivity.map((entry) => (
                    <ActivityRow
                      key={entry.id}
                      entry={entry}
                      levelClass={LEVEL_CLASS[entry.level]}
                    />
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          <TabsContent value="runs" className="flex-1 min-h-0 px-5 pb-4 mt-2">
            <div className="flex items-center justify-between mb-2 text-[11px] text-muted-foreground">
              <span>
                Showing last {status?.recentRuns.length ?? 0} persisted ticks
                from <code className="text-foreground">settlement_runs</code>.
              </span>
            </div>
            <ScrollArea className="h-full rounded border border-border bg-background/50">
              {!status || status.recentRuns.length === 0 ? (
                <div className="p-6 text-center text-[12px] text-muted-foreground">
                  No runs recorded yet.
                </div>
              ) : (
                <table className="w-full text-[11px]">
                  <thead className="bg-muted/40 text-[10px] uppercase text-muted-foreground sticky top-0">
                    <tr>
                      <th className="text-left px-3 py-1.5">Started</th>
                      <th className="text-right px-2 py-1.5">Duration</th>
                      <th className="text-right px-2 py-1.5">Scanned</th>
                      <th className="text-right px-2 py-1.5">Applied</th>
                      <th className="text-right px-2 py-1.5">Pending</th>
                      <th className="text-left px-2 py-1.5">Tiers</th>
                      <th className="text-left px-3 py-1.5">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.recentRuns.map((run) => (
                      <RunRow key={run.id} run={run} />
                    ))}
                  </tbody>
                </table>
              )}
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function ActivityRow({
  entry,
  levelClass,
}: {
  entry: SettlementActivityEntry;
  levelClass: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasData = entry.data && Object.keys(entry.data).length > 0;
  return (
    <div
      className={cn(
        "px-3 py-1.5 flex flex-col gap-0.5 hover:bg-muted/30",
        hasData && "cursor-pointer",
      )}
      onClick={() => hasData && setExpanded((v) => !v)}
    >
      <div className="flex items-start gap-2 text-[11px]">
        <span className="tabular-nums text-muted-foreground shrink-0 w-20">
          {format(new Date(entry.ts), "HH:mm:ss")}
        </span>
        <span
          className={cn(
            "uppercase tracking-wide text-[9px] shrink-0 w-16",
            levelClass,
          )}
        >
          {entry.level}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground shrink-0 w-24">
          {entry.kind}
        </span>
        <span className="text-foreground flex-1">{entry.message}</span>
      </div>
      {expanded && hasData && (
        <pre className="ml-36 mt-1 text-[10px] bg-muted/40 p-2 rounded overflow-x-auto text-muted-foreground">
          {JSON.stringify(entry.data, null, 2)}
        </pre>
      )}
    </div>
  );
}

function RunRow({ run }: { run: SettlementRunRowApi }) {
  return (
    <tr className="border-b border-border/40 hover:bg-muted/20">
      <td className="px-3 py-1 tabular-nums">
        {format(parseISO(run.startedAt), "MMM d, yyyy HH:mm:ss")}
      </td>
      <td className="px-2 py-1 text-right tabular-nums">
        {(run.durationMs / 1000).toFixed(1)}s
      </td>
      <td className="px-2 py-1 text-right tabular-nums">{run.scannedBets}</td>
      <td className="px-2 py-1 text-right tabular-nums text-emerald-300">
        {run.applied}
      </td>
      <td className="px-2 py-1 text-right tabular-nums">{run.stillPending}</td>
      <td className="px-2 py-1 font-mono text-[10px] text-muted-foreground">
        {[
          run.tier0Hits && `T0:${run.tier0Hits}`,
          run.tier1Hits && `T1:${run.tier1Hits}`,
          run.tier2Hits && `T2:${run.tier2Hits}`,
          run.tier3Hits && `T3:${run.tier3Hits}`,
          run.tier4Hits && `T4:${run.tier4Hits}`,
        ]
          .filter(Boolean)
          .join(" ") || "—"}
      </td>
      <td className="px-3 py-1 text-red-300 max-w-[200px] truncate">
        {run.error || run.abortedReason || (
          <span className="text-muted-foreground/60">—</span>
        )}
      </td>
    </tr>
  );
}

export function SettlementStatusChip({ onClick }: { onClick: () => void }) {
  const { status } = useSettlementMonitor(true);
  if (!status)
    return (
      <Button
        variant="outline"
        size="sm"
        className="h-7 px-2 text-[11px] gap-1"
        onClick={onClick}
      >
        <Activity className="size-3.5" /> Settlement
      </Button>
    );
  const tone = statusTone(status.active, status.paused, status.tickInFlight);
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn(
        "h-7 px-2 text-[11px] gap-1 border-transparent",
        tone.className,
      )}
      onClick={onClick}
      title={`Settlement: ${tone.label} — click to open monitor`}
    >
      <tone.Icon className="size-3.5" />
      <span className="hidden sm:inline">Settlement</span>
      <span className="opacity-80">·</span>
      <span>{tone.label}</span>
    </Button>
  );
}
