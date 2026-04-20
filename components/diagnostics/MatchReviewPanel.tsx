"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  XCircle,
  Trash2,
  ExternalLink,
  Sparkles,
  Cpu,
  RefreshCw,
  Loader2,
  Search,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Activity,
  Info,
  Pause,
  Play,
  Square,
  SlidersHorizontal,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { getProviderDisplayName } from "@/lib/providers/registry";
import { MODEL_LABELS, MODEL_TIERS, type ModelTier } from "@/lib/ai/models";
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
  reasoning: string;
  sources: { url: string; title: string }[];
  decidedBy: DecidedBy;
  decidedAt: string;
  model?: string;
  by?: string;
  /** Frozen pair snapshot — used by the bulk-stream subscription to build
   * log entries even when the ReviewItem is no longer in current data. */
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
  /** Count of matcher auto-merges, rendered on the Auto-Merged tab label. */
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

/** Structured verdict data — used to render nice badges in the Ticker
 * instead of the old "Merged · Gemini flash 100%" string soup. Optional
 * because non-verdict entries (start/done/errors) don't have these. */
interface VerdictMeta {
  verdict: "SAME" | "DIFFERENT" | "UNCERTAIN";
  confidence: number;
  modelTier?: ModelTier;
  cached?: boolean;
  /** Two sides of the pair. Shown as the body of the row — either "A vs B"
   * alone (when both sides have the same teams after canonicalization) or
   * "A vs B ↔ C vs D" when names differ. */
  sideA?: string;
  sideB?: string;
}

interface LogEntry {
  id: number;
  tone: "info" | "success" | "warning" | "error";
  icon: LogIcon;
  /** Short label — rendered as the row's primary text. Kept free-form for
   * non-verdict entries (e.g. "Bulk run complete", "Warming up…"). */
  title: string;
  /** Dim detail line beneath the title. Used for error messages and any
   * entry that doesn't carry `verdict` meta. */
  subtitle?: string;
  /** When present, the row renders structured verdict badges instead of a
   * plain title. */
  verdict?: VerdictMeta;
  /** Gemini's full reasoning — surfaced in a tooltip on hover. */
  reasoning?: string;
  time: string;
}

type LogDraft = Omit<LogEntry, "id" | "time">;

/**
 * Mirrors `BulkStatus` returned by `/api/match-review/bulk-stream`'s initial
 * snapshot frame. Kept in sync with `lib/matching/bulk-control.ts`.
 */
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
// Each entry renders as icon + bold title with the timestamp on the right,
// and an optional dim subtitle line beneath. This is visually denser than a
// plain console log but reads like a status feed — matches the toast shape
// (title + description) so the two feel like one language.

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

function LogEntryRow({ entry }: { entry: LogEntry }) {
  const Icon = LOG_ICON_COMPONENTS[entry.icon];
  return (
    <div className="flex items-start gap-2 px-1.5 py-1.5">
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
              "text-[11px] font-medium leading-snug min-w-0 truncate",
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
}

// ============================================
// The Ticker — activity log redesigned
// ============================================
// Replaces the old "chronological wall of rows" drawer with a focused feed
// that surfaces the interesting events and compresses the boring ones:
//
//   ┌─────────────────────────────────────────── floating elevated panel ─┐
//   │  Status strip: progress · ETA · tally chips (click to filter)       │
//   │                                                                     │
//   │  Feed:                                                              │
//   │  ▎SAME · 92%   Arsenal vs Chelsea ↔ Arsenal FC vs Chelsea FC  0:12  │
//   │  ▸ 14 kept separate (83–89%)  ← collapsed run                       │
//   │  ▎UNCERTAIN · 55%  Real Madrid vs Atlético …         [Try Pro →]    │
//   │  ▎ERROR  Rate limit on pair #47                                     │
//   │                                                                     │
//   │  Search │ pause ⏸ │ clear │ close                                   │
//   └─────────────────────────────────────────────────────────────────────┘
//
// The panel floats above the list (elevated shadow, rounded, distinct bg)
// so it no longer looks like a continuation of the table.

type TickerFilter = "all" | "merged" | "different" | "uncertain" | "error";

const FILTER_LABEL: Record<TickerFilter, string> = {
  all: "All",
  merged: "Merged",
  different: "Different",
  uncertain: "Uncertain",
  error: "Errors",
};

/** Icon → tone category. Used for severity rails and the filter chips. */
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

// ============================================
// Badges used inside structured verdict rows
// ============================================

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
  // Gradient tint so the eye picks up low-confidence verdicts even when they
  // share a verdict badge with high-confidence ones. ≥90% is authoritative-
  // looking, 70-89% is normal, <70% dims to signal "handle with care".
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
      title={MODEL_LABELS[tier].tagline}
    >
      {MODEL_LABELS[tier].label}
    </span>
  );
}

function CachedPill() {
  return (
    <span
      className="px-1 py-0.5 rounded text-[9px] font-medium bg-zinc-800 text-zinc-500 uppercase tracking-wider leading-none"
      title="Returned from cache — this pair had already been decided, no fresh API call was made."
    >
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

  // Shared row wrapper with severity rail.
  const rowBody =
    v != null ? (
      // Structured verdict row — distinct badges instead of "Merged · Gemini flash 100%"
      <div className="flex-1 min-w-0 flex items-center gap-2 px-2.5 py-1.5">
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
      // Plain row — errors, start/done/info messages. Keeps subtitle layout.
      <div className="flex-1 min-w-0 flex items-start gap-2 px-2.5 py-1.5">
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

  const row = (
    <div
      className={cn(
        "group flex items-stretch text-[11px] hover:bg-zinc-800/40 transition-colors cursor-default",
        entry.reasoning && "hover:bg-zinc-800/60",
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

  // Tooltip wrapper only when reasoning is present. Non-verdict entries
  // (info/done) and error entries (subtitle already has the message) skip it.
  if (!entry.reasoning) return row;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        className="max-w-md bg-zinc-900 text-zinc-100 border border-zinc-700 shadow-xl px-3 py-2"
      >
        <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">
          {v ? "Gemini reasoning" : "Details"}
        </div>
        <div className="text-[12px] leading-relaxed whitespace-pre-wrap">
          {entry.reasoning}
        </div>
      </TooltipContent>
    </Tooltip>
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

  // Tallies — run once per log change, feed the filter chips.
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

  // Pause auto-scroll when the user scrolls up mid-run; resume when they
  // scroll back to the bottom. Also freezes on explicit pause button.
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
    // Also write through to the parent ref so older code paths keep working.
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
        title={`Show only ${FILTER_LABEL[id]} (${count})`}
      >
        {FILTER_LABEL[id]}{" "}
        <span className="opacity-70">{id === "all" ? log.length : count}</span>
      </button>
    );
  };

  // Collapsed strip — shown when the user closes the panel but a run is
  // active or the log has content. Single row, clicks expand.
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
      {/* Elevated floating panel — distinct from the table above via:
            • Margin on all sides (doesn't touch the table border)
            • Darker bg + rounded corners + real shadow
            • A thin accent gradient at the very top edge
          Fixed height (38vh, roughly half the table area above) so the panel
          doesn't shift around when you switch tabs or when rows arrive — the
          feed scrolls internally to fill what's left after the strip + band
          + command bar. */}
      <div className="flex flex-col h-[38vh] rounded-lg border border-zinc-700/80 bg-zinc-950 shadow-[0_-8px_24px_-8px_rgba(0,0,0,0.6),0_0_0_1px_rgba(255,255,255,0.04)] overflow-hidden">
        {/* Top accent — thin gradient to visually "lift" the panel off the
            table even when the surrounding area is dark. */}
        <div className="h-[2px] bg-gradient-to-r from-transparent via-blue-500/60 to-transparent shrink-0" />

        {/* Status strip — progress, tally chips, primary controls. Its own
            background row so the feed below it feels distinct. */}
        <div className="relative bg-zinc-900/90 border-b border-zinc-800 shrink-0">
          {bulkProgress && (
            <div
              className="absolute inset-y-0 left-0 bg-blue-500/10 transition-all duration-300 pointer-events-none"
              style={{ width: `${percent}%` }}
              aria-hidden
            />
          )}
          <div className="relative flex items-center gap-2 px-3 h-10">
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
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={controlBusy !== null}
                    onClick={() => onControl(isBulkPaused ? "resume" : "pause")}
                    title={
                      isBulkPaused
                        ? "Resume the paused bulk run."
                        : "Pause the bulk run. In-flight items finish; new items wait."
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
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={controlBusy !== null}
                    onClick={() => onControl("abort")}
                    title="Abort the bulk run."
                    className="h-7 w-7 p-0 text-red-300 hover:text-red-200"
                  >
                    {controlBusy === "abort" ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Square className="w-3.5 h-3.5" />
                    )}
                  </Button>
                </>
              )}
              {!isBulkBusy && log.length > 0 && (
                <button
                  onClick={() => setLog([])}
                  title="Clear the activity log."
                  className="h-7 px-2 text-[11px] text-zinc-500 hover:text-zinc-300 rounded transition-colors"
                >
                  Clear
                </button>
              )}
              <button
                onClick={() => setLogOpen((v) => !v)}
                title="Collapse activity panel"
                className="h-7 w-7 p-0 inline-flex items-center justify-center text-zinc-500 hover:text-zinc-300 rounded"
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Feed — fills the remaining vertical space inside the fixed-height
            panel. `min-h-0` is mandatory so the flex child can shrink below
            its content size and its own overflow can take over. Extra bottom
            padding keeps the final row's subtitle fully visible above the
            command bar instead of being flush against its border.
            Wrapped in TooltipProvider so every verdict row can expose Gemini's
            reasoning on hover via the shared Radix tooltip context. */}
        <TooltipProvider delayDuration={200}>
          <div
            ref={feedRef}
            onScroll={onFeedScroll}
            className="flex-1 min-h-0 overflow-auto divide-y divide-zinc-800/40 bg-zinc-950 pb-1.5"
          >
            {log.length === 0 ? (
              <div className="text-zinc-600 italic text-[11px] px-3 py-3">
                Waiting for events. Start a bulk analyze to watch verdicts
                stream in.
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
        </TooltipProvider>

        {/* Command bar — search + auto-scroll hint */}
        <div className="flex items-center gap-2 px-2 py-1.5 border-t border-zinc-800 bg-zinc-900/60 shrink-0">
          <div className="relative flex-1 min-w-0">
            <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-zinc-600" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by team, reasoning, model…"
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
              title="Jump to latest and resume auto-scroll."
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
      ? "Gemini"
      : "Matcher";

  if (isMatcher) {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border bg-sky-500/15 text-sky-300 border-sky-500/30"
        title={`Auto-merged by the string-similarity matcher at ${decision.confidence}% confidence. Approve to lock it in as human-verified; reject to unmerge.`}
      >
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
        title={`Decided by human${decision.by ? ` (${decision.by})` : ""} · ${new Date(decision.decidedAt).toLocaleString()}`}
      >
        {approved ? (
          <CheckCircle2 className="w-3 h-3" />
        ) : (
          <XCircle className="w-3 h-3" />
        )}
        {deciderLabel} · {approved ? "Approved" : "Rejected"}
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
      title={`${deciderLabel}${decision.model ? ` (${decision.model})` : ""} · ${new Date(decision.decidedAt).toLocaleString()}`}
    >
      {deciderLabel} · {decision.verdict} · {decision.confidence}%
    </span>
  );
}

function ProviderLabel({ provider }: { provider: string }) {
  // Fixed leading so the italic "archived" tag and the uppercase provider
  // tag take exactly the same vertical space — keeps team lines across the
  // two columns on the same baseline.
  const base = "text-[10px] h-4 leading-4";
  if (provider === "unknown") {
    return (
      <div
        className={cn(base, "italic tracking-wide text-zinc-600 font-normal")}
        title="The original events are no longer in the live sync (past fixture or pruned). The verdict is still honored — it prevents the pair from re-surfacing if those teams meet again."
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

interface ItemRowProps {
  item: ReviewItem;
  bucket: BucketId;
  selected: boolean;
  modelTier: ModelTier;
  onToggleSelect: (key: string) => void;
  onAnalyze: (
    item: ReviewItem,
    model: ModelTier,
    forceRefresh?: boolean,
  ) => void;
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
  modelTier,
  onToggleSelect,
  onAnalyze,
  onApprove,
  onReject,
  onDelete,
  onOpenSearch,
  busyAction,
}: ItemRowProps) {
  const [expanded, setExpanded] = useState(false);
  const d = item.cachedDecision;
  const busy = busyAction !== null;

  // Tint the row by current verdict — green for approved (or AI SAME that
  // would auto-merge), red for rejected, amber-tinted for Gemini UNCERTAIN.
  // Threshold matches the server's default `AI_AUTONOMOUS_THRESHOLD`.
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
  // On the Decided tab the same AI buttons act as "re-run" — they send
  // forceRefresh so the AI re-analyzes and the new verdict replaces the old
  // one. Human verdicts are authoritative: the cache refuses to overwrite
  // them, so we don't offer a re-run there (user must Delete first).
  const isAIDecided = d?.decidedBy === "gemini";
  const showAnalyzeButtons = isDecidedTab
    ? isAIDecided
    : !humanApproved && !humanRejected;
  const isRerun = isDecidedTab && isAIDecided;
  const showApproveReject = true;

  return (
    <div
      className={cn(
        "border-b border-zinc-800/50 px-3 py-2 hover:bg-zinc-800/20 transition-colors",
        selected && "bg-blue-500/5",
        humanApproved && "bg-emerald-900/10",
        humanRejected && "bg-red-900/10 opacity-80",
        !humanApproved && aiConfidentSame && "bg-emerald-900/[0.04]",
        !humanRejected && aiConfidentDiff && "bg-red-900/[0.04]",
        aiUncertain && "bg-amber-900/[0.05]",
      )}
    >
      <div className="flex items-start gap-2">
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggleSelect(item.key)}
          className="mt-1.5 border-zinc-600"
        />
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-zinc-500 hover:text-zinc-300 shrink-0"
          title={expanded ? "Collapse" : "Expand reasoning"}
        >
          {expanded ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
        </button>

        <div className="flex-1 min-w-0">
          <div className="grid grid-cols-2 gap-3">
            <div className="min-w-0">
              <ProviderLabel provider={item.eventA.provider} />
              <div className="text-sm text-zinc-100 truncate">
                {item.eventA.homeTeam} <span className="text-zinc-500">vs</span>{" "}
                {item.eventA.awayTeam}
              </div>
              <div className="text-xs text-zinc-500 truncate">
                {item.eventA.competition}
                {item.eventA.provider !== "unknown" &&
                  ` · ${formatTime(item.eventA.startTime)}`}
              </div>
            </div>
            <div className="min-w-0">
              <ProviderLabel provider={item.eventB.provider} />
              <div className="text-sm text-zinc-100 truncate">
                {item.eventB.homeTeam} <span className="text-zinc-500">vs</span>{" "}
                {item.eventB.awayTeam}
              </div>
              <div className="text-xs text-zinc-500 truncate">
                {item.eventB.competition}
                {item.eventB.provider !== "unknown" &&
                  ` · ${formatTime(item.eventB.startTime)}`}
              </div>
            </div>
          </div>

          <div className="flex items-center flex-wrap gap-1.5 mt-1.5">
            {item.source !== "decided" && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 h-4"
                title={
                  item.source === "matched-event"
                    ? "Match confidence — how sure the system was when it merged these. 100% means a clean 85%+ string/alias match; lower means AI-confirmed or human-approved."
                    : "Similarity score: 0.7 × team-name similarity + 0.3 × league similarity, after aliases.\n\n" +
                      "• ≥85% = auto-match (merged by the system → Auto-Matched tab).\n" +
                      "• 70–85% = near-match (appears here for you to review).\n" +
                      "• <70% = ignored, unless a time-bucket neighbor suggests them."
                }
              >
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
              title={
                item.source === "matched-event"
                  ? "The system already merged these (matcher ≥85% or AI ≥80% SAME). Approve locks it in; Reject un-merges."
                  : item.source === "unmatched-candidate"
                    ? "Single-provider events sharing a time bucket with another provider's events. Text similarity was too low to auto-match, but the time overlap is suggestive."
                    : item.source === "decided"
                      ? "Finalized — keeps its verdict unless you delete it."
                      : "Scored 70–85% — close to matching but below threshold. Approving here teaches aliases so tomorrow's sync auto-matches them."
              }
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
                title="Bucket symmetry pick — each provider in this time slot has the same number of events, so this pairing is the only plausible 1-to-1 mapping even if the string score is low."
              >
                auto-suggested
              </Badge>
            )}
            {d && <DecisionBadge decision={d} />}
          </div>

          {expanded && d && (
            <div className="mt-2 rounded bg-zinc-900/60 border border-zinc-800 px-3 py-2">
              <div className="text-[10px] text-zinc-500 mb-1">
                {d.decidedBy === "human"
                  ? `Decided by human${d.by ? ` (${d.by})` : ""}`
                  : `Gemini${d.model ? ` (${d.model})` : ""}`}{" "}
                · {new Date(d.decidedAt).toLocaleString()}
              </div>
              <div className="text-xs text-zinc-300 whitespace-pre-wrap">
                {d.reasoning || "(no notes)"}
              </div>
              {d.sources.length > 0 && (
                <div className="mt-2">
                  <div className="text-[10px] text-zinc-500 mb-1">Sources</div>
                  <ul className="text-xs space-y-0.5">
                    {d.sources.slice(0, 5).map((s, i) => (
                      <li key={i}>
                        <a
                          className="text-blue-400 hover:underline truncate block"
                          href={s.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {s.title || s.url}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {expanded && !d && (
            <div className="mt-2 rounded bg-zinc-900/60 border border-zinc-800 px-3 py-2 text-xs text-zinc-500 italic">
              No AI analysis yet. Click one of the AI buttons to get a
              reasoning.
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {/* AI action — a single button that uses the globally-selected model
              tier (Lite / Flash / Pro). The slot is kept (invisible) when the
              row isn't actionable so the approve/reject cluster stays in a
              consistent column across rows. */}
          <div
            className={cn(
              "flex items-center gap-1",
              !showAnalyzeButtons && "invisible pointer-events-none",
            )}
            aria-hidden={!showAnalyzeButtons}
          >
            {(() => {
              const label = MODEL_LABELS[modelTier].label;
              const Icon =
                modelTier === "pro"
                  ? Sparkles
                  : modelTier === "lite"
                    ? Activity
                    : Cpu;
              const iconColor =
                modelTier === "pro"
                  ? "text-blue-400"
                  : modelTier === "lite"
                    ? "text-zinc-400"
                    : "text-purple-400";
              const title = isRerun
                ? `Re-run with Gemini ${label} — replaces the existing verdict.`
                : `Analyze with Gemini ${label} (${MODEL_LABELS[modelTier].tagline.toLowerCase()}). Switch tiers via the header toggle.`;
              return (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2"
                  title={title}
                  disabled={busy || !showAnalyzeButtons}
                  onClick={() => onAnalyze(item, modelTier, isRerun)}
                >
                  {busyAction ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Icon className={cn("w-3.5 h-3.5", iconColor)} />
                  )}
                </Button>
              );
            })()}
            {/* "Try Pro →" upgrade shortcut — only shown when Gemini returned
                an ambiguous verdict (UNCERTAIN, or <80% confidence) AND the
                user isn't already on Pro. One-click deep-reanalyze bypassing
                the global tier. */}
            {d?.decidedBy === "gemini" &&
              modelTier !== "pro" &&
              (d.verdict === "UNCERTAIN" || (d.confidence ?? 0) < 80) && (
                <button
                  onClick={() => onAnalyze(item, "pro", true)}
                  disabled={busy}
                  title="Re-analyze this pair with Gemini Pro (deep reasoning). Bypasses the global tier."
                  className="h-7 px-1.5 text-[10px] font-medium text-blue-300 border border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/20 hover:border-blue-500/50 rounded transition-colors disabled:opacity-40"
                >
                  Try Pro →
                </button>
              )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            title="Open a Google search to verify manually. Useful as a sanity check before approving an AI verdict on an obscure fixture."
            onClick={() => onOpenSearch(item.googleSearchUrl)}
            disabled={!item.googleSearchUrl}
          >
            <ExternalLink className="w-3.5 h-3.5 text-zinc-400" />
          </Button>
          {showApproveReject && (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                title={
                  bucket === "decided"
                    ? "Lock in as human-approved. If there's an existing matcher/AI verdict, your call replaces it."
                    : "Approve — merge these two events and learn the aliases so future syncs auto-match them."
                }
                disabled={busy}
                onClick={() => onApprove(item)}
              >
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                title={
                  bucket === "decided"
                    ? "Reject — un-merge (if merged) and record as human-rejected. Your call replaces any matcher/AI verdict."
                    : "Reject — these are not the same event. Prevents the matcher from re-pairing them."
                }
                disabled={busy}
                onClick={() => onReject(item)}
              >
                <XCircle className="w-3.5 h-3.5 text-red-500" />
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            title="Delete the cached decision. Brings the pair back to 'To Review' on the next list refresh."
            disabled={busy || !d || d.decidedBy === "matcher"}
            onClick={() => onDelete(item)}
          >
            <Trash2 className="w-3.5 h-3.5 text-zinc-500" />
          </Button>
        </div>
      </div>
    </div>
  );
}

const TAB_TOOLTIPS: Record<BucketId, string> = {
  "to-review":
    "Pairs nobody has decided yet — your action queue.\n\n" +
    "What's here:\n" +
    "• Near-matches (70–85% team/league similarity)\n" +
    "• Unmatched single-provider events sharing a time slot with another provider\n" +
    "• AI verdicts that came back UNCERTAIN or <80% confident (AI tried but couldn't commit)\n\n" +
    "Actions per row: run Gemini Flash (default) or Gemini Pro (deep), approve (merge), reject (keep separate), or delete any cached AI attempt.\n\n" +
    "Filter chips below let you focus on fresh rows (no AI run) vs AI-unsure rows.",
  "auto-merged":
    "Events the matcher silently combined for you — merged at ≥85% team/league similarity, no AI or human touched them yet.\n\n" +
    "Why a separate tab: these are already in the dashboard working for you, so they don't block. Review them only when you have time. Fetched on demand so it doesn't slow the initial page load.\n\n" +
    "Actions per row:\n" +
    "• Approve — lock in as human-verified (moves to Decided)\n" +
    "• Reject — un-merge the combined event, split each provider's side back into its own event (moves to Decided)\n" +
    "• Delete — clear the decision and send the pair back to To Review for re-analysis",
  decided:
    "Pairs where someone explicitly decided — AI ≥80% confident OR a human approved/rejected.\n\n" +
    "The system respects every verdict:\n" +
    "• SAME → events are merged into one multi-provider event (dashboard compares odds side-by-side)\n" +
    "• DIFFERENT → events stay separate; matcher won't re-pair them on future syncs\n\n" +
    "Use the filter chips to focus by decider. Approve/reject overrides any AI verdict with a human one. Delete clears the verdict and sends the pair back to To Review.",
};

const PIPELINE_HELP =
  "How the pipeline works\n\n" +
  "1. Sync pulls events from every provider every 60s. Each provider has its own event IDs and spells team names differently.\n\n" +
  "2. The matcher scores each cross-provider pair inside a 1-minute time bucket (0.7 × team similarity + 0.3 × league similarity, alias-normalized):\n" +
  "   • ≥85% → auto-merges the events into one multi-provider entry → Auto-Merged\n" +
  "   • 70–85% → near-match → To Review\n" +
  "   • <70% with other providers in the same time slot → unmatched-candidate → To Review\n" +
  "   • <70% and nothing suggestive → ignored\n\n" +
  "3. \"Merge\" means the per-provider events collapse into one internal event with all providers' odds attached. That's what lets the dashboard compare prices and surface value bets.\n\n" +
  "4. On a To Review row you can run Gemini Flash (default) or Gemini Pro (deep reasoning):\n" +
  "   • SAME ≥80% → merges the events, records AI verdict → Decided\n" +
  "   • DIFFERENT ≥80% → no merge, records verdict (matcher won't re-pair them) → Decided\n" +
  "   • UNCERTAIN or <80% → no data change, verdict cached so you can see AI already tried → stays in To Review\n\n" +
  "5. Human approve/reject anywhere is final. It replaces any prior AI/matcher verdict and lands in Decided.";

// ============================================
// Model-tier segmented control
// ============================================
// Three-way toggle (Lite | Flash | Pro) that all analyze actions read from.
// We draw our own instead of shadcn Tabs because the active segment needs a
// model-specific accent color that fades to grey when disabled during a bulk
// run.

const TIER_ACCENT: Record<ModelTier, string> = {
  lite: "bg-zinc-700 text-zinc-100",
  flash: "bg-purple-600 text-white",
  pro: "bg-blue-500 text-white",
};

function ModelTierToggle({
  active,
  onSelect,
  disabled,
}: {
  active: ModelTier;
  onSelect: (tier: ModelTier) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Gemini model tier"
      className={cn(
        "inline-flex items-center rounded-md border border-zinc-800 bg-zinc-950/60 p-0.5",
        disabled && "opacity-60 pointer-events-none",
      )}
      title="Pick which Gemini tier every analyze action uses. Changes persist across sessions."
    >
      {MODEL_TIERS.map((tier) => {
        const isActive = active === tier;
        const { label, tagline } = MODEL_LABELS[tier];
        return (
          <button
            key={tier}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => onSelect(tier)}
            title={`${label} — ${tagline}`}
            className={cn(
              "h-6 px-2.5 text-[11px] font-medium rounded transition-colors",
              isActive
                ? TIER_ACCENT[tier]
                : "text-zinc-400 hover:text-zinc-200",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

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

  // Global model tier — persisted so your preference survives refreshes.
  // Every analyze action (per-row + bulk) uses this unless explicitly
  // overridden (e.g. the "Try Pro" chip on ambiguous verdicts).
  const [modelTier, setModelTier] = useState<ModelTier>("flash");
  useEffect(() => {
    try {
      const stored = localStorage.getItem("nahidarbx.gemini.model");
      if (stored === "lite" || stored === "flash" || stored === "pro") {
        setModelTier(stored);
      }
    } catch {
      // localStorage blocked (SSR, private mode) — stay on flash default.
    }
  }, []);
  const selectModel = useCallback((tier: ModelTier) => {
    setModelTier(tier);
    try {
      localStorage.setItem("nahidarbx.gemini.model", tier);
    } catch {
      // ignore storage failures
    }
  }, []);
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
      // keep the log bounded
      const combined = [...prev, next];
      return combined.length > 500
        ? combined.slice(combined.length - 500)
        : combined;
    });
    // auto-scroll to bottom on next paint
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

  // Lazy: first time the user opens Auto-Merged, fetch it. Re-fetch on
  // manual refresh while on that tab.
  useEffect(() => {
    if (bucket === "auto-merged" && autoMerged === null) {
      fetchAutoMerged();
    }
  }, [bucket, autoMerged, fetchAutoMerged]);

  // Always-on subscription to the bulk-run event stream.
  //
  // This is the single source of truth for bulk-analyze UI state: progress,
  // log, pause/abort. Running a new bulk from this tab and rehydrating after
  // a page refresh use the exact same code path, so a mid-run reload doesn't
  // lose visibility. The worker loop on the server keeps running regardless
  // of client connection state; events are buffered and replayed to late
  // subscribers.
  useEffect(() => {
    const es = new EventSource("/api/match-review/bulk-stream");

    const pairFromSnapshot = (decision?: CachedDecision): string => {
      const snap = decision?.snapshot;
      if (!snap) return decision?.key ?? "(unknown pair)";
      return pairLabel(snap.eventA, snap.eventB);
    };
    // Map a Gemini SDK model ID back to a tier label ("lite" / "flash" /
    // "pro") so the ticker row can render a colored model badge. Falls
    // back to undefined when the cached verdict predates tier tracking.
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

      // Structured verdict — the row renders badges and shows reasoning on hover.
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
        title: "", // structured renderer ignores title when `verdict` is set
        verdict: {
          verdict: d.verdict,
          confidence: d.confidence,
          modelTier: tier,
          cached: isCached,
          sideA: sides.sideA,
          sideB: sides.sideB,
        },
        reasoning: d.reasoning || undefined,
      };
    };

    // Track the active model (flash/pro) across events so `result` entries
    // format with the right label even on rehydration.
    let activeModel: string | null = null;

    // Replay-vs-live state. The server buffers recent events and replays
    // them to new subscribers, then emits a synthetic `hydrated` frame, then
    // tails live events. We silence user-facing toasts during replay so
    // switching tabs (which remounts this panel and triggers a fresh SSE
    // connection + replay) doesn't re-surface a `Bulk run finished` toast
    // for a run that already ended.
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
        const p = data as {
          model: string;
          total: number;
        };
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
        // Only surface the terminal toast for LIVE completions. A `done`
        // event that arrives while `hydrated` is still false is a replay of
        // a historical run (this panel was mounted after the run already
        // ended) — the user either saw the toast the first time or it never
        // ran in this browser session; either way, don't re-prompt.
        if (hydrated) {
          if (p.aborted) {
            toast.info("Bulk run aborted", {
              id: "bulk-run-done",
              description: `Processed ${p.analyzed + p.cached} of ${p.total} before stopping`,
            });
          } else if (p.errored > 0) {
            toast.warning("Bulk run finished with errors", {
              id: "bulk-run-done",
              description: `${p.analyzed} analyzed · ${p.cached} cached · ${p.errored} errors — see log for details`,
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
        // Refresh main data so newly-decided pairs move tabs. Only do this
        // for live completions — a replayed done happened long ago and the
        // main list has already been refreshed since.
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

    // EventSource uses named events for anything other than default "message".
    // Attach listeners for every type we care about.
    for (const type of Object.keys(handlers)) {
      es.addEventListener(type, (e) =>
        dispatch(type, (e as MessageEvent).data),
      );
    }

    return () => {
      es.close();
    };
    // Intentionally empty deps — we want exactly one long-lived subscription.
    // `appendLog`, `fetchData`, `fetchAutoMerged` are stable (useCallback).
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

  // Verdict counts honor the active decider filter so the two filter rows
  // feel composable — toggling "Human" should show how the Approved/Rejected
  // split looks for just those rows.
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

  // "AI unsure" = cache entry exists, not human-decided, not confident enough
  // to have moved into Decided. That's the exact predicate that keeps these
  // rows in To Review even after AI ran.
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

    // Sort To Review so fresh (no AI attempt) rows come first and
    // AI-unsure rows cluster at the bottom — the user knows those have
    // already been tried.
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
      const by = d.decidedBy === "human" ? "you" : "Gemini";
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

  // Refresh main list + Auto-Merged list (if already loaded). Used after
  // any mutation that can move a row between tabs.
  const refreshAll = useCallback(async () => {
    await fetchData();
    if (autoMerged !== null) {
      fetchAutoMerged();
    }
  }, [fetchData, autoMerged, fetchAutoMerged]);

  const analyzeOne = useCallback(
    async (item: ReviewItem, model: ModelTier, forceRefresh = false) => {
      setItemBusy(item.key, model);
      const modelLabel = `Gemini ${model}`;
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
          toast.error("AI analysis failed", { description: r.error });
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
        toast.error("AI analysis failed", {
          description: (err as Error).message,
        });
      } finally {
        setItemBusy(item.key, null);
      }
    },
    [refreshAll],
  );

  const bulkAnalyze = useCallback(
    async (model: ModelTier, forceRefresh = false) => {
      if (selected.size === 0) {
        toast.error("Nothing selected", {
          description: "Pick one or more rows to analyze",
        });
        return;
      }
      // Latest-decision-wins: AI can overwrite a human verdict on re-run.
      // The user asked for it — if they click Try Pro on a human-decided pair
      // they're explicitly saying "let the AI take another pass".
      const items = filtered.filter((it) => selected.has(it.key));
      const modelLabel = `Gemini ${model}`;
      const verb = forceRefresh ? "re-run" : "bulk analyze";

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
          // Try to surface the structured error (e.g. "already running").
          let msg = `HTTP ${res.status}`;
          try {
            const errJson = await res.json();
            if (errJson?.error) msg = errJson.error;
          } catch {
            // non-JSON body — keep the generic message
          }
          throw new Error(msg);
        }

        // Drain the response body without parsing: the server's worker loop
        // only keeps running while the Response stream has a consumer.
        // All UI updates come from the /bulk-stream SSE subscription in the
        // effect below — same code path used on refresh rehydration, so
        // there's exactly one source of truth.
        if (res.body) {
          const reader = res.body.getReader();
          void (async () => {
            try {
              while (true) {
                const { done } = await reader.read();
                if (done) break;
              }
            } catch {
              // Client disconnect or network hiccup — the bulk-stream SSE
              // remains the source of truth; the server's worker loop keeps
              // going and fans events out regardless.
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
    [selected, filtered, appendLog],
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
          // "info", not "success" — aborting isn't a positive outcome, and
          // the final "done" toast confirms completion.
          toast.info("Aborting bulk run", {
            description: "Workers will stop after the current item",
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
            // Events have rotated out of the live store between fetch and click —
            // verdict saved, merge will happen on the next sync.
            toast.warning("Verdict saved — merge deferred", {
              description: `${fixture} will merge on the next sync (events aren't currently in the store).`,
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

  return (
    <div className="h-full flex flex-col bg-zinc-900/30 border border-zinc-800 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-zinc-800/50 flex items-center gap-2">
        <button
          onClick={() => setBucket("to-review")}
          className={cn(
            "px-2.5 py-1 text-xs rounded transition-colors",
            bucket === "to-review"
              ? "bg-amber-500/15 text-amber-300 border border-amber-500/30"
              : "text-zinc-400 hover:text-zinc-200",
          )}
          title={TAB_TOOLTIPS["to-review"]}
        >
          To Review ({toReviewCount})
        </button>
        <button
          onClick={() => setBucket("auto-merged")}
          className={cn(
            "px-2.5 py-1 text-xs rounded transition-colors",
            bucket === "auto-merged"
              ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
              : "text-zinc-400 hover:text-zinc-200",
          )}
          title={TAB_TOOLTIPS["auto-merged"]}
        >
          Auto-Merged ({data.autoMergedCount})
          {bucket === "auto-merged" && isLoadingAutoMerged && (
            <Loader2 className="inline w-3 h-3 ml-1 animate-spin" />
          )}
        </button>
        <button
          onClick={() => setBucket("decided")}
          className={cn(
            "px-2.5 py-1 text-xs rounded transition-colors",
            bucket === "decided"
              ? "bg-sky-500/15 text-sky-300 border border-sky-500/30"
              : "text-zinc-400 hover:text-zinc-200",
          )}
          title={TAB_TOOLTIPS.decided}
        >
          Decided ({decidedCount})
        </button>

        <div className="ml-auto flex items-center gap-2">
          <span
            className="inline-flex items-center text-zinc-500 hover:text-zinc-300 cursor-help"
            title={PIPELINE_HELP}
          >
            <Info className="w-3.5 h-3.5" />
          </span>
          <span
            className="text-[10px] text-zinc-500"
            title={
              "Cached decisions summary.\n" +
              "• Total = every decision in cache.\n" +
              "• ✓ = pairs you approved. ✗ = pairs you rejected.\n" +
              "AI verdicts count in Total but not in ✓/✗."
            }
          >
            Cached: {data.stats.total} · ✓ {data.stats.humanApproved} · ✗{" "}
            {data.stats.humanRejected}
          </span>
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
            title="Refresh the current tab (Auto-Merged refreshes only when it's the active tab)."
          />
        </div>
      </div>

      {/* To Review filter chips */}
      {bucket === "to-review" && (
        <div
          className="px-3 py-1.5 border-b border-zinc-800/50 flex items-center gap-1 text-[11px]"
          title="Split the queue by whether an AI has already been tried on the row."
        >
          <span className="text-zinc-500 mr-1">Filter:</span>
          {(
            [
              {
                id: "all",
                label: `All (${toReviewCount})`,
                title:
                  "Every row in the queue, regardless of whether AI has tried.",
              },
              {
                id: "fresh",
                label: `No AI yet (${toReviewCounts.fresh})`,
                title:
                  "Rows no AI has analyzed — the cheapest wins. Start here.",
              },
              {
                id: "ai-unsure",
                label: `AI unsure (${toReviewCounts.aiUnsure})`,
                title:
                  "Rows where AI already ran but came back UNCERTAIN or below 80% confidence. These need a human call.",
              },
            ] as { id: ToReviewFilter; label: string; title: string }[]
          ).map((chip) => (
            <button
              key={chip.id}
              onClick={() => setToReviewFilter(chip.id)}
              title={chip.title}
              className={cn(
                "px-2 py-0.5 rounded border transition-colors",
                toReviewFilter === chip.id
                  ? "bg-zinc-800 border-zinc-600 text-zinc-100"
                  : "border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700",
              )}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}

      {/* Toolbar */}
      <div className="px-3 py-2 border-b border-zinc-800/50 flex flex-wrap items-center gap-2">
        {/* Selection controls — sit on the left, aligned with the row
            checkbox column they control. */}
        <div className="flex items-center gap-1.5 text-[11px] shrink-0">
          <button
            onClick={selectAll}
            disabled={filtered.length === 0}
            title={`Select every row currently shown (${filtered.length}).`}
            className="px-2 py-0.5 rounded border border-zinc-800 text-zinc-400 hover:text-zinc-100 hover:border-zinc-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-zinc-400 disabled:hover:border-zinc-800"
          >
            Select all{" "}
            <span className="tabular-nums text-zinc-500">
              ({filtered.length})
            </span>
          </button>
          {selected.size > 0 && (
            <>
              <button
                onClick={clearSelection}
                title="Clear the selection."
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

        <div className="relative w-[240px] shrink-0">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by team, competition…"
            className="h-7 pl-7 text-xs"
          />
        </div>

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

        <div className="flex-1" />

        {/* Model tier segmented control — applies to every analyze action
            (per-row + bulk). Choice persists in localStorage so your
            preference survives refreshes. */}
        <ModelTierToggle
          active={modelTier}
          onSelect={selectModel}
          disabled={isBulkBusy}
        />

        {/* Bulk action — single button that uses the active model tier. */}
        <div className="flex items-center gap-1.5">
          {(() => {
            const label = MODEL_LABELS[modelTier].label;
            const Icon =
              modelTier === "pro"
                ? Sparkles
                : modelTier === "lite"
                  ? Activity
                  : Cpu;
            const verb = bucket === "decided" ? "Re-run" : "Analyze";
            const title =
              bucket === "decided"
                ? `Re-run Gemini ${label} on the selected pairs. Replaces each existing verdict. Human-decided rows are skipped (delete those first to re-run).`
                : `Send all selected pairs to Gemini ${label}. Runs one at a time. Each verdict streams into the log panel.`;
            return (
              <Button
                size="sm"
                disabled={selected.size === 0 || isBulkBusy}
                onClick={() => bulkAnalyze(modelTier, bucket === "decided")}
                title={title}
                className={cn(
                  "h-7 px-3 text-xs font-medium rounded-md inline-flex items-center gap-1.5 transition-colors",
                  "bg-zinc-100 hover:bg-white text-zinc-900 shadow-[0_0_0_1px_rgba(255,255,255,0.1)]",
                  "disabled:bg-zinc-700/40 disabled:text-zinc-500 disabled:shadow-none",
                )}
              >
                {isBulkBusy ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Icon className="w-3.5 h-3.5" />
                )}
                {verb} {label}
                <span className="tabular-nums opacity-80">
                  ({selected.size})
                </span>
              </Button>
            );
          })()}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="h-full flex items-center justify-center text-sm text-zinc-500 text-center px-6">
            {bucket === "to-review"
              ? toReviewFilter === "fresh"
                ? "No fresh rows — every pair here has been AI-attempted."
                : toReviewFilter === "ai-unsure"
                  ? "No AI-unsure rows. Either AI hasn't run, or every attempt was confident enough to move to Decided."
                  : "Queue is empty — nothing needs a decision right now."
              : bucket === "auto-merged"
                ? isLoadingAutoMerged
                  ? "Loading…"
                  : "No matcher auto-merges to audit right now."
                : verdictFilter !== "all"
                  ? `No ${verdictFilter} decisions${deciderFilter !== "all" ? ` by ${deciderFilter === "ai" ? "AI" : "human"}` : ""} yet.`
                  : deciderFilter !== "all"
                    ? `No decisions by ${deciderFilter === "ai" ? "AI" : "human"} yet.`
                    : "No decisions recorded yet. As soon as AI or you decide, they'll show here."}
          </div>
        ) : bucket === "to-review" ? (
          // Within To Review, group unmatched-bucket candidates together so
          // related suggestions sit near each other. Near-matches come first
          // (no bucket), then bucket-grouped unmatched.
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
            const sortedGroups = Array.from(groups.entries()).sort(([a], [b]) =>
              a.localeCompare(b),
            );
            return (
              <>
                {ungrouped.map((item) => (
                  <ItemRow
                    key={item.key}
                    item={item}
                    bucket={bucket}
                    selected={selected.has(item.key)}
                    modelTier={modelTier}
                    onToggleSelect={toggleSelect}
                    onAnalyze={analyzeOne}
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
                  const autoCount = items.filter((i) => i.autoSuggested).length;
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
                          modelTier={modelTier}
                          onToggleSelect={toggleSelect}
                          onAnalyze={analyzeOne}
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
              modelTier={modelTier}
              onToggleSelect={toggleSelect}
              onAnalyze={analyzeOne}
              onApprove={approve}
              onReject={reject}
              onDelete={removeDecision}
              onOpenSearch={openSearch}
              busyAction={busy[item.key] || null}
            />
          ))
        )}
      </div>

      {/* Activity drawer — pinned to bottom of panel. Auto-hides when idle.
          Collapsed: a 32px strip with progress fill as background, icon +
          title of the latest entry, and (when a bulk run is active) the
          pause/abort controls. Click to expand upward into the full log.
          This keeps the list always visible during a run — the drawer
          never pushes rows off-screen. */}
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
  );
}

/**
 * Inline filter controls for the Decided tab. An icon-only toggle reveals
 * verdict + decider chip groups side-by-side in the toolbar. A badge on the
 * icon shows how many non-default filters are active.
 */
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
      <button
        onClick={() => setShow(!show)}
        className={cn(
          "relative h-7 w-7 rounded-md border inline-flex items-center justify-center transition-colors shrink-0",
          show || activeCount > 0
            ? "bg-blue-500/15 border-blue-500/40 text-blue-200"
            : "bg-zinc-900/60 border-zinc-800 text-zinc-400 hover:text-zinc-100 hover:border-zinc-700",
        )}
        title="Toggle verdict and decider filters."
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
