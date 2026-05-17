"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { type ColumnDef, type RowSelectionState } from "@tanstack/react-table";
import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
  Search,
  XCircle,
  Timer,
  Zap,
  CheckCheck,
  Ban,
  ArrowUpRight,
  Brain,
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { verifyAiMatch } from "./api";
import { AiModelMenuItems } from "@/components/shared/AiModelMenuItems";
import type { AiModelMenuEngine, AiModelMenuCallbacks } from "@/components/shared/AiModelMenuItems";
import type { ModelTier } from "@/lib/ai/models";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { fetchPairsByStage, fetchStats, decidePair, runMlStream } from "./api";
import type {
  MatchPairRow,
  MatchPairStage,
  StageCounts,
  MlSchedulerStats,
  MlRunHistoryEntry,
  MlProgressEvent,
  PairProcessingStatus,
  MatchPairDecidedBy,
} from "./types";
import {
  STAGE_META,
  DECISION_COLORS,
  PROVIDER_BADGE,
  PROVIDER_DISPLAY_NAMES,
} from "./types";
import { SchedulerPopover } from "./SchedulerPopover";
import { format, isValid, parseISO } from "date-fns";

import { AppShell } from "@/components/nav/AppShell";

const VISIBLE_STAGES: MatchPairStage[] = ["inbox", "human_review", "history"];

const REFRESH_INTERVALS: Partial<Record<MatchPairStage, number>> = {
  inbox: 15_000,
  human_review: 30_000,
};

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = parseISO(iso);
  if (!isValid(d)) return "—";
  return format(d, "MMM d, HH:mm");
}

function formatKickoff(iso: string | null): string {
  if (!iso) return "—";
  const d = parseISO(iso);
  if (!isValid(d)) return "—";
  return format(d, "MMM d, HH:mm");
}

function scoreColor(score: number | null): string {
  if (score === null) return "text-zinc-500";
  if (score >= 0.9) return "text-emerald-400";
  if (score >= 0.7) return "text-amber-300";
  return "text-red-400";
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "any moment now";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

// ─── Countdown timer component ────────────────────────────────────────

function SchedulerCountdown({ mlStats }: { mlStats: MlSchedulerStats | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!mlStats?.active || !mlStats.lastRunAt || !mlStats.intervalMs) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [mlStats?.active, mlStats?.lastRunAt, mlStats?.intervalMs]);

  if (!mlStats?.active || !mlStats.lastRunAt || !mlStats.intervalMs)
    return null;

  const lastRun = new Date(mlStats.lastRunAt).getTime();
  const nextRun = lastRun + mlStats.intervalMs;
  const secondsLeft = Math.max(0, Math.ceil((nextRun - now) / 1000));

  return (
    <span className="text-[11px] text-zinc-500 tabular-nums flex items-center gap-1">
      <Timer className="size-3 text-zinc-600" />
      Next run in{" "}
      <span className="text-zinc-400">{formatCountdown(secondsLeft)}</span>
    </span>
  );
}

// ─── Status indicator for per-pair ML processing ──────────────────────

const STATUS_CONFIG: Record<
  PairProcessingStatus,
  { icon: typeof Loader2; className: string; label: string }
> = {
  idle: { icon: Loader2, className: "text-zinc-600", label: "" },
  queued: {
    icon: Timer,
    className: "text-zinc-400 animate-pulse",
    label: "Queued",
  },
  embedding: {
    icon: Zap,
    className: "text-sky-400 animate-pulse",
    label: "Embedding",
  },
  scoring: {
    icon: Loader2,
    className: "text-amber-400 animate-spin",
    label: "Scoring",
  },
  "ai-searching": {
    icon: Search,
    className: "text-cyan-400 animate-pulse",
    label: "AI Search",
  },
  merged: {
    icon: CheckCheck,
    className: "text-emerald-400",
    label: "Merged",
  },
  rejected: { icon: Ban, className: "text-red-400", label: "Rejected" },
  escalated: {
    icon: ArrowUpRight,
    className: "text-violet-400",
    label: "To review",
  },
  error: { icon: XCircle, className: "text-red-500", label: "Error" },
};

function PairStatusCell({ status }: { status: PairProcessingStatus }) {
  if (status === "idle") return null;
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;
  return (
    <div className="flex items-center gap-1">
      <Icon className={cn("size-3", config.className)} />
      <span className={cn("text-[10px]", config.className)}>
        {config.label}
      </span>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────

function AiVerifyDropdown({
  disabled,
  running,
  selectedCount,
  onVerify,
  inline = false,
}: {
  disabled: boolean;
  running: boolean;
  selectedCount?: number;
  onVerify: (
    engine: AiModelMenuEngine,
    model: ModelTier,
    providerId?: string,
  ) => void;
  inline?: boolean;
}) {
  const callbacks: AiModelMenuCallbacks = {
    onSelectAi: (engine, model) => onVerify(engine, model),
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size={inline ? "icon" : "sm"}
          variant={inline ? "ghost" : "outline"}
          className={cn(
            inline ? "size-6" : "h-7 px-2.5 text-[11px] gap-1",
            inline && "text-muted-foreground hover:text-foreground",
          )}
          disabled={disabled || running}
          title="Verify match using AI"
        >
          {running ? (
            <Loader2
              className={cn("animate-spin", inline ? "size-3.5" : "size-3")}
            />
          ) : inline ? (
            <Brain className="size-3.5" />
          ) : (
            <>
              <Brain className="size-3" />
              Verify with AI
              {selectedCount != null && selectedCount > 0 && (
                <span className="tabular-nums">({selectedCount})</span>
              )}
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[210px] p-1">
        <AiModelMenuItems callbacks={callbacks} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MatcherLab() {
  const [activeStage, setActiveStage] = useState<MatchPairStage>("inbox");
  const [rows, setRows] = useState<MatchPairRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [counts, setCounts] = useState<StageCounts>({
    inbox: 0,
    human_review: 0,
    history: 0,
  });
  const [mlStats, setMlStats] = useState<MlSchedulerStats | null>(null);
  const [mlHistory, setMlHistory] = useState<MlRunHistoryEntry[]>([]);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [historyTotal, setHistoryTotal] = useState(0);

  const [actingOn, setActingOn] = useState<Set<string>>(new Set());
  const [mlRunning, setMlRunning] = useState(false);
  const [pairStatuses, setPairStatuses] = useState<
    Map<string, PairProcessingStatus>
  >(new Map());
  const [mlProgress, setMlProgress] = useState<{
    phase: string;
    current: number;
    total: number;
  } | null>(null);
  const initialTabPicked = useRef(false);

  // Row selection — all selected by default on inbox
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const prevRowIdsRef = useRef<string>("");

  // Keep track of previous stage to handle transitions
  const prevStageRef = useRef<MatchPairStage>(activeStage);

  // Auto-select NEW rows when inbox rows change, and handle stage transitions
  useEffect(() => {
    if (prevStageRef.current !== activeStage) {
      setRowSelection({});
      prevRowIdsRef.current = "";
      prevStageRef.current = activeStage;
      if (activeStage !== "inbox") return; // don't auto-select on other tabs initially
    }

    if (activeStage !== "inbox") {
      // For non-inbox tabs, just cleanup deleted rows
      setRowSelection((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const id of Object.keys(next)) {
          if (!rows.some((r) => r.id === id)) {
            delete next[id];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      return;
    }

    const rowIds = rows.map((r) => r.id).join(",");
    if (rowIds === prevRowIdsRef.current) return;

    const prevIds = new Set(
      prevRowIdsRef.current ? prevRowIdsRef.current.split(",") : [],
    );
    prevRowIdsRef.current = rowIds;

    setRowSelection((prev) => {
      const next = { ...prev };
      let changed = false;
      rows.forEach((row) => {
        if (!prevIds.has(row.id)) {
          next[row.id] = true;
          changed = true;
        }
      });
      // Cleanup deleted rows from selection state
      for (const id of Object.keys(next)) {
        if (!rows.some((r) => r.id === id)) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [rows, activeStage]);

  const selectedCount = useMemo(() => {
    if (activeStage !== "inbox" && activeStage !== "human_review") return 0;
    return Object.values(rowSelection).filter(Boolean).length;
  }, [rowSelection, activeStage]);

  const selectedPairIds = useMemo(() => {
    if (activeStage !== "inbox" && activeStage !== "human_review") return [];
    return Object.entries(rowSelection)
      .filter(([, selected]) => selected)
      .map(([id]) => id);
  }, [rowSelection, activeStage]);

  const loadStats = useCallback(async () => {
    try {
      const data = await fetchStats();
      setCounts(data.stageCounts);
      setMlStats(data.mlStats);
      setMlHistory(data.history ?? []);
      setHasMoreHistory(data.hasMoreHistory ?? false);
      setHistoryTotal(data.historyTotal ?? 0);

      if (!initialTabPicked.current) {
        initialTabPicked.current = true;
        const firstNonEmpty = VISIBLE_STAGES.find(
          (s) => (data.stageCounts[s] ?? 0) > 0,
        );
        if (firstNonEmpty) setActiveStage(firstNonEmpty);
      }
    } catch {
      // Stale counts are acceptable
    }
  }, []);

  const loadRows = useCallback(async (stage: MatchPairStage) => {
    setRefreshing(true);
    try {
      const data = await fetchPairsByStage(stage, { limit: 200 });
      setRows(data.rows);
    } catch (err) {
      toast.error("❌ Failed to load pairs", {
        description: (err as Error).message,
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([loadRows(activeStage), loadStats()]);
  }, [activeStage, loadRows, loadStats]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [activeStage]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mlRunning) return;
    const interval = REFRESH_INTERVALS[activeStage];
    if (!interval) return;
    const id = setInterval(refresh, interval);
    return () => clearInterval(id);
  }, [activeStage, refresh, mlRunning]);

  const handleDecide = useCallback(
    async (id: string, decision: "human-merge" | "human-reject") => {
      setActingOn((s) => new Set(s).add(id));
      try {
        const pair = rows.find((r) => r.id === id);
        await decidePair(id, decision, "human");
        const eventLabel = pair
          ? `${pair.eventAHomeTeam} v ${pair.eventAAwayTeam} ↔ ${pair.eventBHomeTeam} v ${pair.eventBAwayTeam}`.slice(
              0,
              70,
            )
          : id.slice(0, 30);
        if (decision === "human-merge") {
          toast.success(`✅ Merged`, {
            description: eventLabel,
          });
        } else {
          toast.success(`🚫 Rejected`, {
            description: eventLabel,
          });
        }
        await refresh();
      } catch (err) {
        toast.error("❌ Action failed", {
          description: (err as Error).message,
        });
      } finally {
        setActingOn((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        });
      }
    },
    [refresh, rows],
  );

  const [aiVerifyingIds, setAiVerifyingIds] = useState<Set<string>>(new Set());
  const [isBulkVerifying, setIsBulkVerifying] = useState(false);

  const handleVerifyAi = useCallback(
    async (
      engine: AiModelMenuEngine,
      model: ModelTier,
      singleId?: string,
    ) => {
      const idsToRun = singleId ? [singleId] : [...selectedPairIds];
      if (idsToRun.length === 0) return;

      if (!singleId) {
        setRowSelection({});
        setIsBulkVerifying(true);
      }

      setAiVerifyingIds((prev) => {
        const next = new Set(prev);
        for (const id of idsToRun) next.add(id);
        return next;
      });

      let merged = 0;
      let rejected = 0;
      let uncertain = 0;
      let errors = 0;

      void engine;
      const engineLabel = "DeepSeek";
      const engineEmoji = "🔍";
      const apiEngine = "ai-search";

      for (const id of idsToRun) {
        try {
          const pair = rows.find((r) => r.id === id);
          const pairLabel = pair
            ? `${pair.eventAHomeTeam} v ${pair.eventAAwayTeam} ↔ ${pair.eventBHomeTeam} v ${pair.eventBAwayTeam}`.slice(
                0,
                65,
              )
            : id.slice(0, 30);
          const result = await verifyAiMatch(id, { engine: apiEngine, model: "flash" as const });
          if (result.decision === "UNCERTAIN") {
            uncertain++;
            toast.warning(`${engineEmoji} Uncertain — ${pairLabel}`, {
              description: result.reasoning
                ? `${result.reasoning.slice(0, 120)} · ${result.confidence}% confidence`
                : `${engineLabel} couldn't decide · ${result.confidence}% confidence`,
            });
            continue;
          }
          const decidedBy = "ai-search";
          const decision =
            result.decision === "SAME" ? "human-merge" : "human-reject";
          await decidePair(id, decision, decidedBy as MatchPairDecidedBy);
          if (result.decision === "SAME") merged++;
          else rejected++;

          // Only show per-pair toasts for single-item runs
          if (idsToRun.length === 1) {
            const icon = result.decision === "SAME" ? "✅" : "🚫";
            toast.success(
              `${icon} ${engineLabel}: ${result.decision === "SAME" ? "Merged" : "Rejected"}`,
              {
                description: result.reasoning
                  ? `${pairLabel}\n${result.reasoning.slice(0, 150)} · ${result.confidence}%`
                  : `${pairLabel} · ${result.confidence}% confidence`,
              },
            );
          }
        } catch (err) {
          errors++;
          const pair = rows.find((r) => r.id === id);
          toast.error(`❌ ${engineLabel} failed`, {
            description: pair
              ? `${pair.eventAHomeTeam} v ${pair.eventAAwayTeam} ↔ ${pair.eventBHomeTeam} v ${pair.eventBAwayTeam}\n${(err as Error).message}`.slice(
                  0,
                  200,
                )
              : (err as Error).message,
          });
        } finally {
          setAiVerifyingIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }
      }

      setIsBulkVerifying(false);

      if (idsToRun.length > 1) {
        const parts: string[] = [];
        if (merged > 0) parts.push(`✅ ${merged} merged`);
        if (rejected > 0) parts.push(`🚫 ${rejected} rejected`);
        if (uncertain > 0) parts.push(`⚠️ ${uncertain} uncertain`);
        if (errors > 0) parts.push(`❌ ${errors} failed`);
        toast.info(`${engineEmoji} ${engineLabel} Batch Complete`, {
          description: parts.join(" · ") || "No pairs processed",
        });
      }

      await refresh();
    },
    [selectedPairIds, refresh, rows],
  );

  const handleRunMl = useCallback(async () => {
    if (selectedPairIds.length === 0) return;
    setMlRunning(true);
    setPairStatuses(new Map());
    setMlProgress(null);
    setRowSelection({}); // Reset selection immediately

    // Mark all selected as queued
    const initial = new Map<string, PairProcessingStatus>();
    for (const id of selectedPairIds) {
      initial.set(id, "queued");
    }
    setPairStatuses(new Map(initial));

    try {
      await runMlStream(selectedPairIds, (event: MlProgressEvent) => {
        switch (event.type) {
          case "transitioning":
            setMlProgress({
              phase: "Processing ML batch...",
              current: 0,
              total: 0,
            });
            break;

          case "batch_start":
            setMlProgress({
              phase: "Starting batch",
              current: 0,
              total: event.total ?? 0,
            });
            break;

          case "embedding":
            setMlProgress({
              phase: "Computing embeddings",
              current: 0,
              total: event.total ?? 0,
            });
            setPairStatuses((prev) => {
              const next = new Map(prev);
              for (const [id, status] of next) {
                if (status === "queued") next.set(id, "embedding");
              }
              return next;
            });
            break;

          case "embedding_done":
            setMlProgress({
              phase: "Embeddings ready — scoring pairs",
              current: 0,
              total: event.total ?? 0,
            });
            break;

          case "pair_scoring":
            if (event.pairId) {
              setPairStatuses((prev) => {
                const next = new Map(prev);
                next.set(event.pairId!, "scoring");
                return next;
              });
              setMlProgress((p) =>
                p
                  ? {
                      ...p,
                      phase: "Scoring pairs",
                      current: (event.index ?? 0) + 1,
                    }
                  : null,
              );
            }
            break;

          case "pair_decided":
            if (event.pairId) {
              const status: PairProcessingStatus =
                event.verdict === "merged"
                  ? "merged"
                  : event.verdict === "rejected"
                    ? "rejected"
                    : event.verdict === "escalated"
                      ? "escalated"
                      : "error";
              setPairStatuses((prev) => {
                const next = new Map(prev);
                next.set(event.pairId!, status);
                return next;
              });
              setMlProgress((p) =>
                p
                  ? {
                      ...p,
                      phase: `Decided ${(event.index ?? 0) + 1}/${event.total ?? 0}`,
                      current: (event.index ?? 0) + 1,
                    }
                  : null,
              );
            }
            break;

          case "service_unreachable":
            toast.error("🔌 ML matcher service unreachable", {
              description:
                "The bi-encoder service didn't respond. Pairs returned to Inbox for retry.",
            });
            setPairStatuses((prev) => {
              const next = new Map(prev);
              for (const [id] of next) {
                next.set(id, "error");
              }
              return next;
            });
            break;

          case "batch_complete": {
            if (event.processed === -1) {
              toast.warning("⏳ ML batch already running", {
                description: "Wait for the current batch to finish.",
              });
            } else if (event.processed === 0) {
              toast.info("📭 No pairs to process", {
                description: "Inbox is empty.",
              });
            } else {
              const sec = event.durationMs
                ? `${(event.durationMs / 1000).toFixed(1)}s`
                : "";
              const parts: string[] = [];
              if (event.merged) parts.push(`✅ ${event.merged} merged`);
              if (event.rejected) parts.push(`🚫 ${event.rejected} rejected`);
              if (event.escalated) parts.push(`👀 ${event.escalated} → review`);
              toast.success(`🤖 ML batch complete${sec ? ` in ${sec}` : ""}`, {
                description: parts.join(" · ") || "No changes",
              });
            }
            break;
          }
        }
      });

      await refresh();
    } catch (err) {
      toast.error("❌ ML batch failed", {
        description: (err as Error).message,
      });
    } finally {
      setMlRunning(false);
      setMlProgress(null);
      setTimeout(() => setPairStatuses(new Map()), 3000);
    }
  }, [selectedPairIds, refresh]);

  const columns = useMemo(
    () =>
      buildColumns(
        activeStage,
        actingOn,
        pairStatuses,
        handleDecide,
        aiVerifyingIds,
        handleVerifyAi,
      ),
    [
      activeStage,
      actingOn,
      pairStatuses,
      handleDecide,
      aiVerifyingIds,
      handleVerifyAi,
    ],
  );

  return (
    <AppShell
      title="Matcher Lab"
      edgeToEdge
      tabs={VISIBLE_STAGES.map((stage) => {
        const meta = STAGE_META[stage];
        const count = counts[stage] || 0;
        return {
          value: stage,
          label: meta.label,
          badge:
            count > 0 ? (
              <span
                className={cn(
                  "ml-1 inline-flex items-center justify-center rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums border",
                  meta.color,
                  meta.bgActive,
                )}
              >
                {count}
              </span>
            ) : null,
        };
      })}
      activeTab={activeStage}
      onTabChange={(v) => setActiveStage(v as MatchPairStage)}
      actions={
        <div className="flex items-center gap-1.5">
          {!mlProgress && mlStats?.lastRunAt && (
            <div className="flex items-center gap-3 px-3 border-r border-border/40 text-[11px] text-zinc-500 mr-1 hidden lg:flex">
              <span>
                Last ML run:{" "}
                <span className="text-zinc-400">
                  {formatTime(mlStats.lastRunAt)}
                </span>
              </span>
              <span>
                Last batch:{" "}
                <span className="text-zinc-400 tabular-nums">
                  {mlStats.lastBatchSize}
                </span>
              </span>
              <span>
                Total processed:{" "}
                <span className="text-zinc-400 tabular-nums">
                  {mlStats.totalProcessed}
                </span>
              </span>
            </div>
          )}
          <SchedulerCountdown mlStats={mlStats} />

          {mlStats && (
            <Badge
              variant="outline"
              className={cn(
                "text-[11px]",
                mlStats.active
                  ? "border-emerald-700/40 text-emerald-300"
                  : "border-zinc-700/40 text-zinc-500",
              )}
            >
              ML {mlStats.active ? "active" : "idle"}
              {mlStats.processing && (
                <Loader2 className="size-3 animate-spin ml-1" />
              )}
            </Badge>
          )}

          {activeStage === "inbox" && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-[11px] gap-1"
              disabled={mlRunning || selectedCount === 0}
              onClick={handleRunMl}
              title={
                selectedCount === 0
                  ? "Select at least one pair from the inbox to run ML scoring."
                  : `Process ${selectedCount} selected pair${selectedCount > 1 ? "s" : ""} through the bi-encoder. Auto-merges high-confidence matches and routes uncertain ones to Human Review.`
              }
            >
              {mlRunning ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Play className="size-3" />
              )}
              Run ML
              {selectedCount > 0 && (
                <span className="tabular-nums">({selectedCount})</span>
              )}
            </Button>
          )}

          {(activeStage === "inbox" || activeStage === "human_review") && (
            <AiVerifyDropdown
              disabled={selectedCount === 0}
              running={isBulkVerifying}
              selectedCount={selectedCount}
              onVerify={(engine, model) => handleVerifyAi(engine, "flash", undefined)}
            />
          )}

          <SchedulerPopover
            mlStats={mlStats}
            history={mlHistory}
            hasMoreHistory={hasMoreHistory}
            historyTotal={historyTotal}
            onConfigSaved={loadStats}
          />

          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            onClick={refresh}
            disabled={refreshing}
            title="Refresh"
          >
            <RefreshCw
              className={cn("size-3.5", refreshing && "animate-spin")}
            />
          </Button>
        </div>
      }
    >
      <div className="h-full flex flex-col overflow-hidden bg-background">
        {/* ML progress bar */}
        {mlProgress && (
          <div className="flex items-center gap-3 px-3 py-1.5 border-b border-zinc-800/30 bg-sky-950/20">
            <Loader2 className="size-3 animate-spin text-sky-400 shrink-0" />
            <span className="text-[11px] text-sky-300">{mlProgress.phase}</span>
            {mlProgress.total > 0 && (
              <>
                <span className="text-[11px] text-sky-400 tabular-nums">
                  {mlProgress.current}/{mlProgress.total}
                </span>
                <div className="flex-1 h-1 bg-zinc-800 rounded-full overflow-hidden max-w-[200px]">
                  <div
                    className="h-full bg-sky-500 rounded-full transition-all duration-300"
                    style={{
                      width: `${(mlProgress.current / mlProgress.total) * 100}%`,
                    }}
                  />
                </div>
              </>
            )}
          </div>
        )}

        {/* DataTable */}
        <div className="flex-1 min-h-0 p-2">
          <DataTable<MatchPairRow>
            withCard
            data={rows}
            columns={columns}
            getRowId={(row) => row.id}
            enableSorting
            enableVirtualization
            enableColumnResizing
            enableRowSelection={
              activeStage === "inbox" || activeStage === "human_review"
            }
            rowSelection={
              activeStage === "inbox" || activeStage === "human_review"
                ? rowSelection
                : undefined
            }
            onRowSelectionChange={
              activeStage === "inbox" || activeStage === "human_review"
                ? setRowSelection
                : undefined
            }
            density="compact"
            persistenceKey={`matcher-lab-${activeStage}`}
            loading={loading}
            className="h-full"
            rowClassName={(row) => {
              const status = pairStatuses.get(row.id);
              if (status === "scoring")
                return "bg-amber-900/[0.08] animate-pulse";
              if (status === "embedding") return "bg-sky-900/[0.06]";
              if (status === "merged") return "bg-emerald-900/[0.08]";
              if (status === "rejected") return "bg-red-900/[0.06] opacity-80";
              if (status === "escalated") return "bg-violet-900/[0.06]";
              if (row.decision?.includes("merge"))
                return "bg-emerald-900/[0.04]";
              if (row.decision?.includes("reject"))
                return "bg-red-900/[0.04] opacity-80";

              // Global processing effect for inbox pairs
              if (
                activeStage === "inbox" &&
                (mlProgress != null || mlStats?.processing)
              ) {
                return "bg-sky-900/[0.04] animate-pulse";
              }
              return undefined;
            }}
            renderEmpty={() => (
              <div className="flex flex-col items-center justify-center py-12 text-zinc-500">
                <p className="text-sm">
                  {activeStage === "inbox"
                    ? "Inbox is empty — all pairs have been scored."
                    : activeStage === "human_review"
                      ? "Nothing needs a human decision right now."
                      : "No resolved pairs yet."}
                </p>
              </div>
            )}
          />
        </div>
      </div>
    </AppShell>
  );
}

// ─── Column builder ───────────────────────────────────────────────────

function buildColumns(
  stage: MatchPairStage,
  actingOn: Set<string>,
  pairStatuses: Map<string, PairProcessingStatus>,
  onDecide: (id: string, decision: "human-merge" | "human-reject") => void,
  aiVerifyingIds: Set<string>,
  onVerifyAi: (
    engine: AiModelMenuEngine,
    model: Extract<ModelTier, "flash">,
    id?: string,
  ) => void,
): ColumnDef<MatchPairRow, unknown>[] {
  const cols: ColumnDef<MatchPairRow, unknown>[] = [];

  if (stage === "inbox" || stage === "human_review") {
    cols.push({
      id: "select",
      size: 32,
      meta: { fixed: "left" as const },
      header: ({ table }) => (
        <Checkbox
          checked={
            table.getIsAllPageRowsSelected() ||
            (table.getIsSomePageRowsSelected() && "indeterminate")
          }
          onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
          aria-label="Select all"
          className="size-3.5"
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(!!value)}
          aria-label="Select row"
          className="size-3.5"
        />
      ),
    });
  }

  // KO — always the first data column
  cols.push({
    id: "kickoff",
    header: "KO",
    size: 100,
    meta: {
      hint: "Kickoff time for this fixture.",
      align: "center",
    },
    accessorFn: (row) => row.eventAStartTime,
    cell: ({ row }) => (
      <span
        className="tabular-nums text-zinc-400 text-[11px]"
        title={formatTime(row.original.eventAStartTime)}
      >
        {formatKickoff(row.original.eventAStartTime)}
      </span>
    ),
  });

  cols.push(
    {
      id: "eventA",
      header: "Event A",
      size: 260,
      meta: {
        hint: "The first event in the pair — hover for detailed breakdown.",
      },
      cell: ({ row }) => (
        <EventCell
          provider={row.original.eventAProvider}
          home={row.original.eventAHomeTeam}
          away={row.original.eventAAwayTeam}
          competition={row.original.eventACompetition}
        />
      ),
    },
    {
      id: "eventB",
      header: "Event B",
      size: 260,
      meta: { hint: "The second event — from a different provider." },
      cell: ({ row }) => (
        <EventCell
          provider={row.original.eventBProvider}
          home={row.original.eventBHomeTeam}
          away={row.original.eventBAwayTeam}
          competition={row.original.eventBCompetition}
        />
      ),
    },
    {
      id: "stringScore",
      header: "Text Match",
      size: 70,
      meta: {
        hint: "Dice/Jaro-Winkler string similarity from the sync matcher. This is the initial text-based similarity score before ML scoring.",
        align: "right",
      },
      accessorFn: (row) => row.stringScore,
      cell: ({ row }) => (
        <span className="tabular-nums text-zinc-300">
          {(row.original.stringScore * 100).toFixed(0)}%
        </span>
      ),
    },
    {
      id: "source",
      header: "Origin",
      size: 80,
      meta: {
        hint: "How the pair was detected. Near-match means 70–85% string similarity. Unmatched means a cross-provider candidate that wasn't auto-matched.",
      },
      cell: ({ row }) => (
        <Badge
          variant="outline"
          className={cn(
            "text-[10px] px-1.5 py-0",
            row.original.source === "near-match"
              ? "border-amber-700/40 text-amber-400"
              : "border-sky-700/40 text-sky-400",
          )}
        >
          {row.original.source === "near-match" ? "near-match" : "unmatched"}
        </Badge>
      ),
    },
  );

  // ML processing status column (visible during/after ML run on inbox)
  if (stage === "inbox") {
    cols.push({
      id: "mlStatus",
      header: "ML Status",
      size: 80,
      meta: {
        hint: "Live processing status for each pair during ML scoring.",
      },
      cell: ({ row }) => {
        const status = pairStatuses.get(row.original.id);
        return <PairStatusCell status={status ?? "idle"} />;
      },
    });
  }

  if (stage !== "inbox") {
    cols.push(
      {
        id: "mlCombined",
        header: "ML Score",
        size: 70,
        meta: {
          hint: "Combined bi-encoder score: 70% team similarity + 30% competition similarity.",
          align: "right",
        },
        accessorFn: (row) => row.mlCombinedScore,
        cell: ({ row }) => {
          const score = row.original.mlCombinedScore;
          return (
            <span className={cn("tabular-nums", scoreColor(score))}>
              {score !== null ? `${(score * 100).toFixed(0)}%` : "—"}
            </span>
          );
        },
      },
      {
        id: "mlHome",
        header: "Home",
        size: 55,
        meta: {
          hint: "Bi-encoder cosine similarity for the home team names.",
          align: "right",
        },
        accessorFn: (row) => row.mlHomeCosine,
        cell: ({ row }) => {
          const v = row.original.mlHomeCosine;
          return (
            <span className={cn("tabular-nums", scoreColor(v))}>
              {v !== null ? v.toFixed(2) : "—"}
            </span>
          );
        },
      },
      {
        id: "mlAway",
        header: "Away",
        size: 55,
        meta: {
          hint: "Bi-encoder cosine similarity for the away team names.",
          align: "right",
        },
        accessorFn: (row) => row.mlAwayCosine,
        cell: ({ row }) => {
          const v = row.original.mlAwayCosine;
          return (
            <span className={cn("tabular-nums", scoreColor(v))}>
              {v !== null ? v.toFixed(2) : "—"}
            </span>
          );
        },
      },
    );
  }

  if (stage === "human_review" || stage === "history") {
    cols.push({
      id: "xeScore",
      header: "XE",
      size: 55,
      meta: {
        hint: "Cross-encoder reranker score. Only populated for pairs where the bi-encoder was uncertain (0.70–0.89 combined).",
        align: "right",
      },
      accessorFn: (row) => row.xeScore,
      cell: ({ row }) => {
        const v = row.original.xeScore;
        return (
          <span className={cn("tabular-nums", scoreColor(v))}>
            {v !== null ? v.toFixed(2) : "—"}
          </span>
        );
      },
    });
  }

  if (stage === "history") {
    cols.push(
      {
        id: "decision",
        header: "Decision",
        size: 100,
        meta: {
          hint: "The final verdict — auto/human/AI merge or reject. Hover for reasoning.",
        },
        cell: ({ row }) => {
          const d = row.original.decision;
          if (!d) return <span className="text-zinc-600">—</span>;
          const reason = row.original.decisionReason?.slice(0, 200);
          return (
            <span
              className={cn(
                "inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium border cursor-default",
                DECISION_COLORS[d] ?? "bg-zinc-800 text-zinc-400",
              )}
              title={reason ?? undefined}
            >
              {d}
            </span>
          );
        },
      },
      {
        id: "decidedBy",
        header: "By",
        size: 100,
        meta: { hint: "Who or what made the decision." },
        accessorFn: (row) => row.decidedBy,
        cell: ({ row }) => {
          const by = row.original.decidedBy;
          if (!by) return <span className="text-zinc-600">—</span>;
          const isAiSearch = by === "ai-search";
          const isGemini = by.startsWith("gemini-");
          const isMl = by.startsWith("ml-");
          return (
            <span
              className={cn(
                "inline-flex items-center gap-1 text-[10px]",
                isAiSearch
                  ? "text-cyan-400"
                  : isGemini
                    ? "text-sky-400"
                    : isMl
                      ? "text-emerald-400"
                      : "text-zinc-400",
              )}
            >
              {isAiSearch ? (
                <Search className="size-2.5" />
              ) : isGemini ? (
                <Brain className="size-2.5" />
              ) : null}
              {by}
            </span>
          );
        },
      },
      {
        id: "decidedAt",
        header: "Decided",
        size: 110,
        meta: { hint: "When the decision was made.", align: "right" },
        accessorFn: (row) => row.decidedAt,
        cell: ({ row }) => (
          <span className="text-zinc-500 tabular-nums">
            {formatTime(row.original.decidedAt)}
          </span>
        ),
      },
    );
  }

  cols.push({
    id: "detectedAt",
    header: "Detected",
    size: 110,
    meta: {
      hint: "When this pair was first detected by the sync pipeline.",
      align: "right",
    },
    accessorFn: (row) => row.detectedAt,
    cell: ({ row }) => (
      <span className="text-zinc-500 tabular-nums">
        {formatTime(row.original.detectedAt)}
      </span>
    ),
  });

  if (stage === "human_review" || stage === "inbox") {
    cols.push({
      id: "actions",
      header: "",
      size: 90,
      meta: { fixed: "right" as const },
      cell: ({ row }) => {
        const id = row.original.id;
        const busy = actingOn.has(id);
        return (
          <div className="flex items-center gap-0.5">
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              disabled={busy}
              onClick={() => onDecide(id, "human-merge")}
              title="Merge — these two events describe the same real-world fixture. Team aliases are learned so future syncs auto-match them."
            >
              {busy ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <CheckCircle2 className="size-3.5 text-emerald-500" />
              )}
            </Button>

            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              disabled={busy}
              onClick={() => onDecide(id, "human-reject")}
              title="Reject — these are different events. Records a negative observation so the ML system avoids pairing them again."
            >
              <XCircle className="size-3.5 text-red-500" />
            </Button>

            <AiVerifyDropdown
              inline
              disabled={busy}
              running={aiVerifyingIds.has(id)}
              onVerify={(engine, model) => onVerifyAi(engine, "flash", id)}
            />
            <a
              href={buildSearchUrl(row.original)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center size-6 rounded-md hover:bg-accent"
              title="Search Google to verify whether these are the same fixture."
            >
              <ExternalLink className="size-3 text-zinc-500" />
            </a>
          </div>
        );
      },
    });
  }

  return cols;
}

// ─── Inline EventCell with provider badge ─────────────────────────────

function EventCell({
  provider,
  home,
  away,
  competition,
}: {
  provider: string;
  home: string;
  away: string;
  competition: string;
}) {
  const badge = PROVIDER_BADGE[provider] ?? {
    label: provider.slice(0, 3).toUpperCase(),
    className: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  };
  const displayName = PROVIDER_DISPLAY_NAMES[provider] ?? provider;

  return (
    <div
      className="min-w-0 py-0.5 flex items-center gap-1.5"
      title={`Home: ${home} | Away: ${away} | Tournament: ${competition} | Provider: ${displayName}`}
    >
      <Badge
        variant="outline"
        className={cn(
          "text-[9px] px-1 py-0 shrink-0 font-semibold tracking-wide",
          badge.className,
        )}
      >
        {badge.label}
      </Badge>
      <span className="text-[11px] text-zinc-100 truncate leading-tight">
        {home} <span className="text-zinc-500">vs</span> {away}
      </span>
      <span className="text-[10px] text-zinc-500 truncate leading-tight shrink-0">
        {competition}
      </span>
    </div>
  );
}

function buildSearchUrl(pair: MatchPairRow): string {
  const d = pair.eventAStartTime
    ? new Date(pair.eventAStartTime).toISOString().slice(0, 10)
    : "";
  const t = pair.eventAStartTime
    ? new Date(pair.eventAStartTime).toISOString().slice(11, 16)
    : "";

  const query = [
    `Are these two fixtures the exact same match?`,
    ``,
    `Fixture A: ${pair.eventAHomeTeam} vs ${pair.eventAAwayTeam} (${pair.eventACompetition})`,
    `Fixture B: ${pair.eventBHomeTeam} vs ${pair.eventBAwayTeam} (${pair.eventBCompetition})`,
    ``,
    `Scheduled for: ${d} ${t} UTC.`,
    ``,
    `Task:`,
    `1. Verify if both team names refer to the same entities (accounting for youth/reserve teams, naming differences, or transliterations).`,
    `2. Verify if the competitions align or are just named differently across providers.`,
    `3. End with a clear conclusion: Are they the same event? YES or NO.`,
  ].join("\n");

  const params = new URLSearchParams({
    q: query,
    udm: "50",
    aep: "1",
    hl: "en",
  });
  return `https://www.google.com/search?${params.toString()}`;
}

export default MatcherLab;
