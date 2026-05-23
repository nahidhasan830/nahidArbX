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
  AlertTriangle,
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { verifyAiMatch } from "./api";
import { AiModelMenuItems } from "@/components/shared/AiModelMenuItems";
import type {
  AiModelMenuEngine,
  AiModelMenuCallbacks,
} from "@/components/shared/AiModelMenuItems";
import type { ModelTier } from "@/lib/ai/models";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { VirtualList } from "@/components/ui/virtual-list";
import { cn } from "@/lib/utils";
import {
  fetchPairsByStage,
  fetchStats,
  decidePair,
  bulkDecide,
  runMlStream,
} from "./api";
import type {
  MatchPairRow,
  MatchPairStage,
  StageCounts,
  MlSchedulerStats,
  MlRunHistoryEntry,
  MlProgressEvent,
  PairProcessingStatus,
  MatchPairDecision,
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

type AiReviewAction = "merge" | "reject" | "keep";

type AiReviewStatus = "success" | "error";

type AiReviewResult = {
  id: string;
  pair: MatchPairRow;
  status: AiReviewStatus;
  aiDecision: "SAME" | "DIFFERENT" | "UNCERTAIN" | "ERROR";
  confidence: number | null;
  model: string | null;
  engine: string | null;
  reasoning: string;
  sources: { url: string; title: string; snippet: string }[];
  searchQueriesUsed: string[];
  action: AiReviewAction;
  error?: string;
};

type AiProgress = {
  phase: string;
  current: number;
  total: number;
  same: number;
  different: number;
  uncertain: number;
  errors: number;
};

function fmtMmmHm(iso: string | null): string {
  if (!iso) return "—";
  const d = parseISO(iso);
  if (!isValid(d)) return "—";
  return format(d, "dd MMM HH:mm");
}

function formatKickoff(iso: string | null): string {
  return fmtMmmHm(iso);
}

function scoreColor(score: number | null): string {
  if (score === null) return "text-zinc-500";
  if (score >= 0.9) return "text-emerald-400";
  if (score >= 0.7) return "text-amber-300";
  return "text-red-400";
}

function formatConfidence(confidence: number | null): string {
  if (confidence == null || !Number.isFinite(confidence)) return "—";
  const pct = confidence <= 1 ? confidence * 100 : confidence;
  return `${Math.round(pct)}%`;
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
  "ai-same": {
    icon: CheckCircle2,
    className: "text-emerald-400",
    label: "AI same",
  },
  "ai-different": {
    icon: XCircle,
    className: "text-red-400",
    label: "AI diff",
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
  progress,
  onVerify,
  inline = false,
}: {
  disabled: boolean;
  running: boolean;
  selectedCount?: number;
  progress?: { current: number; total: number } | null;
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

  const runningLabel =
    progress && progress.total > 1
      ? `Verifying ${progress.current}/${progress.total}`
      : "Verifying";

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              size={inline ? "icon" : "sm"}
              variant={inline ? "ghost" : "outline"}
              className={cn(
                inline ? "size-6" : "h-7 px-2.5 text-[11px] gap-1",
                inline && "text-muted-foreground hover:text-foreground",
              )}
              disabled={disabled || running}
            >
              {running ? (
                inline ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <>
                    <Loader2 className="size-3 animate-spin" />
                    {runningLabel}
                  </>
                )
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
        </TooltipTrigger>
        <TooltipContent>
          Verify match using AI, then review before applying
        </TooltipContent>
      </Tooltip>
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
  const [aiProgress, setAiProgress] = useState<AiProgress | null>(null);
  const [aiReviewResults, setAiReviewResults] = useState<AiReviewResult[]>([]);
  const [aiReviewOpen, setAiReviewOpen] = useState(false);
  const [applyingAiReview, setApplyingAiReview] = useState(false);
  const [aiVerifyingIds, setAiVerifyingIds] = useState<Set<string>>(new Set());
  const [isBulkVerifying, setIsBulkVerifying] = useState(false);
  const hasPendingAiReview = aiReviewOpen || aiReviewResults.length > 0;
  const aiRunning = aiVerifyingIds.size > 0 || isBulkVerifying;
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
    if (mlRunning || aiRunning || hasPendingAiReview) return;
    const interval = REFRESH_INTERVALS[activeStage];
    if (!interval) return;
    const id = setInterval(refresh, interval);
    return () => clearInterval(id);
  }, [activeStage, refresh, mlRunning, aiRunning, hasPendingAiReview]);

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

  const updateAiReviewAction = useCallback(
    (id: string, action: AiReviewAction) => {
      setAiReviewResults((prev) =>
        prev.map((result) =>
          result.id === id ? { ...result, action } : result,
        ),
      );
    },
    [],
  );

  const handleApplyAiReview = useCallback(async () => {
    const items = aiReviewResults
      .filter((result) => result.action !== "keep" && result.status !== "error")
      .map((result) => ({
        id: result.id,
        decision:
          result.action === "merge"
            ? ("human-merge" as MatchPairDecision)
            : ("human-reject" as MatchPairDecision),
        reason: [
          `AI Search suggested ${result.aiDecision} (${formatConfidence(result.confidence)} confidence).`,
          result.reasoning,
        ]
          .filter(Boolean)
          .join(" "),
      }));

    if (items.length === 0) {
      setAiReviewOpen(false);
      setAiProgress(null);
      setPairStatuses(new Map());
      return;
    }

    setApplyingAiReview(true);
    setActingOn((prev) => {
      const next = new Set(prev);
      for (const item of items) next.add(item.id);
      return next;
    });

    try {
      const result = await bulkDecide(items, "ai-search");
      toast.success("AI review applied", {
        description:
          result.failed > 0
            ? `${result.succeeded} applied, ${result.failed} failed`
            : `${result.succeeded} decision${result.succeeded === 1 ? "" : "s"} applied`,
      });
      setAiReviewOpen(false);
      setAiProgress(null);
      setAiReviewResults([]);
      setPairStatuses(new Map());
      await refresh();
    } catch (err) {
      toast.error("Failed to apply AI review", {
        description: (err as Error).message,
      });
    } finally {
      setApplyingAiReview(false);
      setActingOn((prev) => {
        const next = new Set(prev);
        for (const item of items) next.delete(item.id);
        return next;
      });
    }
  }, [aiReviewResults, refresh]);

  const handleVerifyAi = useCallback(
    async (engine: AiModelMenuEngine, model: ModelTier, singleId?: string) => {
      const idsToRun = singleId ? [singleId] : [...selectedPairIds];
      if (idsToRun.length === 0) return;

      setAiReviewResults([]);
      setAiReviewOpen(false);
      setAiProgress({
        phase:
          idsToRun.length > 1
            ? "Running AI verification"
            : "Running AI verification",
        current: 0,
        total: idsToRun.length,
        same: 0,
        different: 0,
        uncertain: 0,
        errors: 0,
      });

      if (!singleId) {
        setRowSelection({});
        setIsBulkVerifying(true);
      }

      setAiVerifyingIds((prev) => {
        const next = new Set(prev);
        for (const id of idsToRun) next.add(id);
        return next;
      });

      void engine;
      void model;
      const apiEngine = "ai-search";
      const reviewResults: AiReviewResult[] = [];

      for (const [index, id] of idsToRun.entries()) {
        const pair = rows.find((r) => r.id === id);
        if (!pair) {
          continue;
        }

        setPairStatuses((prev) => {
          const next = new Map(prev);
          next.set(id, "ai-searching");
          return next;
        });
        setAiProgress((prev) =>
          prev
            ? {
                ...prev,
                phase: `Verifying ${index + 1}/${idsToRun.length}`,
                current: index,
              }
            : null,
        );

        try {
          const result = await verifyAiMatch(id, {
            engine: apiEngine,
            model: "flash" as const,
          });
          const decision =
            result.decision === "SAME"
              ? "SAME"
              : result.decision === "DIFFERENT" ||
                  result.decision === "NOT_SAME"
                ? "DIFFERENT"
                : "UNCERTAIN";
          const action: AiReviewAction =
            decision === "SAME"
              ? "merge"
              : decision === "DIFFERENT"
                ? "reject"
                : "keep";

          reviewResults.push({
            id,
            pair,
            status: "success",
            aiDecision: decision,
            confidence: result.confidence,
            model: result.model,
            engine: result.engine,
            reasoning:
              result.reasoning ||
              "AI verification completed without a reasoning summary.",
            sources: result.sources ?? [],
            searchQueriesUsed: result.searchQueriesUsed ?? [],
            action,
          });

          setPairStatuses((prev) => {
            const next = new Map(prev);
            next.set(
              id,
              decision === "SAME"
                ? "ai-same"
                : decision === "DIFFERENT"
                  ? "ai-different"
                  : "escalated",
            );
            return next;
          });
          setAiProgress((prev) =>
            prev
              ? {
                  ...prev,
                  current: index + 1,
                  same: prev.same + (decision === "SAME" ? 1 : 0),
                  different:
                    prev.different + (decision === "DIFFERENT" ? 1 : 0),
                  uncertain:
                    prev.uncertain + (decision === "UNCERTAIN" ? 1 : 0),
                }
              : null,
          );
        } catch (err) {
          reviewResults.push({
            id,
            pair,
            status: "error",
            aiDecision: "ERROR",
            confidence: null,
            model: null,
            engine: apiEngine,
            reasoning: (err as Error).message,
            sources: [],
            searchQueriesUsed: [],
            action: "keep",
            error: (err as Error).message,
          });
          setPairStatuses((prev) => {
            const next = new Map(prev);
            next.set(id, "error");
            return next;
          });
          setAiProgress((prev) =>
            prev
              ? {
                  ...prev,
                  current: index + 1,
                  errors: prev.errors + 1,
                }
              : null,
          );
        } finally {
          setAiVerifyingIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }
      }

      setIsBulkVerifying(false);
      setAiProgress((prev) =>
        prev
          ? {
              ...prev,
              phase: "Review AI results",
              current: prev.total,
            }
          : null,
      );
      setAiReviewResults(reviewResults);
      setAiReviewOpen(reviewResults.length > 0);
      if (reviewResults.length === 0) {
        toast.warning("No AI results to review", {
          description: "The selected rows were no longer available.",
        });
        setAiProgress(null);
      }
    },
    [selectedPairIds, rows],
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
    <TooltipProvider delayDuration={200}>
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
                    {fmtMmmHm(mlStats.lastRunAt)}
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
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2.5 text-[11px] gap-1"
                    disabled={mlRunning || selectedCount === 0}
                    onClick={handleRunMl}
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
                </TooltipTrigger>
                <TooltipContent className="max-w-[320px]">
                  {selectedCount === 0
                    ? "Select at least one pair from the inbox to run ML scoring."
                    : `Process ${selectedCount} selected pair${selectedCount > 1 ? "s" : ""} through the bi-encoder. Auto-merges high-confidence matches and routes uncertain ones to Human Review.`}
                </TooltipContent>
              </Tooltip>
            )}

            {(activeStage === "inbox" || activeStage === "human_review") && (
              <AiVerifyDropdown
                disabled={selectedCount === 0}
                running={isBulkVerifying}
                selectedCount={selectedCount}
                progress={aiProgress}
                onVerify={(engine, _model) =>
                  handleVerifyAi(engine, "flash", undefined)
                }
              />
            )}

            <SchedulerPopover
              mlStats={mlStats}
              history={mlHistory}
              hasMoreHistory={hasMoreHistory}
              historyTotal={historyTotal}
              onConfigSaved={loadStats}
            />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  onClick={refresh}
                  disabled={refreshing}
                >
                  <RefreshCw
                    className={cn("size-3.5", refreshing && "animate-spin")}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh Matcher Lab data</TooltipContent>
            </Tooltip>
          </div>
        }
      >
        <div className="h-full flex flex-col overflow-hidden bg-background">
          {/* ML progress bar */}
          {mlProgress && (
            <div className="flex items-center gap-3 px-3 py-1.5 border-b border-zinc-800/30 bg-sky-950/20">
              <Loader2 className="size-3 animate-spin text-sky-400 shrink-0" />
              <span className="text-[11px] text-sky-300">
                {mlProgress.phase}
              </span>
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

          {aiProgress && (
            <div className="flex items-center gap-3 px-3 py-1.5 border-b border-cyan-900/30 bg-cyan-950/20">
              {aiProgress.current < aiProgress.total ? (
                <Loader2 className="size-3 animate-spin text-cyan-400 shrink-0" />
              ) : (
                <Search className="size-3 text-cyan-400 shrink-0" />
              )}
              <span className="text-[11px] text-cyan-200">
                {aiProgress.phase}
              </span>
              <span className="text-[11px] text-cyan-300 tabular-nums">
                {aiProgress.current}/{aiProgress.total}
              </span>
              <div className="flex-1 h-1 bg-zinc-800 rounded-full overflow-hidden max-w-[220px]">
                <div
                  className="h-full bg-cyan-500 rounded-full transition-all duration-300"
                  style={{
                    width: `${Math.min(100, (aiProgress.current / Math.max(1, aiProgress.total)) * 100)}%`,
                  }}
                />
              </div>
              <div className="hidden md:flex items-center gap-2 text-[10px] tabular-nums">
                <span className="text-emerald-300">{aiProgress.same} same</span>
                <span className="text-red-300">
                  {aiProgress.different} different
                </span>
                <span className="text-violet-300">
                  {aiProgress.uncertain} uncertain
                </span>
                {aiProgress.errors > 0 && (
                  <span className="text-red-400">
                    {aiProgress.errors} failed
                  </span>
                )}
              </div>
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
                if (status === "ai-searching")
                  return "bg-cyan-900/[0.08] animate-pulse";
                if (status === "ai-same") return "bg-emerald-900/[0.06]";
                if (status === "ai-different") return "bg-red-900/[0.05]";
                if (status === "merged") return "bg-emerald-900/[0.08]";
                if (status === "rejected")
                  return "bg-red-900/[0.06] opacity-80";
                if (status === "escalated") return "bg-violet-900/[0.06]";
                if (status === "error") return "bg-red-950/[0.12]";
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

      <AiReviewDialog
        open={aiReviewOpen}
        onOpenChange={(open) => {
          setAiReviewOpen(open);
          if (!open && !applyingAiReview) {
            setAiProgress(null);
            setAiReviewResults([]);
            setPairStatuses(new Map());
          }
        }}
        results={aiReviewResults}
        applying={applyingAiReview}
        onActionChange={updateAiReviewAction}
        onApply={handleApplyAiReview}
        onDiscard={() => {
          setAiReviewOpen(false);
          setAiProgress(null);
          setAiReviewResults([]);
          setPairStatuses(new Map());
        }}
      />
    </TooltipProvider>
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
        title={fmtMmmHm(row.original.eventAStartTime)}
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

  // Processing status column (ML on inbox, AI review on inbox/human review)
  if (stage === "inbox" || stage === "human_review") {
    cols.push({
      id: "mlStatus",
      header: "Status",
      size: 80,
      meta: {
        hint: "Live processing status for ML scoring or AI verification.",
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
            {fmtMmmHm(row.original.decidedAt)}
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
        {fmtMmmHm(row.original.detectedAt)}
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
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  disabled={busy}
                  onClick={() => onDecide(id, "human-merge")}
                >
                  {busy ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <CheckCircle2 className="size-3.5 text-emerald-500" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-[280px]">
                Merge these two events and learn team aliases for future syncs.
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  disabled={busy}
                  onClick={() => onDecide(id, "human-reject")}
                >
                  <XCircle className="size-3.5 text-red-500" />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-[280px]">
                Reject this pair and record a negative observation for the ML
                system.
              </TooltipContent>
            </Tooltip>

            <AiVerifyDropdown
              inline
              disabled={busy}
              running={aiVerifyingIds.has(id)}
              onVerify={(engine, _model) => onVerifyAi(engine, "flash", id)}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href={buildSearchUrl(row.original)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center justify-center size-6 rounded-md hover:bg-accent"
                >
                  <ExternalLink className="size-3 text-zinc-500" />
                </a>
              </TooltipTrigger>
              <TooltipContent className="max-w-[260px]">
                Open Google AI Mode to manually verify this fixture pair.
              </TooltipContent>
            </Tooltip>
          </div>
        );
      },
    });
  }

  return cols;
}

function AiReviewDialog({
  open,
  onOpenChange,
  results,
  applying,
  onActionChange,
  onApply,
  onDiscard,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  results: AiReviewResult[];
  applying: boolean;
  onActionChange: (id: string, action: AiReviewAction) => void;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const actionableCount = results.filter(
    (result) => result.action !== "keep" && result.status !== "error",
  ).length;
  const same = results.filter((result) => result.aiDecision === "SAME").length;
  const different = results.filter(
    (result) => result.aiDecision === "DIFFERENT",
  ).length;
  const uncertain = results.filter(
    (result) => result.aiDecision === "UNCERTAIN",
  ).length;
  const failed = results.filter((result) => result.status === "error").length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-[1100px] gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/60 px-5 py-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="space-y-1">
              <DialogTitle className="text-base">
                AI verification review
              </DialogTitle>
              <DialogDescription className="text-xs">
                AI Search checked {results.length} pair
                {results.length === 1 ? "" : "s"}. No decisions are applied yet.
              </DialogDescription>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[10px] tabular-nums">
              <Badge
                variant="outline"
                className="border-emerald-700/40 text-emerald-300"
              >
                {same} same
              </Badge>
              <Badge
                variant="outline"
                className="border-red-700/40 text-red-300"
              >
                {different} different
              </Badge>
              <Badge
                variant="outline"
                className="border-violet-700/40 text-violet-300"
              >
                {uncertain} uncertain
              </Badge>
              {failed > 0 && (
                <Badge
                  variant="outline"
                  className="border-red-700/50 text-red-400"
                >
                  {failed} failed
                </Badge>
              )}
            </div>
          </div>
        </DialogHeader>

        <VirtualList
          items={results}
          getItemKey={(result) => result.id}
          estimateSize={116}
          overscan={8}
          className="max-h-[62vh]"
          rowClassName="border-b border-border/50"
          renderItem={(result) => (
            <AiReviewRow result={result} onActionChange={onActionChange} />
          )}
        />

        <DialogFooter className="border-t border-border/60 px-5 py-3">
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">
              {actionableCount} decision{actionableCount === 1 ? "" : "s"} ready
              to apply.
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onDiscard}
                disabled={applying}
              >
                Discard
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={onApply}
                disabled={applying || actionableCount === 0}
              >
                {applying && <Loader2 className="size-3 animate-spin" />}
                Apply decisions
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AiReviewRow({
  result,
  onActionChange,
}: {
  result: AiReviewResult;
  onActionChange: (id: string, action: AiReviewAction) => void;
}) {
  const pair = result.pair;
  const isError = result.status === "error";
  const decisionClass =
    result.aiDecision === "SAME"
      ? "border-emerald-700/40 text-emerald-300 bg-emerald-950/20"
      : result.aiDecision === "DIFFERENT"
        ? "border-red-700/40 text-red-300 bg-red-950/20"
        : result.aiDecision === "ERROR"
          ? "border-red-700/50 text-red-400 bg-red-950/20"
          : "border-violet-700/40 text-violet-300 bg-violet-950/20";

  return (
    <div className="grid gap-2 px-4 py-2.5 lg:grid-cols-[minmax(0,1fr)_126px_150px] lg:items-start">
      <div className="min-w-0 space-y-1.5">
        <div className="grid gap-1.5 md:grid-cols-2">
          <ReviewFixtureBlock
            label="A"
            provider={pair.eventAProvider}
            home={pair.eventAHomeTeam}
            away={pair.eventAAwayTeam}
            competition={pair.eventACompetition}
            startTime={pair.eventAStartTime}
          />
          <ReviewFixtureBlock
            label="B"
            provider={pair.eventBProvider}
            home={pair.eventBHomeTeam}
            away={pair.eventBAwayTeam}
            competition={pair.eventBCompetition}
            startTime={pair.eventBStartTime}
          />
        </div>
        <p className="line-clamp-2 text-[11px] leading-4 text-zinc-400">
          {isError ? result.error : result.reasoning}
        </p>
        {result.sources.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {result.sources.slice(0, 3).map((source) => (
              <a
                key={source.url}
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex max-w-[210px] items-center gap-1 truncate rounded border border-cyan-900/40 px-1.5 py-0 text-[10px] leading-5 text-cyan-300 hover:bg-cyan-950/30"
              >
                <ExternalLink className="size-2.5 shrink-0" />
                <span className="truncate">{source.title || source.url}</span>
              </a>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-row items-center gap-2 lg:flex-col lg:items-start lg:gap-1">
        <Badge
          variant="outline"
          className={cn("w-fit px-1.5 py-0 text-[10px]", decisionClass)}
        >
          {result.aiDecision === "ERROR" && (
            <AlertTriangle className="size-3" />
          )}
          {result.aiDecision}
        </Badge>
        {result.confidence != null && (
          <span className="text-[10px] tabular-nums text-zinc-400">
            {formatConfidence(result.confidence)} confidence
          </span>
        )}
        {result.model && (
          <span className="text-[10px] text-zinc-500">{result.model}</span>
        )}
      </div>

      <div className="flex items-center gap-1.5 lg:flex-col lg:items-stretch">
        <Select
          value={result.action}
          onValueChange={(value) =>
            onActionChange(result.id, value as AiReviewAction)
          }
          disabled={isError}
        >
          <SelectTrigger size="sm" className="h-7 w-[128px] lg:w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="merge">Merge</SelectItem>
            <SelectItem value="reject">Reject</SelectItem>
            <SelectItem value="keep">Keep in review</SelectItem>
          </SelectContent>
        </Select>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              asChild
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
            >
              <a href={buildSearchUrl(pair)} target="_blank" rel="noreferrer">
                <Search className="size-3" />
                Google AI Mode
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent className="max-w-[260px]">
            Opens Google AI Mode for manual fixture verification. It does not
            feed backend decisions.
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function ReviewFixtureBlock({
  label,
  provider,
  home,
  away,
  competition,
  startTime,
}: {
  label: string;
  provider: string;
  home: string;
  away: string;
  competition: string;
  startTime: string;
}) {
  const badge = PROVIDER_BADGE[provider] ?? {
    label: provider.slice(0, 3).toUpperCase(),
    className: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  };

  return (
    <div className="min-w-0 rounded-md border border-border/60 bg-zinc-950/30 px-2.5 py-2">
      <div className="mb-1 flex items-center gap-1.5">
        <span className="text-[10px] font-medium text-zinc-500">{label}</span>
        <Badge
          variant="outline"
          className={cn("text-[9px] px-1 py-0", badge.className)}
        >
          {badge.label}
        </Badge>
        <span className="ml-auto text-[10px] tabular-nums text-zinc-500">
          {fmtMmmHm(startTime)}
        </span>
      </div>
      <div className="truncate text-xs text-zinc-100">
        {home} <span className="text-zinc-500">vs</span> {away}
      </div>
      <div className="truncate text-[11px] text-zinc-500">{competition}</div>
    </div>
  );
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
  let scheduledStr = "";
  if (pair.eventAStartTime) {
    try {
      const kickoff = parseISO(pair.eventAStartTime);
      if (isValid(kickoff)) {
        scheduledStr = format(kickoff, "yyyy-MM-dd HH:mm");
      }
    } catch {}
  }
  if (!scheduledStr && pair.eventAStartTime) {
    scheduledStr = pair.eventAStartTime;
  }

  const query = [
    `Are these two fixtures the exact same match?`,
    ``,
    `Fixture A: ${pair.eventAHomeTeam} vs ${pair.eventAAwayTeam} (${pair.eventACompetition})`,
    `Fixture B: ${pair.eventBHomeTeam} vs ${pair.eventBAwayTeam} (${pair.eventBCompetition})`,
    ``,
    `Scheduled for: ${scheduledStr}.`,
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
