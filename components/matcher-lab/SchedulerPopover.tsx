"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Clock, Loader2, Search, Sliders } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { updateScheduler, fetchStats } from "./api";
import type {
  MlSchedulerStats,
  MlRunHistoryEntry,
  MatcherConfigResponse,
} from "./types";
import { checkAiSearchHealth } from "./api";

interface SchedulerPopoverProps {
  mlStats: MlSchedulerStats | null;
  history: MlRunHistoryEntry[];
  hasMoreHistory: boolean;
  historyTotal: number;
  config: MatcherConfigResponse | null;
  onConfigSaved: () => void;
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const STATUS_BADGE: Record<
  MlRunHistoryEntry["status"],
  { label: string; className: string }
> = {
  success: {
    label: "OK",
    className: "border-emerald-700/40 text-emerald-400",
  },
  empty: {
    label: "Empty",
    className: "border-zinc-700/40 text-zinc-500",
  },
  service_unreachable: {
    label: "Unreachable",
    className: "border-red-700/40 text-red-400",
  },
  already_running: {
    label: "Busy",
    className: "border-amber-700/40 text-amber-400",
  },
};

const POPOVER_HEIGHT = "h-[280px]";

export function SchedulerPopover({
  mlStats,
  history,
  hasMoreHistory,
  historyTotal,
  config,
  onConfigSaved,
}: SchedulerPopoverProps) {
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(mlStats?.active ?? false);
  const [intervalSec, setIntervalSec] = useState(
    String((mlStats?.intervalMs ?? 60_000) / 1000),
  );
  const [aiSearchEnabled, setAiSearchEnabled] = useState(
    config?.aiSearchEnabled ?? true,
  );
  const [aiSearchThreshold, setAiSearchThreshold] = useState(
    config?.aiSearchConfidenceThreshold ?? 70,
  );
  const [aiSearchBatchSize, setAiSearchBatchSize] = useState(
    config?.aiSearchMaxBatchSize ?? 20,
  );
  const [aiSearchHealth, setAiSearchHealth] = useState<{
    ok: boolean;
    model?: string;
  } | null>(null);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [expandedHistory, setExpandedHistory] = useState<
    MlRunHistoryEntry[] | null
  >(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const displayHistory = expandedHistory ?? history;

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const ms = Math.round(Number(intervalSec) * 1000);
      if (isNaN(ms) || ms < 10_000) {
        toast.error("Interval must be at least 10 seconds");
        return;
      }
      await updateScheduler({
        enabled,
        intervalMs: ms,
        aiSearchEnabled,
        aiSearchConfidenceThreshold: aiSearchThreshold,
        aiSearchMaxBatchSize: aiSearchBatchSize,
      });
      toast.success("Scheduler config saved", {
        description: enabled
          ? `Running every ${intervalSec}s`
          : "Scheduler paused",
      });
      onConfigSaved();
    } catch (err) {
      toast.error("Failed to save", {
        description: (err as Error).message,
      });
    } finally {
      setSaving(false);
    }
  }, [
    enabled,
    intervalSec,
    aiSearchEnabled,
    aiSearchThreshold,
    aiSearchBatchSize,
    onConfigSaved,
  ]);

  const handleLoadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const data = await fetchStats({ historyLimit: 50 });
      setExpandedHistory(data.history);
    } catch {
      toast.error("Failed to load history");
    } finally {
      setLoadingMore(false);
    }
  }, []);

  const handleOpenChange = useCallback(
    async (open: boolean) => {
      if (open && mlStats) {
        setEnabled(mlStats.active);
        setIntervalSec(String(mlStats.intervalMs / 1000));
        setAiSearchEnabled(config?.aiSearchEnabled ?? true);
        setAiSearchThreshold(config?.aiSearchConfidenceThreshold ?? 70);
        setAiSearchBatchSize(config?.aiSearchMaxBatchSize ?? 20);
        setExpandedHistory(null);

        // Health check on open
        setCheckingHealth(true);
        const health = await checkAiSearchHealth();
        setAiSearchHealth(health);
        setCheckingHealth(false);
      }
    },
    [mlStats, config],
  );

  return (
    <Popover onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className={cn(
            "size-7 relative",
            mlStats?.active && "text-emerald-400",
          )}
          title="Configure the ML scheduler — interval, AI Search escalation, and processing log."
        >
          <Clock className="size-3.5" />
          {mlStats?.active && (
            <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-emerald-400" />
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        className={cn(
          "w-[400px] p-0 border-zinc-800 bg-zinc-950",
          POPOVER_HEIGHT,
        )}
      >
        <Tabs defaultValue="config" className="flex flex-col h-full">
          <TabsList className="w-full justify-start rounded-none border-b border-zinc-800/50 bg-transparent px-2 pt-2 shrink-0 gap-0">
            <TabsTrigger
              value="config"
              className="text-[11px] data-[state=active]:bg-zinc-800/60"
            >
              Config
            </TabsTrigger>
            <TabsTrigger
              value="ai-search"
              className="text-[11px] data-[state=active]:bg-zinc-800/60"
            >
              AI Search
            </TabsTrigger>
            <TabsTrigger
              value="history"
              className="text-[11px] data-[state=active]:bg-zinc-800/60"
            >
              Processing Log
            </TabsTrigger>
          </TabsList>

          {/* ── Config tab ── */}
          <TabsContent value="config" className="p-3 mt-0 flex-1 flex flex-col">
            <div className="space-y-4 flex-1">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-zinc-200">
                    Auto-process
                  </div>
                  <div className="text-sm text-zinc-500">
                    Automatically run ML scoring on Inbox pairs at a fixed
                    interval.
                  </div>
                </div>
                <Switch
                  checked={enabled}
                  onCheckedChange={setEnabled}
                  className="ml-3 shrink-0"
                />
              </div>

              <div>
                <div className="text-sm font-medium text-zinc-200 mb-1.5">
                  Interval (seconds)
                </div>
                <div className="text-sm text-zinc-500 mb-2">
                  How often to pick up Inbox pairs and score them. Min 10s, max
                  600s.
                </div>
                <Input
                  type="number"
                  min={10}
                  max={600}
                  step={5}
                  value={intervalSec}
                  onChange={(e) => setIntervalSec(e.target.value)}
                  className="w-24 h-8 text-sm tabular-nums"
                />
              </div>
            </div>

            <Button
              size="sm"
              className="w-full h-7 text-[11px] mt-3 mb-2"
              onClick={handleSave}
              disabled={saving}
            >
              {saving && <Loader2 className="size-3 animate-spin mr-1.5" />}
              Save
            </Button>
          </TabsContent>

          {/* ── AI Search tab ── */}
          <TabsContent
            value="ai-search"
            className="p-3 mt-0 flex-1 flex flex-col"
          >
            {/* Health indicator */}
            <div className="flex items-center gap-2 mb-3 px-2 py-1.5 rounded-md bg-zinc-900/50 border border-zinc-800/50">
              {checkingHealth ? (
                <Loader2 className="size-3 animate-spin text-zinc-500" />
              ) : (
                <span
                  className={cn(
                    "size-2 rounded-full shrink-0",
                    aiSearchHealth?.ok
                      ? "bg-emerald-400"
                      : aiSearchHealth === null
                        ? "bg-zinc-600"
                        : "bg-red-400",
                  )}
                />
              )}
              <Search className="size-3 text-cyan-400 shrink-0" />
              <span className="text-[11px] text-zinc-300">
                {checkingHealth
                  ? "Checking..."
                  : aiSearchHealth?.ok
                    ? `Healthy · ${aiSearchHealth.model ?? "Groq"}`
                    : aiSearchHealth === null
                      ? "Unreachable"
                      : "Unhealthy"}
              </span>
            </div>

            <div className="space-y-4 flex-1">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-zinc-200">
                    AI Search escalation
                  </div>
                  <div className="text-sm text-zinc-500">
                    Escalate uncertain pairs to Groq + web search
                    before human review.
                  </div>
                </div>
                <Switch
                  checked={aiSearchEnabled}
                  onCheckedChange={setAiSearchEnabled}
                  className="ml-3 shrink-0"
                  disabled={!aiSearchHealth?.ok}
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm font-medium text-zinc-200">
                    Confidence threshold
                  </span>
                  <span className="text-[11px] text-cyan-400 tabular-nums">
                    {aiSearchThreshold}%
                  </span>
                </div>
                <div className="text-sm text-zinc-500 mb-2">
                  Minimum AI Search confidence to auto-decide. Higher = more
                  pairs go to human review.
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={aiSearchThreshold}
                    onChange={(e) =>
                      setAiSearchThreshold(Number(e.target.value))
                    }
                    className="flex-1 h-6"
                  />
                </div>
              </div>

              <div>
                <div className="text-sm font-medium text-zinc-200 mb-1.5">
                  Max batch size
                </div>
                <div className="text-sm text-zinc-500 mb-2">
                  Pairs per AI Search request. Max 20.
                </div>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  step={1}
                  value={aiSearchBatchSize}
                  onChange={(e) =>
                    setAiSearchBatchSize(
                      Math.max(1, Math.min(20, Number(e.target.value))),
                    )
                  }
                  className="w-20 h-8 text-sm tabular-nums"
                />
              </div>
            </div>

            <Button
              size="sm"
              className="w-full h-7 text-[11px] mt-3 mb-2"
              onClick={handleSave}
              disabled={saving}
            >
              {saving && <Loader2 className="size-3 animate-spin mr-1.5" />}
              Save
            </Button>
          </TabsContent>

          {/* ── Processing Log tab ── */}
          <TabsContent
            value="history"
            className="mt-0 flex-1 min-h-0 flex flex-col"
          >
            <div className="flex-1 min-h-0 overflow-y-auto">
              {displayHistory.length === 0 ? (
                <div className="py-8 text-center text-sm text-zinc-500">
                  No ML runs recorded yet. Runs appear here after the scheduler
                  or manual trigger successfully processes at least one pair.
                </div>
              ) : (
                <div className="divide-y divide-zinc-800/50">
                  {displayHistory.map((entry, i) => (
                    <div
                      key={`${entry.runAt}-${i}`}
                      className="px-3 py-2 hover:bg-zinc-900/50"
                    >
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-[11px] text-zinc-400 tabular-nums">
                          {formatTime(entry.runAt)}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[10px] px-1 py-0",
                              entry.trigger === "manual"
                                ? "border-sky-700/40 text-sky-400"
                                : "border-zinc-700/40 text-zinc-500",
                            )}
                          >
                            {entry.trigger}
                          </Badge>
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[10px] px-1 py-0",
                              STATUS_BADGE[entry.status].className,
                            )}
                          >
                            {STATUS_BADGE[entry.status].label}
                          </Badge>
                        </div>
                      </div>
                      <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-zinc-500">
                        <span className="tabular-nums">
                          {entry.processed} scored
                        </span>
                        <span className="text-emerald-500 tabular-nums">
                          {entry.merged} merged
                        </span>
                        <span className="text-red-400 tabular-nums">
                          {entry.rejected} rejected
                        </span>
                        <span className="text-violet-400 tabular-nums">
                          {entry.escalated} → review
                        </span>
                        {entry.aiSearchAttempted > 0 && (
                          <span className="text-cyan-400 tabular-nums">
                            🔍 {entry.aiSearchMerged}m/{entry.aiSearchRejected}r
                            of {entry.aiSearchAttempted}
                          </span>
                        )}
                        <span className="ml-auto text-zinc-600 tabular-nums">
                          {formatDuration(entry.durationMs)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {hasMoreHistory && !expandedHistory && (
              <div className="shrink-0 border-t border-zinc-800/50 px-3 py-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full h-7 text-[11px] text-zinc-500"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? (
                    <Loader2 className="size-3 animate-spin mr-1.5" />
                  ) : null}
                  Show all {historyTotal} runs
                </Button>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}
