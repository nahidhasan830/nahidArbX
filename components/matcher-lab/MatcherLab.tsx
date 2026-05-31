"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isValid, parseISO } from "date-fns";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Activity,
  CheckCircle2,
  Clock3,
  Database,
  GitMerge,
  Loader2,
  Play,
  RefreshCw,
  Search,
  ShieldAlert,
  TerminalSquare,
  XCircle,
} from "lucide-react";
import type { RowSelectionState } from "@tanstack/react-table";

import { AppShell } from "@/components/nav/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { fmtSeen } from "@/lib/formatting/helpers";
import { MATCHER_LAB_AUTO_REFRESH_MS } from "@/lib/shared/constants";
import { cn } from "@/lib/utils";
import {
  fetchLatestMatcherRunJob,
  fetchMatcherDecisions,
  fetchMatcherRunJob,
  fetchMatcherSchedulerSettings,
  fetchMatcherStats,
  sendManualMatcherDecisions,
  startMatcherRunJob,
  updateMatcherSchedulerSettings,
} from "./api";
import {
  DECISION_META,
  PROVIDER_BADGE,
  PROVIDER_DISPLAY_NAMES,
  type MatcherDecisionRow,
  type MatcherManualDecision,
  type MatcherRunJob,
  type MatcherRunProgressEvent,
  type MatcherSchedulerSettingsRow,
  type MatcherStatsResponse,
} from "./types";

type DecisionFilter = "all" | "human_review" | "auto_merge" | "auto_reject";
type GroundedDecision = NonNullable<MatcherDecisionRow["groundedDecision"]>;
const ACTIVE_MATCHER_JOB_KEY = "matcher-lab-active-run-job";

const DECISION_FILTERS: { value: DecisionFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "human_review", label: "Needs review" },
  { value: "auto_merge", label: "Auto merge" },
  { value: "auto_reject", label: "Auto reject" },
];

const DECISION_TAB_COLORS: Record<
  DecisionFilter,
  { active: string; dot: string }
> = {
  all: {
    active: "bg-zinc-800 text-zinc-100 border-zinc-600",
    dot: "bg-zinc-400",
  },
  human_review: {
    active: "bg-amber-500/15 text-amber-300 border-amber-500/40",
    dot: "bg-amber-400",
  },
  auto_merge: {
    active: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
    dot: "bg-emerald-400",
  },
  auto_reject: {
    active: "bg-rose-500/15 text-rose-300 border-rose-500/40",
    dot: "bg-rose-400",
  },
};

const MANUAL_DECISION_LABELS: Record<MatcherManualDecision, string> = {
  auto_merge: "Match",
  auto_reject: "Not a match",
  human_review: "Needs review",
};

const GROUNDED_DECISION_META: Record<
  GroundedDecision,
  { label: string; className: string; description: string }
> = {
  SAME: {
    label: "Same",
    className: "border-emerald-500/25 bg-emerald-500/10 text-emerald-300",
    description: "Grounded review identified the rows as the same fixture.",
  },
  DIFFERENT: {
    label: "Different",
    className: "border-red-500/25 bg-red-500/10 text-red-300",
    description: "Grounded review identified the rows as different fixtures.",
  },
  UNCERTAIN: {
    label: "Unclear",
    className: "border-amber-500/25 bg-amber-500/10 text-amber-300",
    description: "Grounded review did not safely resolve the pair.",
  },
};

const PHASE_LABELS: Record<MatcherRunProgressEvent["phase"], string> = {
  initializing: "Initializing",
  loading_snapshots: "Snapshots",
  generating_candidates: "Candidates",
  filtering_candidates: "Deduping",
  scoring_candidates: "Scoring",
  reviewing_residual: "DeepSeek",
  writing_decision: "Decision",
  applying_merge: "Merge",
  rebuilding_impact: "Impact",
  completed: "Complete",
  failed: "Failed",
};

const RUN_PHASES: MatcherRunProgressEvent["phase"][] = [
  "initializing",
  "loading_snapshots",
  "generating_candidates",
  "filtering_candidates",
  "scoring_candidates",
  "reviewing_residual",
  "writing_decision",
  "applying_merge",
  "rebuilding_impact",
  "completed",
];

const PHASE_DETAILS: Partial<Record<MatcherRunProgressEvent["phase"], string>> =
  {
    initializing: "Preparing run scope",
    loading_snapshots: "Loading selected rows",
    generating_candidates: "Building candidate pairs",
    filtering_candidates: "Removing duplicate pairs",
    scoring_candidates: "Scoring teams and kickoff",
    reviewing_residual: "Checking ambiguous pairs",
    writing_decision: "Recording policy output",
    applying_merge: "Applying accepted links",
    rebuilding_impact: "Refreshing rollups",
    completed: "Ready for review",
    failed: "Run stopped",
  };

const MATCHER_LOCAL_TIME_ZONE = "Asia/Dhaka";

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "n/a";
  const d = parseISO(iso);
  if (!isValid(d)) return "n/a";
  return `${fmtZonedTime(d, MATCHER_LOCAL_TIME_ZONE)} BDT`;
}

function fmtShort(iso: string | null | undefined): string {
  if (!iso) return "n/a";
  const d = parseISO(iso);
  if (!isValid(d)) return "n/a";
  return `${fmtZonedTime(d, MATCHER_LOCAL_TIME_ZONE, false)} BDT`;
}

function fmtZonedTime(
  date: Date,
  timeZone: string,
  includeSeconds = true,
): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" as const } : {}),
    hourCycle: "h23",
  })
    .format(date)
    .replace(",", "")
    .replace(/^0/, "");
}

function fmtElapsed(ms: number | null | undefined): string {
  if (!ms || ms < 0) return "0s";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (minutes === 0) return `${remaining}s`;
  return `${minutes}m ${remaining}s`;
}

function fmtPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return `${Math.round(value * 100)}%`;
}

function fmtInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${(seconds / 60).toFixed(1)}m`;
}

function buildGoogleAiModeUrl(row: MatcherDecisionRow): string {
  const query = [
    `Are these the same football match?`,
    `All kickoff times below are Bangladesh local time (Asia/Dhaka, BDT).`,
    `Event A: ${row.eventA.homeTeam} vs ${row.eventA.awayTeam}, ${row.eventA.competition}, kickoff ${fmtDateTime(row.eventA.kickoff)}, provider ${PROVIDER_DISPLAY_NAMES[row.eventA.provider] ?? row.eventA.provider}.`,
    `Event B: ${row.eventB.homeTeam} vs ${row.eventB.awayTeam}, ${row.eventB.competition}, kickoff ${fmtDateTime(row.eventB.kickoff)}, provider ${PROVIDER_DISPLAY_NAMES[row.eventB.provider] ?? row.eventB.provider}.`,
    `Check official fixtures and reliable sources. Answer with Same match, Different match, or Unclear, then summarize the key reason.`,
  ].join("\n");
  const params = new URLSearchParams({
    q: query,
    udm: "50",
    aep: "1",
    hl: "en",
  });
  return `https://www.google.com/search?${params.toString()}`;
}

function openGoogleAiMode(row: MatcherDecisionRow) {
  window.open(buildGoogleAiModeUrl(row), "_blank", "noopener,noreferrer");
}

function providerMeta(provider: string) {
  return (
    PROVIDER_BADGE[provider] ?? {
      label: provider.slice(0, 4).toUpperCase(),
      className: "border-zinc-600 bg-zinc-800 text-zinc-300",
    }
  );
}

function ProviderBadge({ provider }: { provider: string }) {
  const meta = providerMeta(provider);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={cn("px-1.5 py-0 text-[10px]", meta.className)}
        >
          {meta.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        {PROVIDER_DISPLAY_NAMES[provider] ?? provider}
      </TooltipContent>
    </Tooltip>
  );
}

function DecisionBadge({
  decision,
}: {
  decision: MatcherDecisionRow["decision"];
}) {
  const meta = DECISION_META[decision];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={cn("px-1.5 py-0 text-[10px]", meta.className)}
        >
          {meta.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px]">
        {meta.description}
      </TooltipContent>
    </Tooltip>
  );
}

function inferGroundedDecision(
  row: MatcherDecisionRow,
): GroundedDecision | null {
  if (row.groundedDecision) return row.groundedDecision;
  if (row.reasonCode === "grounded_llm_same_match") return "SAME";
  if (row.reasonCode === "grounded_llm_different_match") return "DIFFERENT";
  if (
    row.reasonCode === "llm_uncertain" ||
    row.reasonCode === "llm_evidence_conflict"
  ) {
    const reason = row.reasonSummary.toLowerCase();
    if (
      /\b(teams?\s+.*differ|different\s+(fixture|match)|distinct clubs|not evidenced|no .*match)\b/.test(
        reason,
      )
    ) {
      return "DIFFERENT";
    }
    if (/\b(same\s+(fixture|match)|one fixture|same event)\b/.test(reason)) {
      return "SAME";
    }
    return "UNCERTAIN";
  }
  return null;
}

function GroundedDecisionBadge({ row }: { row: MatcherDecisionRow }) {
  const groundedDecision = inferGroundedDecision(row);
  if (!groundedDecision) {
    return <span className="text-[10px] text-muted-foreground">n/a</span>;
  }
  const meta = GROUNDED_DECISION_META[groundedDecision];
  const confidence = row.groundedConfidence ?? row.confidence;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={cn("px-1.5 py-0 text-[10px]", meta.className)}
        >
          {meta.label}
          {confidence != null ? ` ${fmtPercent(confidence)}` : ""}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-[280px]">
        {meta.description}
      </TooltipContent>
    </Tooltip>
  );
}

function EventBlock({
  row,
  side,
}: {
  row: MatcherDecisionRow;
  side: "A" | "B";
}) {
  const event = side === "A" ? row.eventA : row.eventB;
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex items-center gap-1.5">
        <ProviderBadge provider={event.provider} />
        <span className="truncate text-[11px] font-medium text-foreground">
          {event.homeTeam} v {event.awayTeam}
        </span>
      </div>
      <div className="truncate text-[10px] text-muted-foreground">
        {event.competition}
      </div>
    </div>
  );
}

function MetricTile({
  label,
  value,
  icon: Icon,
  detail,
  tone = "zinc",
}: {
  label: string;
  value: string | number;
  icon: typeof Activity;
  detail?: string;
  tone?: "zinc" | "emerald" | "red" | "sky" | "amber";
}) {
  const toneClass = {
    zinc: "text-zinc-300 bg-zinc-500/10 border-zinc-700/60",
    emerald: "text-emerald-300 bg-emerald-500/10 border-emerald-500/25",
    red: "text-red-300 bg-red-500/10 border-red-500/25",
    sky: "text-sky-300 bg-sky-500/10 border-sky-500/25",
    amber: "text-amber-300 bg-amber-500/10 border-amber-500/25",
  }[tone];

  return (
    <div className={cn("rounded-md border px-3 py-2", toneClass)}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <Icon className="size-3.5" />
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">
        {value}
      </div>
      {detail && (
        <div className="mt-1 truncate text-[10px] text-muted-foreground">
          {detail}
        </div>
      )}
    </div>
  );
}

function HeaderDot() {
  return <span className="text-muted-foreground/40">·</span>;
}

function HeaderMetric({
  icon,
  label,
  value,
  tone = "muted",
  loading,
  tooltip,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  tone?: "positive" | "negative" | "warning" | "info" | "muted";
  loading?: boolean;
  tooltip: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 cursor-help items-center gap-1 text-muted-foreground">
          {icon}
          <span className="opacity-80">{label}</span>
          {loading ? (
            <Skeleton className="h-3.5 w-10 rounded" />
          ) : (
            <span
              className={cn(
                "font-medium tabular-nums",
                tone === "positive" && "text-emerald-400",
                tone === "negative" && "text-red-400",
                tone === "warning" && "text-amber-400",
                tone === "info" && "text-sky-400",
                tone === "muted" && "text-foreground",
              )}
            >
              {value}
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[300px]">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function MatcherLabHeader({
  stats,
  scheduler,
}: {
  stats: MatcherStatsResponse | null;
  scheduler: MatcherSchedulerSettingsRow | null;
}) {
  const counts = new Map(
    stats?.decisionCounts.map((item) => [item.decision, item.count]) ?? [],
  );
  const reliability = stats?.reliability;
  const reviewEngineValue = !scheduler?.useDeepSeek
    ? "Off"
    : reliability?.healthy
      ? "Healthy"
      : "Degraded";
  const reviewEngineDetail = !scheduler?.useDeepSeek
    ? "DeepSeek review is disabled"
    : reliability?.degradationReason ||
      `${fmtPercent(reliability?.noSourceRate)} no-source`;
  const loading = !stats;
  const schedulerLoading = !scheduler;

  return (
    <div className="ml-2 hidden min-w-0 items-center gap-2 overflow-x-auto text-[11px] lg:flex">
      <HeaderMetric
        icon={<ShieldAlert className="size-3 opacity-70" />}
        label="Review"
        value={stats?.reviewCount ?? 0}
        tone={stats && stats.reviewCount > 0 ? "warning" : "muted"}
        loading={loading}
        tooltip={
          <span>
            <b>Open review.</b> Matcher decisions that still need operator
            review before outcomes are applied.
          </span>
        }
      />
      <HeaderDot />
      <HeaderMetric
        icon={<GitMerge className="size-3 opacity-70" />}
        label="Merged"
        value={counts.get("auto_merge") ?? 0}
        tone="positive"
        loading={loading}
        tooltip={
          <span>
            <b>Auto merged.</b> Candidate pairs accepted by deterministic,
            scoring, or DeepSeek review policy.
          </span>
        }
      />
      <HeaderDot />
      <HeaderMetric
        icon={<XCircle className="size-3 opacity-70" />}
        label="Rejected"
        value={counts.get("auto_reject") ?? 0}
        tone="negative"
        loading={loading}
        tooltip={
          <span>
            <b>Auto rejected.</b> Candidate pairs blocked by hard rules or low
            confidence scores.
          </span>
        }
      />
      <HeaderDot />
      <HeaderMetric
        icon={<Activity className="size-3 opacity-70" />}
        label="LLM"
        value={reliability?.deepseekResolved ?? 0}
        tone="info"
        loading={loading}
        tooltip={
          <span>
            <b>LLM resolved.</b>{" "}
            {reliability
              ? `${reliability.deepseekReviewed} reviewed, ${reliability.groundedReviewSkipped} skipped.`
              : "DeepSeek review counts are loading."}
          </span>
        }
      />
      <HeaderDot />
      <HeaderMetric
        icon={<Clock3 className="size-3 opacity-70" />}
        label="Scheduler"
        value={
          scheduler?.enabled ? fmtInterval(scheduler.intervalSeconds) : "Off"
        }
        tone={scheduler?.enabled ? "muted" : "warning"}
        loading={schedulerLoading}
        tooltip={
          <span>
            <b>Scheduler cadence.</b> How often the engine-side matcher loop
            runs automatically.
          </span>
        }
      />
      <HeaderDot />
      <HeaderMetric
        icon={<Search className="size-3 opacity-70" />}
        label="Review engine"
        value={reviewEngineValue}
        tone={
          !scheduler?.useDeepSeek
            ? "muted"
            : reliability?.healthy
              ? "info"
              : "warning"
        }
        loading={schedulerLoading || loading}
        tooltip={
          <span>
            <b>Review engine.</b> {reviewEngineDetail}
          </span>
        }
      />
    </div>
  );
}

function SchedulerPopover({
  scheduler,
  setScheduler,
}: {
  scheduler: MatcherSchedulerSettingsRow | null;
  setScheduler: (value: MatcherSchedulerSettingsRow) => void;
}) {
  const [saving, setSaving] = useState(false);
  const update = async (patch: {
    enabled?: boolean;
    intervalSeconds?: number;
    useDeepSeek?: boolean;
  }) => {
    setSaving(true);
    try {
      const next = await updateMatcherSchedulerSettings(patch);
      setScheduler(next.row);
      toast.success("Scheduler updated");
    } catch (err) {
      toast.error("Failed to update scheduler", {
        description: (err as Error).message,
      });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7"
            >
              <Clock3 className="size-3.5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Open matcher scheduler config</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-[320px] p-0">
        <div className="border-b px-3 py-2">
          <div className="text-sm font-medium">Matcher scheduler</div>
          <div className="text-xs text-muted-foreground">
            Controls the engine-side matcher loop.
          </div>
        </div>

        <div className="space-y-3 p-3">
          <div className="flex items-center justify-between rounded-md border px-2 py-2">
            <div>
              <div className="text-xs font-medium">Enabled</div>
              <div className="text-[10px] text-muted-foreground">
                Automatic matcher passes
              </div>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Switch
                  checked={scheduler?.enabled ?? true}
                  onCheckedChange={(enabled) => update({ enabled })}
                  disabled={saving || !scheduler}
                  className="border border-border bg-zinc-700 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-zinc-700"
                />
              </TooltipTrigger>
              <TooltipContent>
                Enable or pause the engine matcher scheduler
              </TooltipContent>
            </Tooltip>
          </div>

          <div className="flex items-center justify-between rounded-md border px-2 py-2">
            <div>
              <div className="text-xs font-medium">Ambiguous-pair review</div>
              <div className="text-[10px] text-muted-foreground">
                DeepSeek review for borderline pairs
              </div>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Switch
                  checked={scheduler?.useDeepSeek ?? true}
                  onCheckedChange={(useDeepSeek) => update({ useDeepSeek })}
                  disabled={saving || !scheduler}
                  className="border border-border bg-zinc-700 data-[state=checked]:bg-sky-500 data-[state=unchecked]:bg-zinc-700"
                />
              </TooltipTrigger>
              <TooltipContent>AI search calls can cost money</TooltipContent>
            </Tooltip>
          </div>

          <div className="grid gap-2">
            <label className="text-xs font-medium">Interval</label>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="relative">
                  <Input
                    type="number"
                    min={15}
                    value={scheduler?.intervalSeconds ?? 60}
                    onBlur={(event) => {
                      update({ intervalSeconds: Number(event.target.value) });
                    }}
                    onChange={(event) => {
                      if (!scheduler) return;
                      setScheduler({
                        ...scheduler,
                        intervalSeconds: Number(event.target.value),
                      });
                    }}
                    disabled={saving || !scheduler}
                    className="h-8 pr-10 text-xs"
                  />
                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
                    sec
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent>Minimum interval is 15 seconds</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function RunProgressModal({
  open,
  onOpenChange,
  events,
  running,
  rows,
  decisions,
  saving,
  onDecisionChange,
  onCommit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  events: MatcherRunProgressEvent[];
  running: boolean;
  rows: MatcherDecisionRow[];
  decisions: Record<string, MatcherManualDecision>;
  saving: boolean;
  onDecisionChange: (
    decisionId: string,
    decision: MatcherManualDecision,
  ) => void;
  onCommit: () => void;
}) {
  const latest = events[events.length - 1] ?? null;
  const counters = latest?.counters;
  const summary = latest?.summary;
  const resultCounts = useMemo(
    () =>
      rows.reduce(
        (acc, row) => {
          const decision = decisions[row.decisionId] ?? "human_review";
          acc[decision] += 1;
          return acc;
        },
        { auto_merge: 0, auto_reject: 0, human_review: 0 },
      ),
    [decisions, rows],
  );
  const scored = counters?.scoredCandidates ?? summary?.candidateCount ?? 0;
  const scoringTotal =
    counters?.candidatesToScore ?? summary?.candidateCount ?? 0;
  const runStatus = latest?.phase ?? (running ? "initializing" : null);
  const currentPhaseIndex =
    latest?.phase === "failed"
      ? -1
      : Math.max(0, RUN_PHASES.indexOf(latest?.phase ?? "initializing"));
  const reviewing =
    !running && rows.length > 0 && latest?.phase === "completed";
  const failed = latest?.phase === "failed";
  const eventLog = [...events].reverse();
  const selectedCount = counters?.snapshots ?? summary?.snapshotCount ?? rows.length;
  const outputTotal =
    resultCounts.auto_merge +
    resultCounts.auto_reject +
    resultCounts.human_review;
  const runStepState =
    failed || reviewing || currentPhaseIndex > RUN_PHASES.indexOf("completed")
      ? "done"
      : running
        ? "active"
        : "pending";
  const reviewStepState = failed
    ? "failed"
    : reviewing
      ? "active"
      : running
        ? "pending"
        : "pending";
  const saveStepState = saving ? "active" : "pending";

  const phaseState = (phase: MatcherRunProgressEvent["phase"]) => {
    const index = RUN_PHASES.indexOf(phase);
    if (failed && phase === latest?.phase) return "failed";
    if (reviewing || (!failed && index < currentPhaseIndex)) return "done";
    if (!failed && index === currentPhaseIndex) return "active";
    return "pending";
  };

  const runState = failed
    ? "Failed"
    : reviewing
      ? "Ready to apply"
      : running
        ? "Running"
        : "Waiting";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(860px,92dvh)] w-[min(1220px,calc(100vw-24px))] max-w-none flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b bg-background px-5 py-4">
          <div className="flex items-start justify-between gap-4 pr-8">
            <div className="min-w-0">
              <DialogTitle className="flex items-center gap-2 text-base">
                {failed ? (
                  <XCircle className="size-4 text-red-400" />
                ) : reviewing ? (
                  <CheckCircle2 className="size-4 text-emerald-400" />
                ) : running ? (
                  <Loader2 className="size-4 animate-spin text-sky-400" />
                ) : (
                  <TerminalSquare className="size-4 text-muted-foreground" />
                )}
                Matcher run review
              </DialogTitle>
              <DialogDescription className="mt-1 text-xs">
                {reviewing
                  ? "Adjust the staged decisions, then save the final outcomes."
                  : "The matcher scores selected rows first. Final outcomes are saved after review."}
              </DialogDescription>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px]",
                  failed && "border-red-500/30 bg-red-500/10 text-red-300",
                  reviewing &&
                    "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
                  running && "border-sky-500/30 bg-sky-500/10 text-sky-300",
                  !failed &&
                    !reviewing &&
                    !running &&
                    "border-border text-muted-foreground",
                )}
              >
                {runState}
              </Badge>
              <span className="text-[11px] text-muted-foreground">
                {latest
                  ? `Elapsed ${fmtElapsed(latest.elapsedMs)}`
                  : "No events"}
              </span>
            </div>
          </div>
        </DialogHeader>

        <div className="max-h-[34dvh] shrink-0 overflow-y-auto border-b bg-muted/20 p-4 lg:max-h-none lg:overflow-visible">
          <div className="grid gap-3 lg:grid-cols-4">
            <OperatorFlowStep
              step="1"
              label="Selected rows"
              detail={`${selectedCount.toLocaleString()} rows in scope`}
              state={failed ? "done" : "done"}
            />
            <OperatorFlowStep
              step="2"
              label="Matcher scoring"
              detail={`${scored.toLocaleString()} of ${scoringTotal.toLocaleString()} scored`}
              state={failed ? "failed" : runStepState}
            />
            <OperatorFlowStep
              step="3"
              label="Review output"
              detail={`${outputTotal.toLocaleString()} staged decisions`}
              state={reviewStepState}
            />
            <OperatorFlowStep
              step="4"
              label="Save outcomes"
              detail="Only this step commits your choices"
              state={saveStepState}
            />
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <RunMetricCard
              label="Candidate pairs"
              value={(
                counters?.generatedCandidates ??
                summary?.generatedCandidateCount ??
                0
              ).toLocaleString()}
              detail={`${(
                counters?.skippedCandidates ??
                summary?.skippedCandidateCount ??
                0
              ).toLocaleString()} skipped as duplicates`}
            />
            <RunMetricCard
              label="Scored"
              value={scored.toLocaleString()}
              detail={`${scoringTotal.toLocaleString()} pairs in this run`}
            />
            <RunMetricCard
              label="Staged actions"
              value={(
                (counters?.autoMerged ?? summary?.autoMerged ?? 0) +
                (counters?.autoRejected ?? summary?.autoRejected ?? 0)
              ).toLocaleString()}
              detail={`${(
                counters?.autoMerged ??
                summary?.autoMerged ??
                0
              ).toLocaleString()} match, ${(
                counters?.autoRejected ??
                summary?.autoRejected ??
                0
              ).toLocaleString()} not a match`}
              tone="emerald"
            />
            <RunMetricCard
              label="Needs operator"
              value={(
                counters?.humanReview ??
                summary?.humanReview ??
                resultCounts.human_review
              ).toLocaleString()}
              detail={`${(
                counters?.deepseekReviewed ??
                summary?.deepseekReviewed ??
                0
              ).toLocaleString()} ambiguous pairs checked`}
              tone={resultCounts.human_review > 0 ? "amber" : "zinc"}
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden bg-background">
          {reviewing ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="border-b bg-background px-4 py-3">
                <div className="grid gap-2 md:grid-cols-[1fr_auto] md:items-center">
                  <div>
                    <div className="text-sm font-medium">Outcome review</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      Final choices are saved only when you apply the reviewed
                      outcomes.
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <ReviewCount
                      label="Link"
                      value={resultCounts.auto_merge}
                      tone="emerald"
                    />
                    <ReviewCount
                      label="Separate"
                      value={resultCounts.auto_reject}
                      tone="red"
                    />
                    <ReviewCount
                      label="Review"
                      value={resultCounts.human_review}
                      tone="amber"
                    />
                  </div>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="divide-y">
                  {rows.map((row) => (
                    <ReviewRow
                      key={row.decisionId}
                      row={row}
                      decision={decisions[row.decisionId] ?? "human_review"}
                      onDecisionChange={(decision) =>
                        onDecisionChange(row.decisionId, decision)
                      }
                    />
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="grid h-full min-h-0 lg:grid-cols-[minmax(0,1fr)_360px]">
              <div className="min-h-0 overflow-y-auto p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">
                      {latest?.message ?? "Waiting for matcher events"}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {runStatus ? PHASE_LABELS[runStatus] : "Queued"}
                    </div>
                  </div>
                  {failed && (
                    <Badge
                      variant="outline"
                      className="border-red-500/30 bg-red-500/10 text-red-300"
                    >
                      Failed
                    </Badge>
                  )}
                </div>

                <div className="mb-3 rounded-md border bg-card/50 px-3 py-2">
                  <div className="text-xs font-medium">Pipeline details</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    These are internal matcher stages. The operator flow above
                    is the decision path.
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {RUN_PHASES.map((phase) => (
                    <PhaseCard
                      key={phase}
                      phase={phase}
                      state={phaseState(phase)}
                    />
                  ))}
                </div>
              </div>

              <div className="flex min-h-0 flex-col border-t bg-muted/20 lg:border-l lg:border-t-0">
                <div className="shrink-0 border-b px-4 py-3">
                  <div className="text-sm font-medium">Activity</div>
                  <div className="text-xs text-muted-foreground">
                    Newest events first
                  </div>
                </div>
                <div className="h-0 min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
                  {events.length === 0 ? (
                    <div className="flex h-56 flex-col items-center justify-center gap-2 rounded-md border border-dashed text-muted-foreground">
                      <Loader2 className="size-5 animate-spin" />
                      <div className="text-sm">Waiting for matcher events</div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {eventLog.map((event, index) => (
                        <RunEventRow
                          key={`${event.timestamp}-${index}`}
                          event={event}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {reviewing && (
          <DialogFooter className="border-t bg-background px-4 py-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={saving}
                >
                  Close
                </Button>
              </TooltipTrigger>
              <TooltipContent>Close without saving changes</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={onCommit}
                  disabled={saving || rows.length === 0}
                >
                  {saving ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <GitMerge className="size-4" />
                  )}
                  Apply reviewed outcomes
                </Button>
              </TooltipTrigger>
              <TooltipContent>Save the selected matcher outcomes</TooltipContent>
            </Tooltip>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function OperatorFlowStep({
  step,
  label,
  detail,
  state,
}: {
  step: string;
  label: string;
  detail: string;
  state: "pending" | "active" | "done" | "failed";
}) {
  return (
    <div
      className={cn(
        "rounded-md border bg-background px-3 py-2.5",
        state === "active" && "border-sky-500/35 bg-sky-500/10",
        state === "done" && "border-emerald-500/30 bg-emerald-500/10",
        state === "failed" && "border-red-500/30 bg-red-500/10",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold tabular-nums",
              state === "done" &&
                "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
              state === "active" &&
                "border-sky-500/40 bg-sky-500/15 text-sky-300",
              state === "failed" &&
                "border-red-500/40 bg-red-500/15 text-red-300",
              state === "pending" &&
                "border-border bg-muted/40 text-muted-foreground",
            )}
          >
            {step}
          </span>
          <span className="truncate text-xs font-medium">{label}</span>
        </div>
        <RunStateIcon state={state} />
      </div>
      <div className="mt-1 truncate pl-7 text-[11px] text-muted-foreground">
        {detail}
      </div>
    </div>
  );
}

function RunStateIcon({
  state,
}: {
  state: "pending" | "active" | "done" | "failed";
}) {
  if (state === "done") {
    return <CheckCircle2 className="size-3.5 text-emerald-400" />;
  }
  if (state === "active") {
    return <Loader2 className="size-3.5 animate-spin text-sky-400" />;
  }
  if (state === "failed") {
    return <XCircle className="size-3.5 text-red-400" />;
  }
  return (
    <span className="size-3.5 rounded-full border border-muted-foreground/30" />
  );
}

function RunMetricCard({
  label,
  value,
  detail,
  tone = "zinc",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "zinc" | "emerald" | "amber";
}) {
  return (
    <div
      className={cn(
        "rounded-md border bg-background px-3 py-2",
        tone === "emerald" && "border-emerald-500/20",
        tone === "amber" && "border-amber-500/25",
      )}
    >
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 text-xl font-semibold tabular-nums",
          tone === "emerald" && "text-emerald-300",
          tone === "amber" && "text-amber-300",
        )}
      >
        {value}
      </div>
      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
        {detail}
      </div>
    </div>
  );
}

function PhaseCard({
  phase,
  state,
}: {
  phase: MatcherRunProgressEvent["phase"];
  state: "pending" | "active" | "done" | "failed";
}) {
  return (
    <div
      className={cn(
        "rounded-md border bg-card/50 p-3 transition-colors",
        state === "done" && "border-emerald-500/25 bg-emerald-500/10",
        state === "active" && "border-sky-500/35 bg-sky-500/10",
        state === "failed" && "border-red-500/35 bg-red-500/10",
      )}
    >
      <div className="flex items-center gap-2">
        <RunStateIcon state={state} />
        <span className="text-xs font-medium">{PHASE_LABELS[phase]}</span>
      </div>
      <div className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {PHASE_DETAILS[phase]}
      </div>
    </div>
  );
}

function ReviewCount({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "emerald" | "red" | "amber";
}) {
  return (
    <div
      className={cn(
        "min-w-24 rounded-md border bg-card/50 px-3 py-2",
        tone === "emerald" && "border-emerald-500/25",
        tone === "red" && "border-red-500/25",
        tone === "amber" && "border-amber-500/25",
      )}
    >
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div
        className={cn(
          "text-lg font-semibold tabular-nums",
          tone === "emerald" && "text-emerald-300",
          tone === "red" && "text-red-300",
          tone === "amber" && "text-amber-300",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function ReviewRow({
  row,
  decision,
  onDecisionChange,
}: {
  row: MatcherDecisionRow;
  decision: MatcherManualDecision;
  onDecisionChange: (decision: MatcherManualDecision) => void;
}) {
  return (
    <div className="grid gap-3 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_180px_190px_auto] lg:items-center">
      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        <div className="min-w-0 rounded-md border bg-muted/20 p-2">
          <EventBlock row={row} side="A" />
          <div className="mt-2 text-[11px] text-muted-foreground">
            KO {fmtShort(row.eventA.kickoff)}
          </div>
        </div>
        <div className="min-w-0 rounded-md border bg-muted/20 p-2">
          <EventBlock row={row} side="B" />
          <div className="mt-2 text-[11px] text-muted-foreground">
            KO {fmtShort(row.eventB.kickoff)}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs lg:grid-cols-1">
        <div>
          <div className="text-[11px] text-muted-foreground">Score</div>
          <div className="font-medium tabular-nums">
            {fmtPercent(row.scoreBreakdown?.combined)}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-muted-foreground">Confidence</div>
          <div className="font-medium tabular-nums">
            {fmtPercent(row.confidence)}
          </div>
        </div>
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <div>
            <Select
              value={decision}
              onValueChange={(value) =>
                onDecisionChange(value as MatcherManualDecision)
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["auto_merge", "auto_reject", "human_review"] as const).map(
                  (item) => (
                    <SelectItem key={item} value={item}>
                      {MANUAL_DECISION_LABELS[item]}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </div>
        </TooltipTrigger>
        <TooltipContent>Choose the final outcome for this pair</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            onClick={() => openGoogleAiMode(row)}
          >
            <Search className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Open manual Google AI Mode verification</TooltipContent>
      </Tooltip>
    </div>
  );
}

function RunEventRow({ event }: { event: MatcherRunProgressEvent }) {
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="text-[10px]">
          {PHASE_LABELS[event.phase]}
        </Badge>
        <span className="font-mono text-[10px] text-muted-foreground">
          +{fmtElapsed(event.elapsedMs)}
        </span>
        <span className="text-xs font-medium">{event.message}</span>
      </div>

      {event.candidate && (
        <div className="mt-2 grid gap-2 text-xs">
          <CandidatePreview
            provider={event.candidate.providerA}
            home={event.candidate.homeA}
            away={event.candidate.awayA}
            kickoff={event.candidate.kickoffA}
          />
          <CandidatePreview
            provider={event.candidate.providerB}
            home={event.candidate.homeB}
            away={event.candidate.awayB}
            kickoff={event.candidate.kickoffB}
          />
        </div>
      )}

      {(event.score || event.decision || event.errorMessage) && (
        <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
          {event.score && (
            <>
              <span>score {fmtPercent(event.score.combined)}</span>
              <span>teams {fmtPercent(event.score.team)}</span>
              <span>competition {fmtPercent(event.score.competition)}</span>
              <span>kickoff {fmtPercent(event.score.kickoff)}</span>
            </>
          )}
          {event.decision && (
            <span className="text-foreground">
              {DECISION_META[event.decision.value]?.label ??
                event.decision.value}{" "}
              at {fmtPercent(event.decision.confidence)}
            </span>
          )}
          {event.errorMessage && (
            <span className="text-red-300">{event.errorMessage}</span>
          )}
        </div>
      )}
    </div>
  );
}

function CandidatePreview({
  provider,
  home,
  away,
  kickoff,
}: {
  provider: string;
  home: string;
  away: string;
  kickoff: string;
}) {
  return (
    <div className="rounded-md bg-muted/40 p-2">
      <div className="mb-1 text-[10px] text-muted-foreground">
        {PROVIDER_DISPLAY_NAMES[provider] ?? provider}
      </div>
      <div className="truncate font-medium">
        {home} vs {away}
      </div>
      <div className="text-[10px] text-muted-foreground">
        {fmtShort(kickoff)}
      </div>
    </div>
  );
}

function RunStatusButton({
  job,
  running,
  eventCount,
  resultCount,
  onOpen,
}: {
  job: MatcherRunJob | null;
  running: boolean;
  eventCount: number;
  resultCount: number;
  onOpen: () => void;
}) {
  if (!job) return null;

  const failed = job.status === "failed";
  const completed = job.status === "completed";
  const label = failed
    ? "Run failed"
    : completed
      ? "Review results"
      : "Run running";
  const detail = failed
    ? job.errorMessage || "Open matcher run details"
    : completed
      ? `${resultCount.toLocaleString()} staged decisions`
      : `${eventCount.toLocaleString()} events received`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant={completed ? "default" : "outline"}
          className={cn(
            "h-7 gap-1.5 px-2 text-[11px]",
            running && "border-sky-500/35 bg-sky-500/10 text-sky-300",
            failed && "border-red-500/35 bg-red-500/10 text-red-300",
          )}
          onClick={onOpen}
        >
          {running ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : failed ? (
            <XCircle className="size-3.5" />
          ) : (
            <CheckCircle2 className="size-3.5" />
          )}
          {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{detail}</TooltipContent>
    </Tooltip>
  );
}

function DetailDialog({
  row,
  open,
  onOpenChange,
}: {
  row: MatcherDecisionRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const score = row?.scoreBreakdown;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86dvh] max-w-5xl overflow-auto">
        <DialogHeader>
          <DialogTitle>Matcher decision</DialogTitle>
          <DialogDescription>
            Candidate score components and final policy output.
          </DialogDescription>
        </DialogHeader>

        {row && (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-md border bg-muted/20 p-3">
                <EventBlock row={row} side="A" />
                <div className="mt-2 text-[11px] text-muted-foreground">
                  KO {fmtDateTime(row.eventA.kickoff)}
                </div>
              </div>
              <div className="rounded-md border bg-muted/20 p-3">
                <EventBlock row={row} side="B" />
                <div className="mt-2 text-[11px] text-muted-foreground">
                  KO {fmtDateTime(row.eventB.kickoff)}
                </div>
              </div>
            </div>

            <div className="grid gap-2 md:grid-cols-4">
              <MetricTile
                label="Confidence"
                value={fmtPercent(row.confidence)}
                icon={CheckCircle2}
                tone="emerald"
              />
              <MetricTile
                label="Combined"
                value={fmtPercent(score?.combined)}
                icon={Activity}
                tone="sky"
              />
              <MetricTile
                label="Best team"
                value={fmtPercent(score?.bestTeam)}
                icon={GitMerge}
              />
              <MetricTile
                label="Kickoff"
                value={fmtPercent(score?.kickoff)}
                icon={Database}
              />
            </div>

            <div className="grid gap-3 lg:grid-cols-[1fr_1.1fr]">
              <div className="rounded-md border p-3">
                <div className="mb-2 text-xs font-medium">Policy</div>
                <div className="space-y-2 text-[11px]">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Decision</span>
                    <DecisionBadge decision={row.decision} />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Grounded</span>
                    <GroundedDecisionBadge row={row} />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Stage</span>
                    <span>{row.decisionStage}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Final</span>
                    <span>{row.final ? "yes" : "no"}</span>
                  </div>
                </div>
              </div>

              <div className="rounded-md border p-3">
                <div className="mb-2 text-xs font-medium">Reason</div>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {row.reasonSummary}
                </p>
                {row.hardBlockers.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {row.hardBlockers.map((blocker) => (
                      <Badge
                        key={blocker}
                        variant="outline"
                        className="text-[10px]"
                      >
                        {blocker}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {score && (
              <div className="grid gap-2 rounded-md border p-3 md:grid-cols-3">
                {[
                  ["home", score.home],
                  ["away", score.away],
                  ["swapped home", score.swappedHome],
                  ["swapped away", score.swappedAway],
                  ["competition", score.competition],
                  ["embedding team", score.embeddingTeam],
                  ["embedding comp", score.embeddingCompetition],
                  ["provider reliability", score.providerReliability],
                  ["alias", score.alias],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="flex justify-between gap-3 text-[11px]"
                  >
                    <span className="text-muted-foreground">{label}</span>
                    <span className="tabular-nums">
                      {fmtPercent(value as number | null)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {row && (
            <Button
              type="button"
              variant="outline"
              onClick={() => openGoogleAiMode(row)}
            >
              <Search className="size-4" />
              Google AI Mode
            </Button>
          )}
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MatcherLab() {
  const [stats, setStats] = useState<MatcherStatsResponse | null>(null);
  const [rows, setRows] = useState<MatcherDecisionRow[]>([]);
  const [rowTotal, setRowTotal] = useState(0);
  const [rowDecisionCounts, setRowDecisionCounts] = useState<
    { decision: string; count: number }[]
  >([]);
  const [decisionFilter, setDecisionFilter] =
    useState<DecisionFilter>("human_review");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [running, setRunning] = useState(false);
  const [scheduler, setScheduler] =
    useState<MatcherSchedulerSettingsRow | null>(null);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [resultRows, setResultRows] = useState<MatcherDecisionRow[]>([]);
  const [resultDecisions, setResultDecisions] = useState<
    Record<string, MatcherManualDecision>
  >({});
  const [savingResults, setSavingResults] = useState(false);
  const [detailRow, setDetailRow] = useState<MatcherDecisionRow | null>(null);
  const [runMonitorOpen, setRunMonitorOpen] = useState(false);
  const [runEvents, setRunEvents] = useState<MatcherRunProgressEvent[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [currentRunJob, setCurrentRunJob] = useState<MatcherRunJob | null>(
    null,
  );
  const refreshSeqRef = useRef(0);
  const rowLoadSeqRef = useRef(0);

  const loadStats = useCallback(async () => {
    const [data, schedulerData] = await Promise.all([
      fetchMatcherStats(),
      fetchMatcherSchedulerSettings(),
    ]);
    setStats(data);
    setScheduler(schedulerData.row);
  }, []);

  const loadRows = useCallback(async () => {
    const requestSeq = rowLoadSeqRef.current + 1;
    rowLoadSeqRef.current = requestSeq;
    const data = await fetchMatcherDecisions({
      decision: decisionFilter,
      limit: 300,
    });
    if (rowLoadSeqRef.current !== requestSeq) return;
    setRows(data.rows);
    setRowTotal(data.total);
    setRowDecisionCounts(data.decisionCounts);
  }, [decisionFilter]);

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    const requestSeq = refreshSeqRef.current + 1;
    refreshSeqRef.current = requestSeq;
    if (!opts?.silent) setRefreshing(true);
    try {
      await Promise.all([loadStats(), loadRows()]);
    } catch (err) {
      if (refreshSeqRef.current === requestSeq && !opts?.silent) {
        toast.error("Failed to load matcher lab", {
          description: (err as Error).message,
        });
      }
    } finally {
      if (refreshSeqRef.current === requestSeq) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [loadRows, loadStats]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (running) return;
    let cancelled = false;
    let timer: number | null = null;

    const schedule = () => {
      if (cancelled || timer) return;
      timer = window.setTimeout(() => void tick(), MATCHER_LAB_AUTO_REFRESH_MS);
    };

    const tick = async () => {
      timer = null;
      if (cancelled) return;
      if (document.hidden) return;
      await refresh({ silent: true });
      schedule();
    };

    const handleVisibilityChange = () => {
      if (cancelled) return;
      if (document.hidden) {
        if (timer) {
          window.clearTimeout(timer);
          timer = null;
        }
        return;
      }
      void tick();
    };

    schedule();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refresh, running]);

  const loadCompletedJobResults = useCallback(
    async (job: MatcherRunJob) => {
      const summary = job.summary;
      if (!summary || summary.status !== "completed") return;
      await refresh();
      const data = await fetchMatcherDecisions({
        runId: summary.id,
        decision: "all",
        limit: 500,
      });
      setResultRows(data.rows);
      setResultDecisions(
        Object.fromEntries(
          data.rows.map((row) => {
            const value: MatcherManualDecision =
              row.decision === "auto_merge" || row.decision === "auto_reject"
                ? row.decision
                : "human_review";
            return [row.decisionId, value];
          }),
        ),
      );
    },
    [refresh],
  );

  const applyRunJobState = useCallback(
    async (job: MatcherRunJob, notify: boolean) => {
      setCurrentRunJob(job);
      setRunEvents(job.events);
      setRunning(job.status === "queued" || job.status === "running");

      if (job.status === "queued" || job.status === "running") {
        return;
      }

      window.localStorage.removeItem(ACTIVE_MATCHER_JOB_KEY);
      setActiveJobId(null);

      if (job.status === "completed") {
        setRowSelection({});
        await loadCompletedJobResults(job);
        if (notify && job.summary) {
          toast.success("Matcher run complete", {
            description: `${job.summary.candidateCount} pairs scored, ${job.summary.autoMerged} merged, ${job.summary.autoRejected} rejected`,
          });
        }
        return;
      }

      if (notify) {
        toast.error("Matcher run failed", {
          description: job.errorMessage ?? "Matcher job failed",
        });
      }
    },
    [loadCompletedJobResults],
  );

  useEffect(() => {
    let cancelled = false;
    const storedJobId = window.localStorage.getItem(ACTIVE_MATCHER_JOB_KEY);

    async function recoverJob() {
      try {
        if (storedJobId) {
          setActiveJobId(storedJobId);
          return;
        }
        const { job } = await fetchLatestMatcherRunJob({ activeOnly: true });
        if (!cancelled && job) {
          setCurrentRunJob(job);
          window.localStorage.setItem(ACTIVE_MATCHER_JOB_KEY, job.id);
          setActiveJobId(job.id);
        }
      } catch (err) {
        toast.error("Failed to recover matcher job", {
          description: (err as Error).message,
        });
      }
    }

    void recoverJob();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!activeJobId) return;
    let cancelled = false;

    async function pollJob() {
      try {
        const { job } = await fetchMatcherRunJob(activeJobId!);
        if (cancelled || !job) return;
        await applyRunJobState(job, true);
      } catch (err) {
        if (!cancelled) {
          toast.error("Failed to poll matcher job", {
            description: (err as Error).message,
          });
        }
      }
    }

    void pollJob();
    const interval = window.setInterval(() => void pollJob(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeJobId, applyRunJobState]);

  const selectedDecisionIds = useMemo(
    () =>
      Object.entries(rowSelection)
        .filter(([, selected]) => selected)
        .map(([id]) => id),
    [rowSelection],
  );
  const selectedRows = useMemo(() => {
    const selected = new Set(selectedDecisionIds);
    return rows.filter((row) => selected.has(row.decisionId));
  }, [rows, selectedDecisionIds]);
  const allDecisionCount = useMemo(
    () => rowDecisionCounts.reduce((sum, item) => sum + item.count, 0),
    [rowDecisionCounts],
  );

  const runSelected = async () => {
    if (selectedDecisionIds.length === 0) {
      toast.error("Select matcher rows first");
      return;
    }
    setRunning(true);
    setRunEvents([]);
    setResultRows([]);
    setResultDecisions({});
    setRunMonitorOpen(true);
    try {
      const { job } = await startMatcherRunJob({
        mode: "apply",
        decisionIds: selectedDecisionIds,
        useDeepSeek: scheduler?.useDeepSeek ?? true,
      });
      if (!job) throw new Error("Matcher job was not created");
      window.localStorage.setItem(ACTIVE_MATCHER_JOB_KEY, job.id);
      setCurrentRunJob(job);
      setActiveJobId(job.id);
      setRunEvents(job.events);
      toast.success("Matcher run queued", {
        description: "Progress is now tracked server-side.",
      });
    } catch (err) {
      toast.error("Matcher run failed", {
        description: (err as Error).message,
      });
      setCurrentRunJob(null);
      setRunning(false);
    }
  };

  const saveResultDecisions = async () => {
    setSavingResults(true);
    try {
      await sendManualMatcherDecisions({
        items: resultRows.map((row) => ({
          decisionId: row.decisionId,
          decision: resultDecisions[row.decisionId] ?? "human_review",
          reason: `Operator saved this selected result as ${
            MANUAL_DECISION_LABELS[
              resultDecisions[row.decisionId] ?? "human_review"
            ]
          }.`,
        })),
      });
      toast.success("Matcher outcomes applied");
      setRunMonitorOpen(false);
      setCurrentRunJob(null);
      setResultRows([]);
      setResultDecisions({});
      setRowSelection({});
      await refresh();
    } catch (err) {
      toast.error("Failed to save matcher results", {
        description: (err as Error).message,
      });
    } finally {
      setSavingResults(false);
    }
  };

  const columns = useMemo(
    () =>
      buildColumns({
        rowSelection,
        rowCount: rows.length,
        onToggleRow: (id) =>
          setRowSelection((prev) => ({ ...prev, [id]: !prev[id] })),
        onToggleAllVisible: (checked) =>
          setRowSelection((prev) => {
            const next = { ...prev };
            for (const row of rows) {
              if (checked) next[row.decisionId] = true;
              else delete next[row.decisionId];
            }
            return next;
          }),
      }),
    [rowSelection, rows],
  );

  const titleBadge = <MatcherLabHeader stats={stats} scheduler={scheduler} />;

  return (
    <TooltipProvider delayDuration={200}>
      <AppShell
        title="Matcher Lab"
        titleBadge={titleBadge}
        edgeToEdge
        actions={
          <div className="flex items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  onClick={() => void refresh()}
                  disabled={refreshing || running}
                >
                  <RefreshCw
                    className={cn("size-3.5", refreshing && "animate-spin")}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh matcher lab data</TooltipContent>
            </Tooltip>
            <RunStatusButton
              job={currentRunJob}
              running={running}
              eventCount={runEvents.length}
              resultCount={resultRows.length}
              onOpen={() => setRunMonitorOpen(true)}
            />
            <SchedulerPopover
              scheduler={scheduler}
              setScheduler={setScheduler}
            />
          </div>
        }
      >
        <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 border-b border-border/70 bg-background/95">
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
                  {DECISION_FILTERS.map((tab) => {
                    const active = decisionFilter === tab.value;
                    const palette = DECISION_TAB_COLORS[tab.value];
                    const count =
                      tab.value === "all"
                        ? allDecisionCount
                        : rowDecisionCounts.find(
                            (item) => item.decision === tab.value,
                          )?.count;
                    return (
                      <button
                        key={tab.value}
                        type="button"
                        onClick={() => setDecisionFilter(tab.value)}
                        className={cn(
                          "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition-colors active:scale-[0.98]",
                          active
                            ? palette.active
                            : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                        )}
                      >
                        {active && (
                          <span
                            className={cn(
                              "inline-block size-1.5 rounded-full",
                              palette.dot,
                            )}
                          />
                        )}
                        <span>{tab.label}</span>
                        {typeof count === "number" && (
                          <span className="tabular-nums text-current/70">
                            {count}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="tabular-nums">{rows.length} loaded</span>
                  {rowTotal > rows.length && (
                    <span className="tabular-nums text-muted-foreground/70">
                      / {rowTotal} total
                    </span>
                  )}
                </div>
              </div>

              {selectedDecisionIds.length > 0 && (
                <div className="flex items-center justify-between gap-2 border-t border-border/50 bg-amber-500/[0.07] px-3 py-2">
                  <div className="text-xs text-muted-foreground">
                    <span className="font-medium tabular-nums text-foreground">
                      {selectedDecisionIds.length}
                    </span>{" "}
                    selected for matching
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7"
                          onClick={() => setRowSelection({})}
                          disabled={running}
                        >
                          Clear
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        Clear selected matcher rows
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          size="sm"
                          className="h-7"
                          onClick={runSelected}
                          disabled={running || selectedRows.length === 0}
                        >
                          {running ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Play className="size-3.5" />
                          )}
                          Run selected
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        Score selected rows and review the output before
                        applying outcomes
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              )}
            </div>

            <DataTable<MatcherDecisionRow>
              data={rows}
              columns={columns}
              getRowId={(row) => row.decisionId}
              enableRowSelection
              rowSelection={rowSelection}
              onRowSelectionChange={setRowSelection}
              enableSorting
              enableVirtualization
              enableColumnResizing
              enableColumnOrdering
              rowHeight={38}
              density="compact"
              persistenceKey="matcher-lab-event-decisions"
              loading={loading}
              className="h-full w-full"
              onRowClick={setDetailRow}
              rowClassName={(row) => {
                if (row.decision === "human_review")
                  return "bg-amber-900/[0.05]";
                if (row.decision === "auto_merge")
                  return "bg-emerald-900/[0.04]";
                if (row.decision === "auto_reject") return "bg-red-900/[0.04]";
                return undefined;
              }}
              renderEmpty={() => (
                <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
                  <Database className="size-5" />
                  <p className="text-sm">No matcher decisions found.</p>
                </div>
              )}
              renderLoading={() => (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="size-3.5 animate-spin" />
                  Loading matcher decisions...
                </span>
              )}
            />
          </div>
        </div>
      </AppShell>

      <DetailDialog
        row={detailRow}
        open={detailRow !== null}
        onOpenChange={(open) => !open && setDetailRow(null)}
      />
      <RunProgressModal
        open={runMonitorOpen}
        onOpenChange={setRunMonitorOpen}
        events={runEvents}
        running={running}
        rows={resultRows}
        decisions={resultDecisions}
        saving={savingResults}
        onDecisionChange={(decisionId, decision) =>
          setResultDecisions((prev) => ({ ...prev, [decisionId]: decision }))
        }
        onCommit={saveResultDecisions}
      />
    </TooltipProvider>
  );
}

function buildColumns({
  rowSelection,
  rowCount,
  onToggleRow,
  onToggleAllVisible,
}: {
  rowSelection: RowSelectionState;
  rowCount: number;
  onToggleRow: (decisionId: string) => void;
  onToggleAllVisible: (checked: boolean) => void;
}): ColumnDef<MatcherDecisionRow, unknown>[] {
  const selectedCount = Object.values(rowSelection).filter(Boolean).length;
  const allSelected = rowCount > 0 && selectedCount >= rowCount;
  return [
    {
      id: "select",
      header: () => (
        <Checkbox
          checked={
            allSelected ? true : selectedCount > 0 ? "indeterminate" : false
          }
          onCheckedChange={(checked) => onToggleAllVisible(checked === true)}
          aria-label="Select all loaded matcher decisions"
          className="size-3.5"
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          checked={Boolean(rowSelection[row.original.decisionId])}
          onCheckedChange={() => onToggleRow(row.original.decisionId)}
          onClick={(event) => event.stopPropagation()}
          aria-label={`Select ${row.original.decisionId}`}
          className="size-3.5"
        />
      ),
      size: 34,
      meta: { fixed: "left", hint: "Select matcher rows.", initialSize: 34 },
    },
    {
      id: "createdAt",
      header: "Time",
      size: 112,
      accessorFn: (row) => row.createdAt,
      meta: {
        hint: "When this decision was written.",
        align: "center",
        initialSize: 104,
      },
      cell: ({ row }) => (
        <span className="text-[10px] text-muted-foreground">
          {fmtSeen(row.original.createdAt)}
        </span>
      ),
    },
    {
      id: "eventA",
      header: "Event A",
      size: 250,
      meta: { hint: "First provider event snapshot.", initialSize: 260 },
      cell: ({ row }) => <EventBlock row={row.original} side="A" />,
    },
    {
      id: "eventB",
      header: "Event B",
      size: 250,
      meta: { hint: "Second provider event snapshot.", initialSize: 260 },
      cell: ({ row }) => <EventBlock row={row.original} side="B" />,
    },
    {
      id: "ko",
      header: "KO",
      size: 96,
      accessorFn: (row) => row.eventA.kickoff,
      meta: {
        hint: "Kickoff from the first snapshot.",
        align: "center",
        initialSize: 92,
      },
      cell: ({ row }) => (
        <span className="tabular-nums text-muted-foreground">
          {fmtShort(row.original.eventA.kickoff)}
        </span>
      ),
    },
    {
      id: "confidence",
      header: "Conf",
      size: 70,
      accessorFn: (row) => row.confidence,
      meta: { hint: "Policy confidence.", align: "right", initialSize: 68 },
      cell: ({ row }) => (
        <span className="tabular-nums text-foreground">
          {fmtPercent(row.original.confidence)}
        </span>
      ),
    },
    {
      id: "combined",
      header: "Score",
      size: 70,
      accessorFn: (row) => row.scoreBreakdown?.combined,
      meta: {
        hint: "Weighted matcher score.",
        align: "right",
        initialSize: 68,
      },
      cell: ({ row }) => (
        <span className="tabular-nums text-muted-foreground">
          {fmtPercent(row.original.scoreBreakdown?.combined)}
        </span>
      ),
    },
    {
      id: "groundedDecision",
      header: "Grounded",
      size: 112,
      accessorFn: (row) => inferGroundedDecision(row) ?? "",
      meta: {
        hint: "Grounded review verdict, separate from final policy action.",
        align: "center",
        initialSize: 112,
      },
      cell: ({ row }) => <GroundedDecisionBadge row={row.original} />,
    },
    {
      id: "stage",
      header: "Stage",
      size: 112,
      accessorFn: (row) => row.decisionStage,
      meta: {
        hint: "Matcher stage that produced the current decision.",
        align: "center",
        initialSize: 112,
      },
      cell: ({ row }) => (
        <span className="capitalize text-muted-foreground">
          {row.original.decisionStage.replaceAll("_", " ")}
        </span>
      ),
    },
    {
      id: "reason",
      header: "Reason",
      size: 260,
      accessorFn: (row) => row.reasonSummary,
      meta: {
        hint: "Policy reason. Open the row for full scoring details.",
        initialSize: 280,
      },
      cell: ({ row }) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="max-w-[280px] cursor-default truncate text-muted-foreground">
              <span className="font-mono text-[10px] text-foreground/70">
                {row.original.reasonCode}
              </span>
              <span className="mx-1 text-muted-foreground/50">·</span>
              <span>{row.original.reasonSummary}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-[360px]">
            {row.original.reasonSummary}
          </TooltipContent>
        </Tooltip>
      ),
    },
    {
      id: "decision",
      header: "Decision",
      size: 104,
      accessorFn: (row) => row.decision,
      meta: {
        hint: "Current matcher decision.",
        align: "center",
        initialSize: 104,
      },
      cell: ({ row }) => <DecisionBadge decision={row.original.decision} />,
    },
    {
      id: "actions",
      header: "",
      size: 48,
      meta: {
        fixed: "right",
        hint: "Open manual Google AI Mode verification.",
        align: "right",
        initialSize: 48,
      },
      cell: ({ row }) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-6"
              aria-label="Open Google AI Mode verification"
              onClick={(event) => {
                event.stopPropagation();
                openGoogleAiMode(row.original);
              }}
            >
              <Search className="size-3.5 text-amber-400" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open manual Google AI Mode verification</TooltipContent>
        </Tooltip>
      ),
    },
  ];
}
