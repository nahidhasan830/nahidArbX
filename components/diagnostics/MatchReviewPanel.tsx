"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  XCircle,
  Trash2,
  ExternalLink,
  Sparkles,
  Crown,
  RefreshCw,
  Loader2,
  Search,
  AlertCircle,
  Activity,
  Info,
  Pause,
  Play,
  Square,
  SlidersHorizontal,
  Zap,
  Gavel,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { getProviderDisplayName } from "@/lib/providers/registry";
import { MODEL_LABELS, type ModelTier } from "@/lib/ai/models";
import {
  eventLabel,
  pairLabel,
  pairLabelSides,
} from "@/lib/formatting/event-label";

type DecidedBy = "gemini" | "human" | "matcher";
type VerdictType = "SAME" | "DIFFERENT" | "UNCERTAIN";
type BucketId = "to-review" | "auto-merged" | "decided";
type DeciderFilter = "all" | "ai" | "human";
type ToReviewFilter = "all" | "fresh" | "ai-unsure";
type VerdictFilter = "all" | "approved" | "rejected" | "uncertain";

interface EventSide {
  provider: string;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  startTime: string;
}

interface CachedDecision {
  key: string;
  verdict: VerdictType;
  confidence: number;
  sources: { url: string; title: string }[];
  decidedBy: DecidedBy;
  decidedAt: string;
  model?: string;
  by?: string;
  snapshot?: {
    eventA: { homeTeam: string; awayTeam: string };
    eventB: { homeTeam: string; awayTeam: string };
  };
}

interface ReviewItem {
  key: string;
  source: "near-match" | "matched-event" | "unmatched-candidate" | "decided";
  nearMatchId?: string;
  matchedEventId?: string;
  eventAId?: string;
  eventBId?: string;
  score: number;
  bucketKey?: string;
  autoSuggested?: boolean;
  eventA: EventSide;
  eventB: EventSide;
  googleSearchUrl: string;
  cachedDecision?: CachedDecision;
}

interface ListResponse {
  toReview: ReviewItem[];
  decided: ReviewItem[];
  autoMergedCount: number;
  stats: {
    total: number;
    byDecider: Record<"gemini" | "human" | "matcher", number>;
    byVerdict: Record<VerdictType, number>;
    humanApproved: number;
    humanRejected: number;
  };
}

interface AutoMergedResponse {
  autoMerged: ReviewItem[];
}

type LogIcon =
  | "merged"
  | "rejected"
  | "uncertain"
  | "cached"
  | "error"
  | "info"
  | "done";

interface VerdictMeta {
  verdict: "SAME" | "DIFFERENT" | "UNCERTAIN";
  confidence: number;
  modelTier?: ModelTier;
  cached?: boolean;
  sideA?: string;
  sideB?: string;
}

interface LogEntry {
  id: number;
  tone: "info" | "success" | "warning" | "error";
  icon: LogIcon;
  title: string;
  subtitle?: string;
  verdict?: VerdictMeta;
  time: string;
}

type LogDraft = Omit<LogEntry, "id" | "time">;

interface BulkStatusPayload {
  active: boolean;
  aborted: boolean;
  paused: boolean;
  sessionId: string;
  model: string | null;
  total: number;
  done: number;
  analyzed: number;
  cached: number;
  errored: number;
  startedAt: number;
  endedAt: number;
}

function formatTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ============================================
// Activity-log row
// ============================================

const LOG_ICON_COMPONENTS = {
  merged: CheckCircle2,
  rejected: XCircle,
  uncertain: AlertCircle,
  cached: Info,
  error: AlertCircle,
  info: Info,
  done: Activity,
} as const;

const LOG_ICON_COLORS: Record<LogIcon, string> = {
  merged: "text-emerald-400",
  rejected: "text-red-400",
  uncertain: "text-amber-400",
  cached: "text-zinc-500",
  error: "text-red-400",
  info: "text-zinc-500",
  done: "text-blue-400",
};

const LOG_TITLE_COLORS: Record<LogEntry["tone"], string> = {
  success: "text-zinc-100",
  warning: "text-amber-200",
  error: "text-red-200",
  info: "text-zinc-300",
};

type TickerFilter = "all" | "merged" | "different" | "uncertain" | "error";

const FILTER_LABEL: Record<TickerFilter, string> = {
  all: "All",
  merged: "Merged",
  different: "Different",
  uncertain: "Uncertain",
  error: "Errors",
};

function entryCategory(entry: LogEntry): Exclude<TickerFilter, "all"> | null {
  if (entry.icon === "merged") return "merged";
  if (entry.icon === "rejected") return "different";
  if (entry.icon === "uncertain") return "uncertain";
  if (entry.icon === "error" || entry.tone === "error") return "error";
  return null;
}

const RAIL_COLOR: Record<Exclude<TickerFilter, "all">, string> = {
  merged: "bg-emerald-500",
  different: "bg-red-500",
  uncertain: "bg-amber-500",
  error: "bg-red-600",
};

const VERDICT_STYLE: Record<
  VerdictMeta["verdict"],
  { label: string; className: string }
> = {
  SAME: {
    label: "Merged",
    className: "bg-emerald-500/15 text-emerald-200 border-emerald-500/30",
  },
  DIFFERENT: {
    label: "Different",
    className: "bg-red-500/15 text-red-200 border-red-500/30",
  },
  UNCERTAIN: {
    label: "Uncertain",
    className: "bg-amber-500/15 text-amber-200 border-amber-500/30",
  },
};

const MODEL_BADGE_STYLE: Record<ModelTier, string> = {
  lite: "bg-zinc-700/60 text-zinc-300 border-zinc-600/60",
  flash: "bg-purple-500/15 text-purple-300 border-purple-500/30",
  pro: "bg-blue-500/15 text-blue-300 border-blue-500/30",
};

function VerdictPill({ verdict }: { verdict: VerdictMeta["verdict"] }) {
  const s = VERDICT_STYLE[verdict];
  return (
    <span
      className={cn(
        "px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider border leading-none",
        s.className,
      )}
    >
      {s.label}
    </span>
  );
}

function ConfidencePill({ confidence }: { confidence: number }) {
  const tone =
    confidence >= 90
      ? "text-zinc-100"
      : confidence >= 70
        ? "text-zinc-300"
        : "text-zinc-400";
  return (
    <span className={cn("text-[11px] font-semibold tabular-nums", tone)}>
      {confidence}%
    </span>
  );
}

function ModelPill({ tier }: { tier: ModelTier }) {
  return (
    <span
      className={cn(
        "px-1.5 py-0.5 rounded text-[10px] font-medium border leading-none",
        MODEL_BADGE_STYLE[tier],
      )}
    >
      {MODEL_LABELS[tier].label}
    </span>
  );
}

function CachedPill() {
  return (
    <span className="px-1 py-0.5 rounded text-[9px] font-medium bg-zinc-800 text-zinc-500 uppercase tracking-wider leading-none">
      cached
    </span>
  );
}

function TickerRow({
  entry,
  category,
}: {
  entry: LogEntry;
  category: Exclude<TickerFilter, "all"> | null;
}) {
  const Icon = LOG_ICON_COMPONENTS[entry.icon];
  const v = entry.verdict;

  const rowBody =
    v != null ? (
      <div className="flex-1 min-w-0 flex items-center gap-2 px-2.5 py-1">
        <Icon
          className={cn("w-3.5 h-3.5 shrink-0", LOG_ICON_COLORS[entry.icon])}
        />
        <VerdictPill verdict={v.verdict} />
        <ConfidencePill confidence={v.confidence} />
        {v.modelTier && <ModelPill tier={v.modelTier} />}
        {v.cached && <CachedPill />}
        <div className="min-w-0 flex-1 text-[11px] text-zinc-200 truncate ml-1">
          {v.sideA && v.sideB ? `${v.sideA} ↔ ${v.sideB}` : (v.sideA ?? "")}
        </div>
        <span className="text-[10px] text-zinc-600 tabular-nums shrink-0">
          {entry.time}
        </span>
      </div>
    ) : (
      <div className="flex-1 min-w-0 flex items-start gap-2 px-2.5 py-1">
        <Icon
          className={cn(
            "w-3.5 h-3.5 mt-0.5 shrink-0",
            LOG_ICON_COLORS[entry.icon],
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                "font-medium leading-snug min-w-0 truncate",
                LOG_TITLE_COLORS[entry.tone],
              )}
            >
              {entry.title}
            </span>
            <span className="text-[10px] text-zinc-600 tabular-nums ml-auto shrink-0">
              {entry.time}
            </span>
          </div>
          {entry.subtitle && (
            <div className="text-[10px] text-zinc-500 mt-0.5 break-words leading-snug">
              {entry.subtitle}
            </div>
          )}
        </div>
      </div>
    );

  return (
    <div
      className={cn(
        "group flex items-stretch text-[11px] hover:bg-zinc-800/40 transition-colors",
      )}
    >
      <div
        className={cn(
          "w-0.5 shrink-0",
          category ? RAIL_COLOR[category] : "bg-zinc-700",
        )}
        aria-hidden
      />
      {rowBody}
    </div>
  );
}

interface ActivityDrawerProps {
  log: LogEntry[];
  logOpen: boolean;
  setLogOpen: (fn: (v: boolean) => boolean) => void;
  setLog: (log: LogEntry[]) => void;
  logScrollRef: React.RefObject<HTMLDivElement | null>;
  isBulkBusy: boolean;
  isBulkPaused: boolean;
  controlBusy: "pause" | "resume" | "abort" | null;
  bulkProgress: { done: number; total: number } | null;
  onControl: (action: "pause" | "resume" | "abort") => void;
}

function ActivityDrawer({
  log,
  logOpen,
  setLogOpen,
  setLog,
  logScrollRef,
  isBulkBusy,
  isBulkPaused,
  controlBusy,
  bulkProgress,
  onControl,
}: ActivityDrawerProps) {
  const [filter, setFilter] = useState<TickerFilter>("all");
  const [search, setSearch] = useState("");
  const [scrollPinned, setScrollPinned] = useState(true);

  const tally = useMemo(() => {
    const t = { merged: 0, different: 0, uncertain: 0, error: 0 } as Record<
      Exclude<TickerFilter, "all">,
      number
    >;
    for (const e of log) {
      const c = entryCategory(e);
      if (c) t[c]++;
    }
    return t;
  }, [log]);

  const needle = search.trim().toLowerCase();
  const visible = useMemo(() => {
    return log.filter((e) => {
      if (filter !== "all" && entryCategory(e) !== filter) return false;
      if (needle) {
        const hay = `${e.title} ${e.subtitle ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [log, filter, needle]);

  const feedRef = useRef<HTMLDivElement | null>(null);
  const onFeedScroll = useCallback(() => {
    const el = feedRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    setScrollPinned(atBottom);
  }, []);
  useEffect(() => {
    if (!scrollPinned) return;
    const el = feedRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    if (logScrollRef && "current" in logScrollRef) {
      logScrollRef.current = el;
    }
  }, [visible, scrollPinned, logScrollRef]);

  const percent = bulkProgress
    ? Math.min(
        100,
        Math.round((bulkProgress.done / Math.max(1, bulkProgress.total)) * 100),
      )
    : 0;

  const filterChip = (id: TickerFilter, count: number) => {
    const active = filter === id;
    const tone: Record<TickerFilter, string> = {
      all: active ? "bg-zinc-700 text-zinc-100" : "text-zinc-400",
      merged: active
        ? "bg-emerald-500/20 text-emerald-200 border-emerald-500/40"
        : "text-emerald-300/70",
      different: active
        ? "bg-red-500/20 text-red-200 border-red-500/40"
        : "text-red-300/70",
      uncertain: active
        ? "bg-amber-500/20 text-amber-200 border-amber-500/40"
        : "text-amber-300/70",
      error: active
        ? "bg-red-600/30 text-red-200 border-red-600/50"
        : tally.error > 0
          ? "text-red-300 animate-pulse"
          : "text-red-300/40",
    };
    return (
      <button
        key={id}
        onClick={() => setFilter(id)}
        disabled={id !== "all" && count === 0}
        className={cn(
          "h-6 px-2 text-[11px] rounded border border-transparent transition-colors tabular-nums disabled:opacity-30 disabled:cursor-not-allowed",
          tone[id],
          !active && "hover:text-zinc-100",
        )}
      >
        {FILTER_LABEL[id]}{" "}
        <span className="opacity-70">{id === "all" ? log.length : count}</span>
      </button>
    );
  };

  if (!logOpen) {
    return (
      <div className="px-3 pb-2 shrink-0">
        <button
          onClick={() => setLogOpen((v) => !v)}
          className={cn(
            "w-full h-9 flex items-center gap-2 px-3 rounded-lg border shadow-lg text-left transition-colors",
            "bg-zinc-900 border-zinc-700 hover:border-zinc-600 hover:bg-zinc-850",
          )}
          title="Open the activity panel"
        >
          {isBulkBusy && !isBulkPaused ? (
            <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin shrink-0" />
          ) : (
            <Activity
              className={cn(
                "w-3.5 h-3.5 shrink-0",
                isBulkPaused ? "text-amber-400" : "text-zinc-400",
              )}
            />
          )}
          {bulkProgress ? (
            <span className="text-[11px] text-zinc-200 tabular-nums shrink-0">
              {bulkProgress.done}/{bulkProgress.total} · {percent}%
            </span>
          ) : (
            <span className="text-[11px] text-zinc-300 shrink-0">Activity</span>
          )}
          <span className="text-[10px] text-zinc-600">·</span>
          <span className="text-[11px] text-zinc-400 truncate flex-1">
            {log[log.length - 1]?.title ?? "Waiting for events…"}
          </span>
          {tally.error > 0 && (
            <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-500/20 text-red-200 border border-red-500/40 tabular-nums shrink-0">
              {tally.error} {tally.error === 1 ? "error" : "errors"}
            </span>
          )}
          <ChevronUp className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
        </button>
      </div>
    );
  }

  return (
    <div className="px-3 pb-3 shrink-0">
      <div className="flex flex-col h-[34vh] rounded-lg border border-zinc-700/80 bg-zinc-950 shadow-[0_-8px_24px_-8px_rgba(0,0,0,0.6),0_0_0_1px_rgba(255,255,255,0.04)] overflow-hidden">
        <div className="h-[2px] bg-gradient-to-r from-transparent via-blue-500/60 to-transparent shrink-0" />

        <div className="relative bg-zinc-900/90 border-b border-zinc-800 shrink-0">
          {bulkProgress && (
            <div
              className="absolute inset-y-0 left-0 bg-blue-500/10 transition-all duration-300 pointer-events-none"
              style={{ width: `${percent}%` }}
              aria-hidden
            />
          )}
          <div className="relative flex items-center gap-2 px-3 h-9">
            {isBulkBusy && !isBulkPaused ? (
              <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin shrink-0" />
            ) : (
              <Activity
                className={cn(
                  "w-3.5 h-3.5 shrink-0",
                  isBulkPaused ? "text-amber-400" : "text-zinc-400",
                )}
              />
            )}
            {bulkProgress ? (
              <span className="text-[11px] text-zinc-200 tabular-nums shrink-0">
                {bulkProgress.done}/{bulkProgress.total}
                <span className="text-zinc-500"> · {percent}%</span>
              </span>
            ) : (
              <span className="text-[11px] text-zinc-300 font-medium shrink-0">
                Activity
              </span>
            )}
            <div className="mx-1 h-5 w-px bg-zinc-800 shrink-0" />
            <div className="flex items-center gap-1 flex-wrap min-w-0">
              {filterChip("all", log.length)}
              {filterChip("merged", tally.merged)}
              {filterChip("different", tally.different)}
              {filterChip("uncertain", tally.uncertain)}
              {filterChip("error", tally.error)}
            </div>
            <div className="ml-auto flex items-center gap-1 shrink-0">
              {isBulkBusy && (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={controlBusy !== null}
                        onClick={() =>
                          onControl(isBulkPaused ? "resume" : "pause")
                        }
                        className={cn(
                          "h-7 w-7 p-0",
                          isBulkPaused ? "text-amber-300" : "text-zinc-300",
                        )}
                      >
                        {controlBusy === "pause" || controlBusy === "resume" ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : isBulkPaused ? (
                          <Play className="w-3.5 h-3.5" />
                        ) : (
                          <Pause className="w-3.5 h-3.5" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {isBulkPaused
                        ? "Resume the paused bulk run"
                        : "Pause — in-flight items finish, new items wait"}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={controlBusy !== null}
                        onClick={() => onControl("abort")}
                        className="h-7 w-7 p-0 text-red-300 hover:text-red-200"
                      >
                        {controlBusy === "abort" ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Square className="w-3.5 h-3.5" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Abort the bulk run</TooltipContent>
                  </Tooltip>
                </>
              )}
              {!isBulkBusy && log.length > 0 && (
                <button
                  onClick={() => setLog([])}
                  className="h-7 px-2 text-[11px] text-zinc-500 hover:text-zinc-300 rounded transition-colors"
                >
                  Clear
                </button>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setLogOpen((v) => !v)}
                    className="h-7 w-7 p-0 inline-flex items-center justify-center text-zinc-500 hover:text-zinc-300 rounded"
                    aria-label="Collapse"
                  >
                    <ChevronDown className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Collapse activity panel</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>

        <div
          ref={feedRef}
          onScroll={onFeedScroll}
          className="flex-1 min-h-0 overflow-auto divide-y divide-zinc-800/40 bg-zinc-950 pb-1.5"
        >
          {log.length === 0 ? (
            <div className="text-zinc-600 italic text-[11px] px-3 py-3">
              Waiting for events. Start a bulk run to watch verdicts stream in.
            </div>
          ) : visible.length === 0 ? (
            <div className="text-zinc-600 italic text-[11px] px-3 py-3">
              {needle
                ? `No matches for "${needle}".`
                : `No ${FILTER_LABEL[filter].toLowerCase()} yet.`}
            </div>
          ) : (
            visible.map((entry) => (
              <TickerRow
                key={entry.id}
                entry={entry}
                category={entryCategory(entry)}
              />
            ))
          )}
        </div>

        <div className="flex items-center gap-2 px-2 py-1.5 border-t border-zinc-800 bg-zinc-900/60 shrink-0">
          <div className="relative flex-1 min-w-0">
            <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-zinc-600" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter activity…"
              className="h-6 pl-6 text-[11px] border-zinc-800 bg-zinc-950"
            />
          </div>
          <span className="text-[10px] text-zinc-600 tabular-nums shrink-0">
            {visible.length} / {log.length}
          </span>
          {!scrollPinned && (
            <button
              onClick={() => {
                const el = feedRef.current;
                if (el) el.scrollTop = el.scrollHeight;
                setScrollPinned(true);
              }}
              className="h-6 px-2 text-[10px] rounded bg-blue-500/10 border border-blue-500/30 text-blue-300 hover:bg-blue-500/20 transition-colors shrink-0"
            >
              ↓ latest
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function DecisionBadge({ decision }: { decision: CachedDecision }) {
  const isHuman = decision.decidedBy === "human";
  const isMatcher = decision.decidedBy === "matcher";
  const deciderLabel = isHuman
    ? "Human"
    : decision.decidedBy === "gemini"
      ? "AI"
      : "Matcher";

  if (isMatcher) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border bg-sky-500/15 text-sky-300 border-sky-500/30">
        Matcher · SAME · {decision.confidence}%
      </span>
    );
  }

  if (isHuman) {
    const approved = decision.verdict === "SAME";
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border",
          approved
            ? "bg-emerald-600/20 text-emerald-300 border-emerald-600/40"
            : "bg-red-600/20 text-red-300 border-red-600/40",
        )}
      >
        {approved ? (
          <CheckCircle2 className="w-3 h-3" />
        ) : (
          <XCircle className="w-3 h-3" />
        )}
        {approved ? "Approved" : "Rejected"}
      </span>
    );
  }

  const colorMap = {
    SAME: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    DIFFERENT: "bg-red-500/15 text-red-400 border-red-500/30",
    UNCERTAIN: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border",
        colorMap[decision.verdict],
      )}
    >
      {deciderLabel} · {decision.verdict} · {decision.confidence}%
    </span>
  );
}

function ProviderLabel({ provider }: { provider: string }) {
  const base = "text-[10px] h-4 leading-4";
  if (provider === "unknown") {
    return (
      <div
        className={cn(base, "italic tracking-wide text-zinc-600 font-normal")}
      >
        archived
      </div>
    );
  }
  return (
    <div
      className={cn(base, "uppercase tracking-wider text-zinc-500 font-medium")}
    >
      {provider}
    </div>
  );
}

// ============================================
// AI Verify dropdown — demoted to a single subtle button.
// Mirrors the "Settle with…" dropdown in AiSettleDialog so the UX feels
// consistent and AI is opt-in rather than the default action.
// ============================================

type VerifyChoice = { kind: "ai"; model: ModelTier };

const VERIFY_OPTIONS: {
  choice: VerifyChoice;
  label: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
}[] = [
  {
    choice: { kind: "ai", model: "lite" },
    label: "Lite",
    hint: "Cheapest — default model. Try this first.",
    icon: Zap,
    accent: "text-blue-400",
  },
  {
    choice: { kind: "ai", model: "flash" },
    label: "Flash",
    hint: "Balanced — if Lite looks shaky.",
    icon: Sparkles,
    accent: "text-violet-400",
  },
  {
    choice: { kind: "ai", model: "pro" },
    label: "Pro",
    hint: "Deep reasoning — most expensive. Stuck rows only.",
    icon: Crown,
    accent: "text-amber-400",
  },
];

interface AiVerifyButtonProps {
  running?: boolean;
  disabled?: boolean;
  /** Tooltip body — explains what "verify" does in the current row context. */
  tooltip?: string;
  /** Triggered when the user picks a model. Parent owns the actual fetch. */
  onChoose: (choice: VerifyChoice) => void;
  /** When true, renders as a wider "bulk" button with a label. */
  bulkLabel?: string;
}

function AiVerifyButton({
  running,
  disabled,
  tooltip,
  onChoose,
  bulkLabel,
}: AiVerifyButtonProps) {
  const trigger = bulkLabel ? (
    <Button
      size="sm"
      variant="outline"
      className="h-7 px-2.5 text-[11px] gap-1.5 text-zinc-300 border-zinc-700 hover:border-zinc-600"
      disabled={running || disabled}
    >
      {running ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : (
        <Gavel className="w-3.5 h-3.5" />
      )}
      {bulkLabel}
      <ChevronDown className="w-3 h-3 opacity-60" />
    </Button>
  ) : (
    <Button
      size="icon"
      variant="ghost"
      className="size-7 text-muted-foreground hover:text-foreground"
      disabled={running || disabled}
    >
      {running ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <Gavel className="size-3.5" />
      )}
    </Button>
  );

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        </TooltipTrigger>
        {tooltip && (
          <TooltipContent
            side="top"
            className="max-w-xs text-sm leading-snug whitespace-normal"
          >
            {tooltip}
          </TooltipContent>
        )}
      </Tooltip>
      <DropdownMenuContent align="end" className="w-[200px] p-1">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground/70 px-2 py-1">
          Verify with AI (paid)
        </DropdownMenuLabel>
        {VERIFY_OPTIONS.map((opt) => (
          <DropdownMenuItem
            key={opt.choice.model}
            onSelect={() => onChoose(opt.choice)}
            className="cursor-pointer gap-2.5 rounded-md px-2 py-2"
          >
            <opt.icon className={cn("size-3.5 shrink-0", opt.accent)} />
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-[12px] font-medium leading-tight">
                {opt.label}
              </span>
              <span className="text-[10px] text-muted-foreground leading-tight">
                {opt.hint}
              </span>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ============================================
// Item row — compact, with proper Tooltips on every action
// ============================================

interface ItemRowProps {
  item: ReviewItem;
  bucket: BucketId;
  selected: boolean;
  onToggleSelect: (key: string) => void;
  onVerifyAI: (item: ReviewItem, choice: VerifyChoice) => void;
  onApprove: (item: ReviewItem) => void;
  onReject: (item: ReviewItem) => void;
  onDelete: (item: ReviewItem) => void;
  onOpenSearch: (url: string) => void;
  busyAction: string | null;
}

function ItemRow({
  item,
  bucket,
  selected,
  onToggleSelect,
  onVerifyAI,
  onApprove,
  onReject,
  onDelete,
  onOpenSearch,
  busyAction,
}: ItemRowProps) {
  const d = item.cachedDecision;
  const busy = busyAction !== null;

  const humanApproved = d?.decidedBy === "human" && d.verdict === "SAME";
  const humanRejected = d?.decidedBy === "human" && d.verdict === "DIFFERENT";
  const aiConfidentSame =
    d?.decidedBy !== "human" &&
    d?.verdict === "SAME" &&
    (d?.confidence ?? 0) >= 70;
  const aiConfidentDiff =
    d?.decidedBy !== "human" &&
    d?.verdict === "DIFFERENT" &&
    (d?.confidence ?? 0) >= 70;
  const aiUncertain = d?.decidedBy === "gemini" && d.verdict === "UNCERTAIN";

  const isDecidedTab = bucket === "decided";
  const isAIDecided = d?.decidedBy === "gemini";
  const showAIButton = isDecidedTab
    ? isAIDecided
    : !humanApproved && !humanRejected;

  const verifyTooltip = isDecidedTab
    ? "Re-verify with AI — replaces the current AI verdict. Use sparingly: every call costs money."
    : "Verify this pair with AI. Lite is the default; reach for Pro only when stuck. AI usage costs money — prefer Approve/Reject if you can decide visually.";

  return (
    <div
      className={cn(
        "border-b border-zinc-800/50 px-2.5 py-1.5 hover:bg-zinc-800/20 transition-colors",
        selected && "bg-blue-500/5",
        humanApproved && "bg-emerald-900/10",
        humanRejected && "bg-red-900/10 opacity-80",
        !humanApproved && aiConfidentSame && "bg-emerald-900/[0.04]",
        !humanRejected && aiConfidentDiff && "bg-red-900/[0.04]",
        aiUncertain && "bg-amber-900/[0.05]",
      )}
    >
      <div className="flex items-center gap-2">
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggleSelect(item.key)}
          className="border-zinc-600 shrink-0"
        />

        <div className="flex-1 min-w-0">
          <div className="grid grid-cols-2 gap-3">
            <div className="min-w-0">
              <ProviderLabel provider={item.eventA.provider} />
              <div className="text-[12px] text-zinc-100 truncate leading-tight">
                {item.eventA.homeTeam} <span className="text-zinc-500">vs</span>{" "}
                {item.eventA.awayTeam}
              </div>
              <div className="text-[10px] text-zinc-500 truncate leading-tight">
                {item.eventA.competition}
                {item.eventA.provider !== "unknown" &&
                  ` · ${formatTime(item.eventA.startTime)}`}
              </div>
            </div>
            <div className="min-w-0">
              <ProviderLabel provider={item.eventB.provider} />
              <div className="text-[12px] text-zinc-100 truncate leading-tight">
                {item.eventB.homeTeam} <span className="text-zinc-500">vs</span>{" "}
                {item.eventB.awayTeam}
              </div>
              <div className="text-[10px] text-zinc-500 truncate leading-tight">
                {item.eventB.competition}
                {item.eventB.provider !== "unknown" &&
                  ` · ${formatTime(item.eventB.startTime)}`}
              </div>
            </div>
          </div>

          <div className="flex items-center flex-wrap gap-1 mt-1">
            {item.source !== "decided" && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
                score {(item.score * 100).toFixed(0)}%
              </Badge>
            )}
            <Badge
              variant="outline"
              className={cn(
                "text-[10px] px-1.5 py-0 h-4",
                item.source === "matched-event"
                  ? "border-emerald-700/40 text-emerald-400"
                  : item.source === "unmatched-candidate"
                    ? "border-sky-700/40 text-sky-400"
                    : item.source === "decided"
                      ? "border-zinc-700/40 text-zinc-400"
                      : "border-amber-700/40 text-amber-400",
              )}
            >
              {item.source === "matched-event"
                ? "auto-merged"
                : item.source === "unmatched-candidate"
                  ? "unmatched bucket"
                  : item.source === "decided"
                    ? "decided"
                    : "near-match"}
            </Badge>
            {item.autoSuggested && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 h-4 border-violet-700/40 text-violet-300 bg-violet-500/10"
              >
                auto-suggested
              </Badge>
            )}
            {d && <DecisionBadge decision={d} />}
          </div>
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0"
                onClick={() => onOpenSearch(item.googleSearchUrl)}
                disabled={!item.googleSearchUrl}
              >
                <ExternalLink className="w-3.5 h-3.5 text-zinc-400" />
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-sm leading-snug">
              Open a Google search to verify manually. Sanity-check obscure
              fixtures before approving.
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0"
                disabled={busy}
                onClick={() => onApprove(item)}
              >
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-sm leading-snug">
              {bucket === "decided"
                ? "Lock in as human-approved. Replaces any matcher/AI verdict."
                : "Approve — merge these two events and learn the aliases so future syncs auto-match."}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0"
                disabled={busy}
                onClick={() => onReject(item)}
              >
                <XCircle className="w-3.5 h-3.5 text-red-500" />
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-sm leading-snug">
              {bucket === "decided"
                ? "Reject — un-merge (if merged) and record as human-rejected."
                : "Reject — these are not the same event. Prevents the matcher from re-pairing them."}
            </TooltipContent>
          </Tooltip>

          {showAIButton && (
            <AiVerifyButton
              running={busy}
              disabled={busy}
              tooltip={verifyTooltip}
              onChoose={(choice) => onVerifyAI(item, choice)}
            />
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0"
                disabled={busy || !d || d.decidedBy === "matcher"}
                onClick={() => onDelete(item)}
              >
                <Trash2 className="w-3.5 h-3.5 text-zinc-500" />
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-sm leading-snug">
              Delete the cached decision. Brings the pair back to To Review on
              the next refresh.
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

const TAB_TOOLTIPS: Record<BucketId, string> = {
  "to-review":
    "Pairs nobody has decided yet — your action queue. Near-matches (70–85% similarity), unmatched single-provider events sharing a time slot, and AI verdicts that came back uncertain.",
  "auto-merged":
    "Events the matcher silently combined (≥85% similarity) — already in the dashboard, audit them when you have time.",
  decided:
    "Pairs where someone explicitly decided — AI ≥70% confident OR a human approved/rejected. Verdicts persist across syncs.",
};

// ============================================
// MatchReviewPanel
// ============================================

export function MatchReviewPanel() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [autoMerged, setAutoMerged] = useState<ReviewItem[] | null>(null);
  const [isLoadingAutoMerged, setIsLoadingAutoMerged] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bucket, setBucket] = useState<BucketId>("to-review");
  const [deciderFilter, setDeciderFilter] = useState<DeciderFilter>("all");
  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>("all");
  const [showFilters, setShowFilters] = useState(false);
  const [toReviewFilter, setToReviewFilter] = useState<ToReviewFilter>("all");
  const [busy, setBusy] = useState<Record<string, string | null>>({});

  const [isBulkBusy, setIsBulkBusy] = useState(false);
  const [isBulkPaused, setIsBulkPaused] = useState(false);
  const [controlBusy, setControlBusy] = useState<
    "pause" | "resume" | "abort" | null
  >(null);

  const [log, setLog] = useState<LogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const logIdRef = useRef(0);
  const logScrollRef = useRef<HTMLDivElement | null>(null);

  const appendLog = useCallback((draft: LogDraft) => {
    setLog((prev) => {
      const next: LogEntry = {
        ...draft,
        id: ++logIdRef.current,
        time: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      };
      const combined = [...prev, next];
      return combined.length > 500
        ? combined.slice(combined.length - 500)
        : combined;
    });
    requestAnimationFrame(() => {
      const el = logScrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  const fetchData = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const res = await fetch("/api/match-review?view=list");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ListResponse;
      setData(json);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  const fetchAutoMerged = useCallback(async () => {
    setIsLoadingAutoMerged(true);
    try {
      const res = await fetch("/api/match-review?view=auto-merged");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as AutoMergedResponse;
      setAutoMerged(json.autoMerged);
    } catch (err) {
      toast.error("Couldn't load auto-merged", {
        description: (err as Error).message,
      });
    } finally {
      setIsLoadingAutoMerged(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (bucket === "auto-merged" && autoMerged === null) {
      fetchAutoMerged();
    }
  }, [bucket, autoMerged, fetchAutoMerged]);

  // Always-on subscription to the bulk-run event stream.
  useEffect(() => {
    const es = new EventSource("/api/match-review/bulk-stream");

    const pairFromSnapshot = (decision?: CachedDecision): string => {
      const snap = decision?.snapshot;
      if (!snap) return decision?.key ?? "(unknown pair)";
      return pairLabel(snap.eventA, snap.eventB);
    };
    const modelIdToTier = (id?: string): ModelTier | undefined => {
      if (!id) return undefined;
      if (/lite/i.test(id)) return "lite";
      if (/pro/i.test(id)) return "pro";
      if (/flash/i.test(id)) return "flash";
      return undefined;
    };

    const sidesFromDecision = (d?: CachedDecision) => {
      const snap = d?.snapshot;
      if (!snap) return { sideA: d?.key ?? "(unknown pair)", sideB: undefined };
      return pairLabelSides(snap.eventA, snap.eventB);
    };

    const formatResult = (
      model: string | null,
      payload: {
        status: "analyzed" | "cached" | "error";
        decision?: CachedDecision;
        error?: string;
      },
    ): LogDraft | null => {
      if (payload.status === "error") {
        return {
          tone: "error",
          icon: "error",
          title: "Error",
          subtitle: `${pairFromSnapshot(payload.decision)} — ${payload.error ?? "unknown error"}`,
        };
      }
      const d = payload.decision;
      if (!d) return null;

      const tier =
        modelIdToTier(d.model) ??
        (model === "pro" || model === "lite" ? model : "flash");
      const sides = sidesFromDecision(d);
      const isCached = payload.status === "cached";
      const icon: LogIcon =
        d.verdict === "SAME"
          ? "merged"
          : d.verdict === "DIFFERENT"
            ? "rejected"
            : "uncertain";
      const tone: LogEntry["tone"] =
        d.verdict === "UNCERTAIN" ? "warning" : isCached ? "info" : "success";

      return {
        tone,
        icon,
        title: "",
        verdict: {
          verdict: d.verdict,
          confidence: d.confidence,
          modelTier: tier,
          cached: isCached,
          sideA: sides.sideA,
          sideB: sides.sideB,
        },
      };
    };

    let activeModel: string | null = null;
    let hydrated = false;

    const handlers: Record<string, (data: unknown) => void> = {
      snapshot: (data) => {
        const status = (data as { status?: BulkStatusPayload }).status;
        if (!status) return;
        if (status.active) {
          activeModel = status.model;
          setIsBulkBusy(true);
          setIsBulkPaused(status.paused);
          setBulkProgress({ done: status.done, total: status.total });
          setLogOpen(true);
        }
      },
      start: (data) => {
        const p = data as { model: string; total: number };
        activeModel = p.model;
        setIsBulkBusy(true);
        setIsBulkPaused(false);
        setBulkProgress({ done: 0, total: p.total });
      },
      progress: (data) => {
        const p = data as { done: number; total: number };
        setBulkProgress({ done: p.done, total: p.total });
      },
      result: (data) => {
        const evt = data as {
          payload: {
            status: "analyzed" | "cached" | "error";
            decision?: CachedDecision;
            error?: string;
          };
        };
        const msg = formatResult(activeModel, evt.payload);
        if (msg) appendLog(msg);
      },
      log: (data) => {
        const p = data as { tone: LogEntry["tone"]; text: string };
        appendLog({
          tone: p.tone,
          icon:
            p.tone === "error"
              ? "error"
              : p.tone === "warning"
                ? "uncertain"
                : "info",
          title: p.text,
        });
      },
      paused: () => setIsBulkPaused(true),
      resumed: () => setIsBulkPaused(false),
      hydrated: () => {
        hydrated = true;
      },
      aborted: () => {
        appendLog({
          tone: "warning",
          icon: "uncertain",
          title: "Bulk run aborted",
        });
      },
      done: (data) => {
        const p = data as {
          analyzed: number;
          cached: number;
          errored: number;
          total: number;
          aborted: boolean;
        };
        appendLog({
          tone: p.errored > 0 ? "warning" : "success",
          icon: "done",
          title: `Done · ${p.analyzed} analyzed · ${p.cached} cached · ${p.errored} errors`,
          subtitle: `of ${p.total} total${p.aborted ? " · aborted" : ""}`,
        });
        if (hydrated) {
          if (p.aborted) {
            toast.info("Bulk run aborted", {
              id: "bulk-run-done",
              description: `Processed ${p.analyzed + p.cached} of ${p.total} before stopping`,
            });
          } else if (p.errored > 0) {
            toast.warning("Bulk run finished with errors", {
              id: "bulk-run-done",
              description: `${p.analyzed} analyzed · ${p.cached} cached · ${p.errored} errors`,
            });
          } else {
            toast.success("Bulk run complete", {
              id: "bulk-run-done",
              description: `${p.analyzed} analyzed · ${p.cached} cached · 0 errors`,
            });
          }
        }
        setIsBulkBusy(false);
        setIsBulkPaused(false);
        setBulkProgress(null);
        activeModel = null;
        if (hydrated) {
          void fetchData();
          if (autoMerged !== null) void fetchAutoMerged();
        }
      },
    };

    const dispatch = (type: string, raw: string) => {
      const handler = handlers[type];
      if (!handler) return;
      try {
        handler(JSON.parse(raw));
      } catch {
        // Malformed event — skip.
      }
    };

    // MEMORY-LEAK GUARD — DO NOT REMOVE.
    // Each listener closes over `appendLog`, `setBulkProgress`, `fetchData`
    // and friends, which transitively retain the entire panel's React tree.
    // We must `removeEventListener` for every type we registered; relying on
    // `es.close()` alone leaves zombie listeners holding the panel state on
    // every remount of this component. If you change the registration loop,
    // mirror the change in the cleanup loop below.
    const registered: Array<{
      type: string;
      fn: (e: Event) => void;
    }> = [];
    for (const type of Object.keys(handlers)) {
      const fn = (e: Event) => dispatch(type, (e as MessageEvent).data);
      es.addEventListener(type, fn);
      registered.push({ type, fn });
    }

    return () => {
      for (const { type, fn } of registered) {
        es.removeEventListener(type, fn);
      }
      es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const deciderCounts = useMemo(() => {
    const counts = { ai: 0, human: 0 };
    if (!data) return counts;
    for (const it of data.decided) {
      const by = it.cachedDecision?.decidedBy;
      if (by === "gemini") counts.ai++;
      else if (by === "human") counts.human++;
    }
    return counts;
  }, [data]);

  const verdictCounts = useMemo(() => {
    const counts = { approved: 0, rejected: 0, uncertain: 0 };
    if (!data) return counts;
    for (const it of data.decided) {
      const by = it.cachedDecision?.decidedBy;
      const passesDecider =
        deciderFilter === "all" ||
        (deciderFilter === "ai" && by === "gemini") ||
        (deciderFilter === "human" && by === "human");
      if (!passesDecider) continue;
      const v = it.cachedDecision?.verdict;
      if (v === "SAME") counts.approved++;
      else if (v === "DIFFERENT") counts.rejected++;
      else if (v === "UNCERTAIN") counts.uncertain++;
    }
    return counts;
  }, [data, deciderFilter]);

  const isAIUnsure = (it: ReviewItem): boolean => {
    const d = it.cachedDecision;
    if (!d) return false;
    if (d.decidedBy === "human") return false;
    return d.verdict === "UNCERTAIN" || d.confidence < 80;
  };

  const toReviewCounts = useMemo(() => {
    const counts = { fresh: 0, aiUnsure: 0 };
    if (!data) return counts;
    for (const it of data.toReview) {
      if (isAIUnsure(it)) counts.aiUnsure++;
      else if (!it.cachedDecision) counts.fresh++;
    }
    return counts;
  }, [data]);

  const matchesToReviewFilter = useCallback(
    (it: ReviewItem) => {
      if (bucket !== "to-review" || toReviewFilter === "all") return true;
      if (toReviewFilter === "fresh") return !it.cachedDecision;
      if (toReviewFilter === "ai-unsure") return isAIUnsure(it);
      return true;
    },
    [bucket, toReviewFilter],
  );

  const matchesDeciderFilter = useCallback(
    (it: ReviewItem) => {
      if (bucket !== "decided" || deciderFilter === "all") return true;
      const by = it.cachedDecision?.decidedBy;
      if (!by) return false;
      if (deciderFilter === "ai") return by === "gemini";
      if (deciderFilter === "human") return by === "human";
      return true;
    },
    [bucket, deciderFilter],
  );

  const matchesVerdictFilter = useCallback(
    (it: ReviewItem) => {
      if (bucket !== "decided" || verdictFilter === "all") return true;
      const v = it.cachedDecision?.verdict;
      if (verdictFilter === "approved") return v === "SAME";
      if (verdictFilter === "rejected") return v === "DIFFERENT";
      if (verdictFilter === "uncertain") return v === "UNCERTAIN";
      return true;
    },
    [bucket, verdictFilter],
  );

  const filtered = useMemo(() => {
    if (!data) return [];
    let list: ReviewItem[];
    if (bucket === "to-review") list = data.toReview;
    else if (bucket === "auto-merged") list = autoMerged ?? [];
    else list = data.decided;

    const byFilter = list
      .filter(matchesToReviewFilter)
      .filter(matchesDeciderFilter)
      .filter(matchesVerdictFilter);

    if (bucket === "to-review") {
      byFilter.sort((a, b) => {
        const aFresh = a.cachedDecision ? 1 : 0;
        const bFresh = b.cachedDecision ? 1 : 0;
        if (aFresh !== bFresh) return aFresh - bFresh;
        return b.score - a.score;
      });
    }

    if (!search.trim()) return byFilter;
    const s = search.trim().toLowerCase();
    return byFilter.filter((it) => {
      const blob = [
        it.eventA.homeTeam,
        it.eventA.awayTeam,
        it.eventA.competition,
        it.eventA.provider,
        it.eventB.homeTeam,
        it.eventB.awayTeam,
        it.eventB.competition,
        it.eventB.provider,
      ]
        .join(" ")
        .toLowerCase();
      return blob.includes(s);
    });
  }, [
    data,
    autoMerged,
    bucket,
    search,
    matchesDeciderFilter,
    matchesVerdictFilter,
    matchesToReviewFilter,
  ]);

  const toggleSelect = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(filtered.map((it) => it.key)));
  }, [filtered]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const setItemBusy = (key: string, action: string | null) =>
    setBusy((prev) => ({ ...prev, [key]: action }));

  const describeFixture = (item: ReviewItem): string =>
    pairLabel(item.eventA, item.eventB);

  const describeProviders = (item: ReviewItem): string => {
    const a = getProviderDisplayName(item.eventA.provider);
    const b = getProviderDisplayName(item.eventB.provider);
    return `${a} + ${b}`;
  };

  const describeVerdict = (
    item: ReviewItem,
    d: CachedDecision,
    modelLabel: string,
    cached: boolean,
  ): { tone: LogEntry["tone"]; title: string; subtitle: string } => {
    const fullPair = pairLabel(item.eventA, item.eventB);
    const oneSide = eventLabel(item.eventA);
    const verdictWord =
      d.verdict === "SAME"
        ? "Merged"
        : d.verdict === "DIFFERENT"
          ? "Different"
          : "Uncertain";
    if (cached) {
      const by = d.decidedBy === "human" ? "you" : "AI";
      return {
        tone: "info",
        title: `${verdictWord} · ${d.confidence}% (cached)`,
        subtitle: `${fullPair} — already decided by ${by}`,
      };
    }
    if (d.verdict === "SAME" && d.confidence >= 70) {
      return {
        tone: "success",
        title: `Merged · ${d.confidence}%`,
        subtitle: `${oneSide} — ${modelLabel}`,
      };
    }
    if (d.verdict === "DIFFERENT" && d.confidence >= 70) {
      return {
        tone: "success",
        title: `Different · ${d.confidence}%`,
        subtitle: `${fullPair} — ${modelLabel}`,
      };
    }
    if (d.verdict === "UNCERTAIN") {
      return {
        tone: "warning",
        title: `Uncertain · ${d.confidence}%`,
        subtitle: `${fullPair} — ${modelLabel} · needs a human call`,
      };
    }
    return {
      tone: "info",
      title: `Low confidence · ${verdictWord} · ${d.confidence}%`,
      subtitle: `${fullPair} — ${modelLabel}`,
    };
  };

  const refreshAll = useCallback(async () => {
    await fetchData();
    if (autoMerged !== null) {
      fetchAutoMerged();
    }
  }, [fetchData, autoMerged, fetchAutoMerged]);

  const verifyOne = useCallback(
    async (item: ReviewItem, choice: VerifyChoice) => {
      const model = choice.model;
      const isDecidedTab = bucket === "decided";
      // Decided tab → re-verify replaces the existing AI verdict.
      const forceRefresh = isDecidedTab;
      setItemBusy(item.key, model);
      const modelLabel = `AI ${MODEL_LABELS[model].label}`;
      try {
        const res = await fetch("/api/match-review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "analyze",
            forceRefresh,
            items: [
              {
                key: item.key,
                model,
                eventA: item.eventA,
                eventB: item.eventB,
              },
            ],
          }),
        });
        const json = await res.json();
        const r = json.results?.[0];
        if (!r) {
          toast.error("No result from AI");
        } else if (r.status === "error") {
          toast.error("AI verify failed", { description: r.error });
        } else {
          const msg = describeVerdict(
            item,
            r.decision,
            modelLabel,
            r.status === "cached",
          );
          const opts = msg.subtitle ? { description: msg.subtitle } : undefined;
          if (msg.tone === "success") toast.success(msg.title, opts);
          else if (msg.tone === "warning") toast.warning(msg.title, opts);
          else toast.info(msg.title, opts);
        }
        await refreshAll();
      } catch (err) {
        toast.error("AI verify failed", {
          description: (err as Error).message,
        });
      } finally {
        setItemBusy(item.key, null);
      }
    },
    [bucket, refreshAll],
  );

  const bulkVerify = useCallback(
    async (choice: VerifyChoice) => {
      const model = choice.model;
      const forceRefresh = bucket === "decided";
      if (selected.size === 0) {
        toast.error("Nothing selected", {
          description: "Pick rows first.",
        });
        return;
      }
      const items = filtered.filter((it) => selected.has(it.key));
      const modelLabel = `AI ${MODEL_LABELS[model].label}`;
      const verb = forceRefresh ? "re-verify" : "verify";

      setLog([]);
      setLogOpen(true);
      setBulkProgress({ done: 0, total: items.length });
      setIsBulkBusy(true);
      appendLog({
        tone: "info",
        icon: "info",
        title: `Starting ${verb} — ${items.length} pair${items.length === 1 ? "" : "s"} with ${modelLabel}`,
      });

      try {
        const res = await fetch("/api/match-review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "analyze-stream",
            forceRefresh,
            items: items.map((it) => ({
              key: it.key,
              model,
              eventA: it.eventA,
              eventB: it.eventB,
            })),
          }),
        });
        if (!res.ok) {
          let msg = `HTTP ${res.status}`;
          try {
            const errJson = await res.json();
            if (errJson?.error) msg = errJson.error;
          } catch {
            // non-JSON body — keep the generic message
          }
          throw new Error(msg);
        }

        if (res.body) {
          const reader = res.body.getReader();
          void (async () => {
            try {
              while (true) {
                const { done } = await reader.read();
                if (done) break;
              }
            } catch {
              // Client disconnect or network hiccup — bulk-stream SSE tracks state.
            }
          })();
        }

        setSelected(new Set());
      } catch (err) {
        const message = (err as Error).message;
        appendLog({
          tone: "error",
          icon: "error",
          title: "Failed to start",
          subtitle: message,
        });
        toast.error("Couldn't start bulk run", { description: message });
        setIsBulkBusy(false);
        setBulkProgress(null);
      }
    },
    [selected, filtered, bucket, appendLog],
  );

  const bulkControl = useCallback(
    async (action: "pause" | "resume" | "abort") => {
      setControlBusy(action);
      try {
        const res = await fetch("/api/match-review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: `bulk-${action}` }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        if (action === "pause") {
          setIsBulkPaused(true);
          appendLog({
            tone: "info",
            icon: "info",
            title: "Bulk run paused",
            subtitle: "In-flight items will finish",
          });
        } else if (action === "resume") {
          setIsBulkPaused(false);
          appendLog({ tone: "info", icon: "info", title: "Bulk run resumed" });
        } else {
          appendLog({
            tone: "warning",
            icon: "uncertain",
            title: "Bulk run abort requested",
          });
          toast.info("Aborting bulk run", {
            description: "Workers stop after the current item",
          });
        }
      } catch (err) {
        toast.error(`Couldn't ${action} bulk run`, {
          description: (err as Error).message,
        });
      } finally {
        setControlBusy(null);
      }
    },
    [appendLog],
  );

  const approve = useCallback(
    async (item: ReviewItem) => {
      setItemBusy(item.key, "approve");
      try {
        const res = await fetch("/api/match-review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "approve",
            key: item.key,
            nearMatchId: item.nearMatchId,
            matchedEventId: item.matchedEventId,
            eventAId: item.eventAId,
            eventBId: item.eventBId,
            eventA: item.eventA,
            eventB: item.eventB,
          }),
        });
        const json = await res.json();
        if (json.success) {
          const fixture = describeFixture(item);
          const providers = describeProviders(item);
          if (json.mergedId) {
            toast.success("Merged", {
              description: `${fixture} • ${providers}`,
            });
          } else if (json.deferred) {
            toast.warning("Verdict saved — merge deferred", {
              description: `${fixture} will merge on the next sync.`,
            });
          } else {
            toast.success("Verdict saved", {
              description: fixture,
            });
          }
        } else {
          toast.error("Couldn't approve", {
            description: json.error || "Unknown error",
          });
        }
        await refreshAll();
      } catch (err) {
        toast.error("Couldn't approve", {
          description: (err as Error).message,
        });
      } finally {
        setItemBusy(item.key, null);
      }
    },
    [refreshAll],
  );

  const reject = useCallback(
    async (item: ReviewItem) => {
      setItemBusy(item.key, "reject");
      try {
        await fetch("/api/match-review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "reject",
            key: item.key,
            nearMatchId: item.nearMatchId,
            matchedEventId: item.matchedEventId,
            eventAId: item.eventAId,
            eventBId: item.eventBId,
            eventA: item.eventA,
            eventB: item.eventB,
          }),
        });
        toast.success("Marked different", {
          description: `${describeFixture(item)} • ${describeProviders(item)}`,
        });
        await refreshAll();
      } catch (err) {
        toast.error("Couldn't reject", {
          description: (err as Error).message,
        });
      } finally {
        setItemBusy(item.key, null);
      }
    },
    [refreshAll],
  );

  const removeDecision = useCallback(
    async (item: ReviewItem) => {
      setItemBusy(item.key, "delete");
      try {
        await fetch("/api/match-review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "delete", key: item.key }),
        });
        toast.success("Decision cleared", {
          description: `${describeFixture(item)} — back to To Review`,
        });
        await refreshAll();
      } catch (err) {
        toast.error("Couldn't clear decision", {
          description: (err as Error).message,
        });
      } finally {
        setItemBusy(item.key, null);
      }
    },
    [refreshAll],
  );

  const openSearch = useCallback((url: string) => {
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  }, []);

  if (isLoading && !data) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-zinc-500" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-red-400 gap-2">
        <AlertCircle className="w-4 h-4" /> {error}
      </div>
    );
  }

  if (!data) return null;

  const toReviewCount = data.toReview.length;
  const decidedCount = data.decided.length;

  const tabBtn = (
    id: BucketId,
    label: string,
    count: number,
    accent: {
      active: string;
      idle: string;
    },
  ) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={() => setBucket(id)}
          className={cn(
            "px-2.5 py-1 text-xs rounded transition-colors",
            bucket === id ? accent.active : accent.idle,
          )}
        >
          {label} ({count})
          {id === "auto-merged" &&
            bucket === "auto-merged" &&
            isLoadingAutoMerged && (
              <Loader2 className="inline w-3 h-3 ml-1 animate-spin" />
            )}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-sm leading-snug">
        {TAB_TOOLTIPS[id]}
      </TooltipContent>
    </Tooltip>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <div className="h-full flex flex-col bg-zinc-900/30 border border-zinc-800 rounded-lg overflow-hidden">
        {/* Single header row — tabs + meta + actions, no extra layers */}
        <div className="px-3 py-2 border-b border-zinc-800/50 flex flex-wrap items-center gap-2">
          {tabBtn("to-review", "To Review", toReviewCount, {
            active: "bg-amber-500/15 text-amber-300 border border-amber-500/30",
            idle: "text-zinc-400 hover:text-zinc-200",
          })}
          {tabBtn("auto-merged", "Auto-Merged", data.autoMergedCount, {
            active:
              "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30",
            idle: "text-zinc-400 hover:text-zinc-200",
          })}
          {tabBtn("decided", "Decided", decidedCount, {
            active: "bg-sky-500/15 text-sky-300 border border-sky-500/30",
            idle: "text-zinc-400 hover:text-zinc-200",
          })}

          {bucket === "to-review" && (
            <ToReviewFilterChips
              filter={toReviewFilter}
              setFilter={setToReviewFilter}
              counts={toReviewCounts}
              total={toReviewCount}
            />
          )}

          {bucket === "decided" && (
            <DecidedInlineFilters
              verdictFilter={verdictFilter}
              setVerdictFilter={setVerdictFilter}
              deciderFilter={deciderFilter}
              setDeciderFilter={setDeciderFilter}
              verdictCounts={verdictCounts}
              deciderCounts={deciderCounts}
              decidedCount={decidedCount}
              show={showFilters}
              setShow={setShowFilters}
            />
          )}

          <div className="ml-auto flex items-center gap-2">
            <span className="text-[10px] text-zinc-500 tabular-nums">
              Cached: {data.stats.total} · ✓ {data.stats.humanApproved} · ✗{" "}
              {data.stats.humanRejected}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <LoadingButton
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  onClick={() => {
                    fetchData();
                    if (bucket === "auto-merged") fetchAutoMerged();
                  }}
                  loading={isRefreshing || isLoadingAutoMerged}
                  icon={RefreshCw}
                  iconClassName="w-3.5 h-3.5"
                />
              </TooltipTrigger>
              <TooltipContent>Refresh the current tab</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Compact toolbar — search + selection + bulk action */}
        <div className="px-3 py-1.5 border-b border-zinc-800/50 flex flex-wrap items-center gap-2">
          <div className="relative w-[260px] shrink-0">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by team, competition…"
              className="h-7 pl-7 text-xs"
            />
          </div>

          <div className="flex items-center gap-1.5 text-[11px]">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={selectAll}
                  disabled={filtered.length === 0}
                  className="px-2 py-0.5 rounded border border-zinc-800 text-zinc-400 hover:text-zinc-100 hover:border-zinc-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Select all{" "}
                  <span className="tabular-nums text-zinc-500">
                    ({filtered.length})
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent>Select every row currently shown</TooltipContent>
            </Tooltip>
            {selected.size > 0 && (
              <>
                <button
                  onClick={clearSelection}
                  className="px-2 py-0.5 rounded border border-zinc-800 text-zinc-400 hover:text-zinc-100 hover:border-zinc-600 transition-colors"
                >
                  Clear
                </button>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-500/15 border border-blue-500/30 text-blue-300 font-medium">
                  <span className="tabular-nums">{selected.size}</span>
                  selected
                </span>
              </>
            )}
          </div>

          <div className="flex-1" />

          {/* Bulk verify dropdown — single button, AI is opt-in */}
          {selected.size > 0 && (
            <AiVerifyButton
              running={isBulkBusy}
              disabled={isBulkBusy}
              tooltip="Run AI on every selected pair. AI calls cost money — prefer Approve/Reject row-by-row when you can decide visually."
              onChoose={(c) => bulkVerify(c)}
              bulkLabel={`Verify ${selected.size}`}
            />
          )}
        </div>

        {/* List */}
        <div className="flex-1 overflow-auto">
          {filtered.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-zinc-500 text-center px-6">
              {bucket === "to-review"
                ? toReviewFilter === "fresh"
                  ? "No fresh rows — every pair here has been AI-attempted."
                  : toReviewFilter === "ai-unsure"
                    ? "No AI-unsure rows."
                    : "Queue is empty — nothing needs a decision right now."
                : bucket === "auto-merged"
                  ? isLoadingAutoMerged
                    ? "Loading…"
                    : "No matcher auto-merges to audit right now."
                  : verdictFilter !== "all"
                    ? `No ${verdictFilter} decisions${deciderFilter !== "all" ? ` by ${deciderFilter === "ai" ? "AI" : "human"}` : ""} yet.`
                    : deciderFilter !== "all"
                      ? `No decisions by ${deciderFilter === "ai" ? "AI" : "human"} yet.`
                      : "No decisions recorded yet."}
            </div>
          ) : bucket === "to-review" ? (
            (() => {
              const ungrouped: ReviewItem[] = [];
              const groups = new Map<string, ReviewItem[]>();
              for (const it of filtered) {
                if (it.source === "unmatched-candidate" && it.bucketKey) {
                  const arr = groups.get(it.bucketKey);
                  if (arr) arr.push(it);
                  else groups.set(it.bucketKey, [it]);
                } else {
                  ungrouped.push(it);
                }
              }
              const sortedGroups = Array.from(groups.entries()).sort(
                ([a], [b]) => a.localeCompare(b),
              );
              return (
                <>
                  {ungrouped.map((item) => (
                    <ItemRow
                      key={item.key}
                      item={item}
                      bucket={bucket}
                      selected={selected.has(item.key)}
                      onToggleSelect={toggleSelect}
                      onVerifyAI={verifyOne}
                      onApprove={approve}
                      onReject={reject}
                      onDelete={removeDecision}
                      onOpenSearch={openSearch}
                      busyAction={busy[item.key] || null}
                    />
                  ))}
                  {sortedGroups.map(([bucketKey, items]) => {
                    const ordered = [...items].sort((a, b) => {
                      const ap = a.autoSuggested ? 0 : 1;
                      const bp = b.autoSuggested ? 0 : 1;
                      if (ap !== bp) return ap - bp;
                      return b.score - a.score;
                    });
                    const autoCount = items.filter(
                      (i) => i.autoSuggested,
                    ).length;
                    return (
                      <div key={bucketKey}>
                        <div className="sticky top-0 z-10 bg-zinc-900/90 backdrop-blur px-3 py-1 border-y border-zinc-800 text-[10px] text-zinc-400 uppercase tracking-wider">
                          Unmatched bucket ·{" "}
                          {new Date(bucketKey).toLocaleString([], {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                          <span className="ml-2 text-zinc-600 normal-case tracking-normal">
                            {items.length} candidate
                            {items.length === 1 ? "" : "s"}
                            {autoCount > 0 && (
                              <span className="ml-2 text-violet-400">
                                · {autoCount} auto-suggested
                              </span>
                            )}
                          </span>
                        </div>
                        {ordered.map((item) => (
                          <ItemRow
                            key={item.key}
                            item={item}
                            bucket={bucket}
                            selected={selected.has(item.key)}
                            onToggleSelect={toggleSelect}
                            onVerifyAI={verifyOne}
                            onApprove={approve}
                            onReject={reject}
                            onDelete={removeDecision}
                            onOpenSearch={openSearch}
                            busyAction={busy[item.key] || null}
                          />
                        ))}
                      </div>
                    );
                  })}
                </>
              );
            })()
          ) : (
            filtered.map((item) => (
              <ItemRow
                key={item.key}
                item={item}
                bucket={bucket}
                selected={selected.has(item.key)}
                onToggleSelect={toggleSelect}
                onVerifyAI={verifyOne}
                onApprove={approve}
                onReject={reject}
                onDelete={removeDecision}
                onOpenSearch={openSearch}
                busyAction={busy[item.key] || null}
              />
            ))
          )}
        </div>

        {(log.length > 0 || isBulkBusy) && (
          <ActivityDrawer
            log={log}
            logOpen={logOpen}
            setLogOpen={setLogOpen}
            setLog={setLog}
            logScrollRef={logScrollRef}
            isBulkBusy={isBulkBusy}
            isBulkPaused={isBulkPaused}
            controlBusy={controlBusy}
            bulkProgress={bulkProgress}
            onControl={bulkControl}
          />
        )}
      </div>
    </TooltipProvider>
  );
}

function ToReviewFilterChips({
  filter,
  setFilter,
  counts,
  total,
}: {
  filter: ToReviewFilter;
  setFilter: (f: ToReviewFilter) => void;
  counts: { fresh: number; aiUnsure: number };
  total: number;
}) {
  const chips: { id: ToReviewFilter; label: string; tooltip: string }[] = [
    {
      id: "all",
      label: `All (${total})`,
      tooltip: "Every row in the queue, regardless of whether AI has tried.",
    },
    {
      id: "fresh",
      label: `No AI yet (${counts.fresh})`,
      tooltip: "Rows no AI has analyzed — start here, no cost.",
    },
    {
      id: "ai-unsure",
      label: `AI unsure (${counts.aiUnsure})`,
      tooltip:
        "AI already ran but came back UNCERTAIN or below 80% confidence — needs a human call.",
    },
  ];
  return (
    <div className="inline-flex items-center gap-1 text-[11px] ml-1 pl-2 border-l border-zinc-800">
      {chips.map((chip) => (
        <Tooltip key={chip.id}>
          <TooltipTrigger asChild>
            <button
              onClick={() => setFilter(chip.id)}
              className={cn(
                "px-2 py-0.5 rounded border transition-colors",
                filter === chip.id
                  ? "bg-zinc-800 border-zinc-600 text-zinc-100"
                  : "border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700",
              )}
            >
              {chip.label}
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-sm leading-snug">
            {chip.tooltip}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

function DecidedInlineFilters({
  verdictFilter,
  setVerdictFilter,
  deciderFilter,
  setDeciderFilter,
  verdictCounts,
  deciderCounts,
  decidedCount,
  show,
  setShow,
}: {
  verdictFilter: VerdictFilter;
  setVerdictFilter: (v: VerdictFilter) => void;
  deciderFilter: DeciderFilter;
  setDeciderFilter: (v: DeciderFilter) => void;
  verdictCounts: { approved: number; rejected: number; uncertain: number };
  deciderCounts: { ai: number; human: number };
  decidedCount: number;
  show: boolean;
  setShow: (v: boolean) => void;
}) {
  const activeCount =
    (verdictFilter !== "all" ? 1 : 0) + (deciderFilter !== "all" ? 1 : 0);

  const verdictOptions: {
    id: VerdictFilter;
    label: string;
    count: number;
    dot: string | null;
  }[] = [
    {
      id: "all",
      label: "All",
      count:
        verdictCounts.approved +
        verdictCounts.rejected +
        verdictCounts.uncertain,
      dot: null,
    },
    {
      id: "approved",
      label: "Approved",
      count: verdictCounts.approved,
      dot: "bg-emerald-500",
    },
    {
      id: "rejected",
      label: "Rejected",
      count: verdictCounts.rejected,
      dot: "bg-red-500",
    },
    {
      id: "uncertain",
      label: "Uncertain",
      count: verdictCounts.uncertain,
      dot: "bg-amber-500",
    },
  ];

  const deciderOptions: { id: DeciderFilter; label: string; count: number }[] =
    [
      { id: "all", label: "All", count: decidedCount },
      { id: "ai", label: "AI", count: deciderCounts.ai },
      { id: "human", label: "Human", count: deciderCounts.human },
    ];

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => setShow(!show)}
            className={cn(
              "relative h-7 w-7 rounded-md border inline-flex items-center justify-center transition-colors shrink-0",
              show || activeCount > 0
                ? "bg-blue-500/15 border-blue-500/40 text-blue-200"
                : "bg-zinc-900/60 border-zinc-800 text-zinc-400 hover:text-zinc-100 hover:border-zinc-700",
            )}
            aria-label="Toggle filters"
            aria-pressed={show}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            {activeCount > 0 && (
              <span className="absolute -top-1 -right-1 tabular-nums text-[9px] leading-none px-1 py-0.5 rounded bg-blue-500 text-white">
                {activeCount}
              </span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>Toggle verdict and decider filters</TooltipContent>
      </Tooltip>

      {show && (
        <>
          <InlineFilterGroup label="Verdict">
            {verdictOptions.map((opt) => (
              <InlineFilterChip
                key={opt.id}
                active={verdictFilter === opt.id}
                onClick={() => setVerdictFilter(opt.id)}
                dot={opt.dot}
                count={opt.count}
              >
                {opt.label}
              </InlineFilterChip>
            ))}
          </InlineFilterGroup>

          <InlineFilterGroup label="Decider">
            {deciderOptions.map((opt) => (
              <InlineFilterChip
                key={opt.id}
                active={deciderFilter === opt.id}
                onClick={() => setDeciderFilter(opt.id)}
                count={opt.count}
              >
                {opt.label}
              </InlineFilterChip>
            ))}
          </InlineFilterGroup>
        </>
      )}
    </>
  );
}

function InlineFilterGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="inline-flex items-center gap-1 shrink-0">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">
        {label}
      </span>
      <div className="inline-flex items-center gap-0.5 p-0.5 rounded-md border border-zinc-800 bg-zinc-900/60">
        {children}
      </div>
    </div>
  );
}

function InlineFilterChip({
  active,
  onClick,
  children,
  count,
  dot,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  count?: number;
  dot?: string | null;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] transition-colors",
        active
          ? "bg-zinc-700 text-zinc-100"
          : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200",
      )}
    >
      {dot !== undefined && dot !== null && (
        <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", dot)} />
      )}
      <span>{children}</span>
      {typeof count === "number" && (
        <span className="tabular-nums text-zinc-500">{count}</span>
      )}
    </button>
  );
}

export default MatchReviewPanel;
