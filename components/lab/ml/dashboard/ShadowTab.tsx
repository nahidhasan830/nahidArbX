"use client";

/**
 * ShadowTab — Shadow A/B analytics tab embedded in the ML Optimizer dashboard.
 *
 * Derived entirely from the `bets` table (no `shadow_decisions`). Shows
 * Kelly comparison stats, a Kelly scatter plot, per-row decisions, and
 * an outcome breakdown. Replaces the standalone `/lab/shadow-mode` page.
 *
 * Layout: everything lives inside the DataTable's toolbar slot so the
 * table fills the screen height and scrolls internally — no page-level
 * overflow.
 */

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { TermTooltip } from "@/components/ui/TermTooltip";
import { type ColumnDef } from "@tanstack/react-table";
import { formatMarketType, formatAtomLabel } from "@/lib/formatting/labels";
import { fmtSeen } from "@/lib/formatting/helpers";
import { MovementDetailModal } from "@/components/bets-history/MovementDetailModal";
import type { OddsMovementData } from "@/lib/bets-history/types";
import {
  getProviderShortName,
  getProviderTextInline,
} from "@/lib/providers/registry";
import {
  Calendar,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  TrendingUp,
  TrendingDown,
  Trophy,
  Zap,
  BarChart3,
  CircleDot,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DATE_PRESETS,
  resolvePreset,
  type DatePresetKey,
} from "@/lib/bets-history/date-presets";

// ── Types ───────────────────────────────────────────────────────────────────

interface ShadowDecision {
  id: string;
  betId: string;
  eventId: string;
  placedAt: string | null;
  kellyRaw: number | null;
  shadowKelly: number | null;
  mlKelly: number | null;
  mlMultiplier: number | null;
  pnlImpact: number | null;
  outcome: string | null;
  settledAt: string | null;
  createdAt: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  competition: string | null;
  eventStartTime: string | null;
  marketType: string | null;
  timeScope: string | null;
  familyLine: number | null;
  atomLabel: string | null;
  sharpProvider: string | null;
  sharpOdds: number | null;
  softProvider: string | null;
  softOdds: number | null;
  evPct: number | null;
  stake: number | null;
  pnl: number | null;
  mlScore: number | null;
  oddsMovement?: Record<string, OddsMovementData> | OddsMovementData | null;
}

interface ShadowStats {
  total: number;
  resolved: number;
  unresolved: number;
  avgMlMultiplier: string;
  avgKellyRaw: string;
  wins: number;
  losses: number;
  voids: number;
  winRate: string;
  /** Cumulative PnL under the configured baseline stake policy, in bankroll % */
  shadowPnlPct: string;
  /** Cumulative PnL under the ML-adjusted stake policy, in bankroll % */
  mlPnlPct: string;
  /** ML PnL minus baseline PnL, in bankroll % */
  pnlDeltaPct: string;
  /** Average ML× on winning bets */
  avgMlxWins: string | null;
  /** Average ML× on losing bets */
  avgMlxLosses: string | null;
}

type OutcomeBucket = "win" | "lose" | "void";

type MlDecision = "boost" | "shrink" | "skip" | "agree";

function classifyMlDecision(mult: number): MlDecision {
  if (mult < 0.1) return "skip";
  if (mult < 0.95) return "shrink";
  if (mult > 1.05) return "boost";
  return "agree";
}

const ML_DECISION_CONFIG: Record<
  MlDecision,
  { label: string; className: string; icon: string }
> = {
  boost: {
    label: "Boost",
    className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    icon: "↑",
  },
  shrink: {
    label: "Shrink",
    className: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    icon: "↓",
  },
  skip: {
    label: "Skip",
    className: "bg-red-500/15 text-red-400 border-red-500/30",
    icon: "✕",
  },
  agree: {
    label: "Agree",
    className: "bg-muted text-muted-foreground border-border",
    icon: "≈",
  },
};

// ── Constants ───────────────────────────────────────────────────────────────

const OUTCOME_PILL: Record<string, string> = {
  pending: "bg-muted text-muted-foreground border border-border",
  win: "bg-emerald-500/15 text-emerald-500 border border-emerald-500/30",
  half_win: "bg-emerald-500/10 text-emerald-400 border border-emerald-500/25",
  lose: "bg-rose-500/15 text-rose-500 border border-rose-500/30",
  half_lose: "bg-rose-500/10 text-rose-400 border border-rose-500/25",
  void: "bg-slate-500/15 text-slate-400 border border-slate-500/30",
};

const OUTCOME_LABEL: Record<string, string> = {
  pending: "Pending",
  win: "Won",
  half_win: "½ Won",
  lose: "Lost",
  half_lose: "½ Lost",
  void: "Void",
};

/** Preset groups for the popover grid — same buckets as BetsHistoryToolbar. */
const DATE_PRESET_GROUPS: { title: string; keys: DatePresetKey[] }[] = [
  {
    title: "Hours",
    keys: ["last1h", "last3h", "last6h", "last12h", "last24h", "last48h"],
  },
  {
    title: "Days",
    keys: [
      "today",
      "yesterday",
      "thisWeek",
      "lastWeek",
      "last3d",
      "last7d",
      "last15d",
    ],
  },
  {
    title: "Months",
    keys: ["thisMonth", "last30d", "last60d", "last90d", "all"],
  },
];

/** Short display labels for date presets. */
const COMPACT_LABELS: Partial<Record<DatePresetKey, string>> = {
  last1h: "1h",
  last3h: "3h",
  last6h: "6h",
  last12h: "12h",
  last24h: "24h",
  last48h: "48h",
  today: "Today",
  yesterday: "Yday",
  thisWeek: "Week",
  lastWeek: "Prev wk",
  last3d: "3d",
  last7d: "7d",
  last15d: "15d",
  thisMonth: "Month",
  last30d: "30d",
  last60d: "60d",
  last90d: "90d",
  all: "All",
  custom: "Custom",
};

function compactLabel(key: DatePresetKey): string {
  return (
    COMPACT_LABELS[key] ?? DATE_PRESETS.find((p) => p.key === key)?.label ?? key
  );
}

function formatOdds(value: number | null): string {
  return value == null ? "—" : value.toFixed(3);
}


// ── Columns ─────────────────────────────────────────────────────────────────

/** Columns need access to the openMovement callback — build via factory. */
function buildColumns(
  openMovement: (row: ShadowDecision) => void,
): ColumnDef<ShadowDecision, unknown>[] {
  return [
  {
    id: "detected",
    header: "Detected",
    accessorFn: (row) =>
      row.createdAt ? new Date(row.createdAt).getTime() : 0,
    meta: {
      align: "center",
      initialSize: 70,
      hint: "When the bet was first detected by the scanner. This is the column the date filter operates on.",
    },
    cell: ({ row }) => (
      <span className="text-[10px] text-muted-foreground">
        {row.original.createdAt ? fmtSeen(row.original.createdAt) : "—"}
      </span>
    ),
  },
  {
    id: "event",
    header: "Event",
    accessorFn: (row) =>
      row.homeTeam && row.awayTeam
        ? `${row.homeTeam} vs ${row.awayTeam}`
        : row.betId,
    meta: { initialSize: 200, hint: "The sporting event — home vs away." },
    cell: ({ row }) => {
      const r = row.original;
      if (!r.homeTeam || !r.awayTeam) {
        return (
          <span className="font-mono text-[10px] text-muted-foreground truncate">
            {r.betId}
          </span>
        );
      }
      return (
        <div className="max-w-[200px] flex items-center gap-1.5 min-w-0">
          <span className="font-medium truncate">{r.homeTeam}</span>
          <span className="text-muted-foreground shrink-0">vs</span>
          <span className="font-medium truncate">{r.awayTeam}</span>
          {r.competition && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-muted-foreground/70 text-[10px] truncate shrink min-w-0">
                  · {r.competition}
                </span>
              </TooltipTrigger>
              <TooltipContent>{r.competition}</TooltipContent>
            </Tooltip>
          )}
        </div>
      );
    },
  },
  {
    id: "market",
    header: "Market",
    meta: {
      align: "center",
      initialSize: 120,
      hint: "Market type (e.g., OVER_UNDER 2.5).",
    },
    cell: ({ row }) => {
      const r = row.original;
      if (!r.marketType)
        return <span className="text-muted-foreground/60">—</span>;
      return (
        <>
          <span className="text-muted-foreground text-[10px] mr-1">
            [{r.timeScope}]
          </span>
          <span>
            {formatMarketType(r.marketType)}
            {r.familyLine != null && ` ${r.familyLine}`}
          </span>
          {r.atomLabel && (
            <span className="ml-1 text-[10px] text-muted-foreground">
              · {r.atomLabel}
            </span>
          )}
        </>
      );
    },
  },
  {
    id: "sharpOdds",
    header: "Sharp Odds",
    accessorFn: (row) => row.sharpOdds ?? 0,
    meta: {
      align: "right",
      initialSize: 80,
      hint: "Sharp reference odds. Click to view odds movement chart.",
    },
    cell: ({ row }) => {
      const r = row.original;
      const provider = r.sharpProvider;
      const hasMovement = !!r.oddsMovement;
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => hasMovement && openMovement(r)}
              className={cn(
                "inline-flex items-center justify-end gap-1",
                hasMovement && "cursor-pointer hover:underline decoration-dotted underline-offset-2",
              )}
            >
              <span
                className={cn(
                  "text-[10px] font-semibold",
                  provider
                    ? getProviderTextInline(provider)
                    : "text-muted-foreground",
                )}
              >
                {provider ? getProviderShortName(provider) : "—"}
              </span>
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                {formatOdds(r.sharpOdds)}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{hasMovement ? "Click for odds movement chart" : "No movement data"}</TooltipContent>
        </Tooltip>
      );
    },
  },
  {
    id: "softOdds",
    header: "Soft Odds",
    accessorFn: (row) => row.softOdds ?? 0,
    meta: {
      align: "right",
      initialSize: 80,
      hint: "Soft bookmaker odds. Click to view odds movement chart.",
    },
    cell: ({ row }) => {
      const r = row.original;
      const provider = r.softProvider;
      const hasMovement = !!r.oddsMovement;
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => hasMovement && openMovement(r)}
              className={cn(
                "inline-flex items-center justify-end gap-1",
                hasMovement && "cursor-pointer hover:underline decoration-dotted underline-offset-2",
              )}
            >
              <span
                className={cn(
                  "text-[10px] font-semibold",
                  provider
                    ? getProviderTextInline(provider)
                    : "text-muted-foreground",
                )}
              >
                {provider ? getProviderShortName(provider) : "—"}
              </span>
              <span className="font-mono text-[10px] tabular-nums text-emerald-400">
                {formatOdds(r.softOdds)}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{hasMovement ? "Click for odds movement chart" : "No movement data"}</TooltipContent>
        </Tooltip>
      );
    },
  },
  {
    id: "ev",
    header: "Edge",
    accessorKey: "evPct",
    meta: {
      align: "right",
      initialSize: 60,
      hint: "Estimated edge at detection after soft-book commission. Positive means the offered price looked better than fair value.",
    },
    cell: ({ row }) => {
      const ev = row.original.evPct;
      if (ev == null)
        return <span className="text-muted-foreground/60">—</span>;
      return (
        <span
          className={cn(
            "font-mono text-[10px] tabular-nums",
            ev >= 5
              ? "text-emerald-400"
              : ev >= 2
                ? "text-amber-400"
                : "text-muted-foreground",
          )}
        >
          {ev > 0 ? "+" : ""}
          {ev.toFixed(2)}%
        </span>
      );
    },
  },
  {
    id: "mlScore",
    header: "Model Score",
    accessorKey: "mlScore",
    meta: {
      align: "right",
      initialSize: 60,
      hint: "How similar this bet looked to past profitable bets. 0 = weak, 1 = strong.",
    },
    cell: ({ row }) => {
      const s = row.original.mlScore;
      if (s == null) return <span className="text-muted-foreground/60">—</span>;
      const color =
        s >= 0.6
          ? "text-emerald-400"
          : s >= 0.4
            ? "text-amber-400"
            : "text-red-400";
      return (
        <span className={cn("font-mono text-[10px] tabular-nums", color)}>
          {s.toFixed(3)}
        </span>
      );
    },
  },
  {
    id: "mlDecision",
    header: "Model Call",
    accessorFn: (row) => row.mlMultiplier ?? 1,
    meta: {
      align: "center",
      initialSize: 70,
      hint: "The model's paper decision: increase, reduce, skip, or keep the normal stake.",
    },
    cell: ({ row }) => {
      const mult = row.original.mlMultiplier ?? 1;
      const decision = classifyMlDecision(mult);
      const cfg = ML_DECISION_CONFIG[decision];
      return (
        <span
          className={cn(
            "inline-flex items-center justify-center gap-0.5 h-5 rounded-md px-1.5 text-[10px] font-medium border",
            cfg.className,
          )}
        >
          <span>{cfg.icon}</span>
          <span>{cfg.label}</span>
        </span>
      );
    },
  },
  {
    id: "kellyRaw",
    header: "Base Stake",
    accessorFn: (row) => row.shadowKelly ?? 0,
    meta: {
      align: "right",
      initialSize: 70,
      hint: "The configured baseline stake after Kelly fraction and stake cap.",
    },
    cell: ({ row }) => (
      <span className="tabular-nums">
        {row.original.shadowKelly != null
          ? (row.original.shadowKelly * 100).toFixed(2) + "%"
          : "—"}
      </span>
    ),
  },
  {
    id: "mlMultiplier",
    header: "Stake Change",
    accessorKey: "mlMultiplier",
    meta: {
      align: "right",
      hint: "How much the model changed the normal stake. 1.000 means no change.",
      initialSize: 60,
    },
    cell: ({ row }) => {
      const mult = row.original.mlMultiplier ?? 1;
      const color =
        mult > 1.05
          ? "text-emerald-400"
          : mult < 0.95
            ? "text-red-400"
            : "text-muted-foreground";
      return (
        <span className={cn("font-mono text-[10px] tabular-nums", color)}>
          ×{mult.toFixed(3)}
        </span>
      );
    },
  },
  {
    id: "pnlImpact",
    header: "Profit Gap",
    accessorKey: "pnlImpact",
    meta: {
      align: "right",
      initialSize: 65,
      hint: "Paper profit difference between the model stake and the configured baseline stake. Positive means the model would have done better.",
    },
    cell: ({ row }) => {
      const impact = row.original.pnlImpact;
      if (impact == null)
        return <span className="text-muted-foreground/40">—</span>;
      const color =
        impact > 0.001
          ? "text-emerald-400"
          : impact < -0.001
            ? "text-red-400"
            : "text-muted-foreground";
      return (
        <span className={cn("font-mono text-[10px] tabular-nums", color)}>
          {impact > 0 ? "+" : ""}
          {impact.toFixed(3)}%
        </span>
      );
    },
  },
  {
    id: "status",
    header: "Status",
    meta: { align: "center", initialSize: 75, hint: "Settlement outcome." },
    cell: ({ row }) => {
      const outcome = row.original.outcome ?? "pending";
      return (
        <span
          className={cn(
            "inline-flex items-center justify-center h-6 w-[72px] rounded-md px-1.5 text-[10px] font-medium",
            OUTCOME_PILL[outcome],
          )}
        >
          {OUTCOME_LABEL[outcome] ?? outcome}
        </span>
      );
    },
  },
  {
    id: "placed",
    header: "📌",
    meta: {
      align: "center",
      initialSize: 35,
      hint: "Whether this bet was actually placed with real money.",
    },
    cell: ({ row }) => {
      const placed = row.original.placedAt != null;
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                "inline-flex items-center justify-center size-4 rounded-full text-[8px]",
                placed
                  ? "bg-emerald-500/20 text-emerald-400"
                  : "bg-muted text-muted-foreground/40",
              )}
            >
              {placed ? "✓" : "·"}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {placed ? "Placed with real money" : "Not placed — detection only"}
          </TooltipContent>
        </Tooltip>
      );
    },
  },
];
}

// ── Hook ────────────────────────────────────────────────────────────────────

function useShadowData(preset: DatePresetKey) {
  const range = useMemo(() => resolvePreset(preset), [preset]);

  const statsQuery = useQuery<ShadowStats>({
    queryKey: ["shadow", "stats", preset],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (range.from) params.set("from", range.from);
      if (range.to) params.set("to", range.to);
      params.set("limit", "1");
      params.set("aggregate", "true");
      const res = await fetch(`/api/shadow?${params}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const rowsQuery = useQuery<{ rows: ShadowDecision[] }>({
    queryKey: ["shadow", "rows", preset],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (range.from) params.set("from", range.from);
      if (range.to) params.set("to", range.to);
      params.set("limit", "500");
      const res = await fetch(`/api/shadow?${params}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
  });

  return {
    stats: statsQuery.data ?? null,
    decisions: rowsQuery.data?.rows ?? [],
    loading: statsQuery.isLoading || rowsQuery.isLoading,
    refetch: () => {
      void statsQuery.refetch();
      void rowsQuery.refetch();
    },
    isFetching: statsQuery.isFetching || rowsQuery.isFetching,
  };
}

// ── Toolbar ─────────────────────────────────────────────────────────────────

function ShadowToolbar({
  preset,
  onPresetChange,
  stats,
  decisions,
  isFetching,
  onRefetch,
}: {
  preset: DatePresetKey;
  onPresetChange: (v: DatePresetKey) => void;
  stats: ShadowStats | null;
  decisions: ShadowDecision[];
  isFetching: boolean;
  onRefetch: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasCharts = stats != null && stats.resolved > 0;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="border-b border-border bg-muted/25 px-3 py-2">
        <p className="text-sm leading-relaxed text-muted-foreground">
          <TermTooltip term="shadow_mode">Shadow mode</TermTooltip> compares the
          normal stake with the model-adjusted stake without changing real
          placement. Use this tab to see whether the model would have skipped,
          reduced, or increased stakes before giving it more authority.
        </p>
      </div>
      {/* Row 1: date preset + inline stats + refresh */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-muted/40">
        {/* Date preset popover — reuses the same chip-grid pattern as BetsHistoryToolbar */}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px] gap-1.5 font-normal"
            >
              <Calendar className="size-3 opacity-60" />
              <span>Detected</span>
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] leading-none font-medium",
                  preset !== "all"
                    ? "border-primary/35 bg-primary/12 text-foreground"
                    : "border-border/70 bg-muted/45 text-muted-foreground",
                )}
              >
                {compactLabel(preset)}
              </span>
              <ChevronDown className="size-3 opacity-60" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[300px] rounded-xl p-2.5">
            <div className="space-y-2">
              {DATE_PRESET_GROUPS.map((group) => (
                <div key={group.title} className="space-y-1">
                  <div className="px-0.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    {group.title}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {group.keys.map((key) => {
                      const selected = preset === key;
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => onPresetChange(key)}
                          aria-pressed={selected}
                          className={cn(
                            "inline-flex items-center rounded-lg border px-2 py-1 text-[11px] font-medium transition-all duration-150",
                            selected
                              ? "border-primary/40 bg-primary/14 text-foreground shadow-sm ring-1 ring-primary/20"
                              : "border-border/70 bg-background/70 text-muted-foreground hover:border-foreground/10 hover:bg-muted/60 hover:text-foreground",
                          )}
                        >
                          {compactLabel(key)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        <div className="w-px h-5 bg-border shrink-0" />

        {/* Inline stat chips */}
        {stats && (
          <div className="flex items-center gap-2.5 text-[11px] text-muted-foreground whitespace-nowrap overflow-x-auto min-w-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1">
                  <BarChart3 className="size-3 text-cyan-400/70" />
                  <span className="font-medium text-cyan-400 tabular-nums">
                    {stats.total}
                  </span>
                  <span className="text-muted-foreground/70">bets</span>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                Total shadow-scored bets in the selected time range
              </TooltipContent>
            </Tooltip>

            <span className="opacity-40">·</span>

            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1">
                  <Trophy className="size-3 text-emerald-400/70" />
                  <span className="font-medium text-emerald-400 tabular-nums">
                    {stats.winRate}
                  </span>
                  <span className="text-muted-foreground/70">win rate</span>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                Win rate across {stats.resolved} resolved bets ({stats.wins}W /{" "}
                {stats.losses}L / {stats.voids}V)
              </TooltipContent>
            </Tooltip>

            <span className="opacity-40">·</span>

            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1">
                  <Zap className="size-3 text-amber-400/70" />
                  <span className="font-medium text-foreground tabular-nums">
                    ×{parseFloat(stats.avgMlMultiplier || "1").toFixed(3)}
                  </span>
                  <span className="text-muted-foreground/70">avg model ×</span>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                Average model multiplier: how much the model changes the normal
                stake on average.
              </TooltipContent>
            </Tooltip>

            {/* ── PnL Comparison (the bottom-line metric) ── */}
            {stats.pnlDeltaPct != null && (
              <>
                <div className="w-px h-4 bg-border/60 shrink-0" />

                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1">
                      {parseFloat(stats.pnlDeltaPct) >= 0 ? (
                        <TrendingUp className="size-3 text-emerald-400/70" />
                      ) : (
                        <TrendingDown className="size-3 text-red-400/70" />
                      )}
                      <span
                        className={cn(
                          "font-semibold tabular-nums",
                          parseFloat(stats.pnlDeltaPct) > 0.01
                            ? "text-emerald-400"
                            : parseFloat(stats.pnlDeltaPct) < -0.01
                              ? "text-red-400"
                              : "text-muted-foreground",
                        )}
                      >
                        {parseFloat(stats.pnlDeltaPct) > 0 ? "+" : ""}
                        {parseFloat(stats.pnlDeltaPct).toFixed(2)}%
                      </span>
                      <span className="text-muted-foreground/70">model gap</span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[280px]">
                    <div className="space-y-1 text-xs">
                      <p className="font-medium">
                        Model stake vs configured baseline paper profit
                      </p>
                      <div className="flex justify-between gap-4">
                        <span className="text-muted-foreground">
                          Configured baseline:
                        </span>
                        <span className="tabular-nums">
                          {parseFloat(stats.shadowPnlPct).toFixed(3)}%
                        </span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span className="text-muted-foreground">
                          Model strategy:
                        </span>
                        <span className="tabular-nums">
                          {parseFloat(stats.mlPnlPct).toFixed(3)}%
                        </span>
                      </div>
                      <div className="flex justify-between gap-4 border-t border-border pt-1">
                        <span className="font-medium">Delta:</span>
                        <span
                          className={cn(
                            "font-semibold tabular-nums",
                            parseFloat(stats.pnlDeltaPct) > 0
                              ? "text-emerald-400"
                              : "text-red-400",
                          )}
                        >
                          {parseFloat(stats.pnlDeltaPct) > 0 ? "+" : ""}
                          {parseFloat(stats.pnlDeltaPct).toFixed(3)}%
                        </span>
                      </div>
                      <p className="text-muted-foreground/70 text-[10px] pt-0.5">
                        Positive means the model would have done better.
                      </p>
                    </div>
                  </TooltipContent>
                </Tooltip>
              </>
            )}

            {/* ── Outcome-conditional stake changes ── */}
            {(stats.avgMlxWins != null || stats.avgMlxLosses != null) && (
              <>
                <div className="w-px h-4 bg-border/60 shrink-0" />

                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1.5">
                      <CircleDot className="size-3 text-violet-400/70" />
                      {stats.avgMlxWins != null && (
                        <span className="inline-flex items-center gap-0.5">
                          <span className="text-emerald-400 font-medium tabular-nums">
                            ×
                            {parseFloat(stats.avgMlxWins).toFixed(2)}
                          </span>
                          <span className="text-emerald-400/50 text-[9px]">
                            W
                          </span>
                        </span>
                      )}
                      {stats.avgMlxLosses != null && (
                        <span className="inline-flex items-center gap-0.5">
                          <span className="text-red-400 font-medium tabular-nums">
                            ×
                            {parseFloat(stats.avgMlxLosses).toFixed(2)}
                          </span>
                          <span className="text-red-400/50 text-[9px]">L</span>
                        </span>
                      )}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[260px]">
                    <p className="text-xs">
                      Average model stake change on wins vs losses. If the win
                      multiplier is higher, the model is backing stronger bets
                      and reducing weaker ones.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </>
            )}
          </div>
        )}

        <div className="flex-1" />

        {/* Expand charts toggle */}
        {hasCharts && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px] gap-1 font-normal"
                onClick={() => setExpanded((v) => !v)}
              >
                Charts
                {expanded ? (
                  <ChevronUp className="size-3" />
                ) : (
                  <ChevronDown className="size-3" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {expanded ? "Hide" : "Show"} stake comparison and outcome breakdown
            </TooltipContent>
          </Tooltip>
        )}

        {/* Refresh */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={onRefetch}
              disabled={isFetching}
            >
              <RefreshCw
                className={cn("size-3.5", isFetching && "animate-spin")}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh shadow data</TooltipContent>
        </Tooltip>
      </div>

      {/* Row 2 (collapsible): Kelly scatter + Outcome breakdown */}
      {expanded && hasCharts && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 px-3 py-2 border-b border-border bg-muted/30">
          <ChartPanel
            title="Stake Comparison"
            hint="Each dot is a scored bet. X is the normal stake, Y is the model-adjusted stake. Dots above the diagonal mean the model wanted a bigger stake."
          >
            <KellyScatter decisions={decisions} />
          </ChartPanel>
          <ChartPanel
            title="Outcome Breakdown"
            hint="Win, loss, and void distribution with the average model stake change in each group."
          >
            <OutcomeBreakdown stats={stats!} decisions={decisions} />
          </ChartPanel>
        </div>
      )}
    </TooltipProvider>
  );
}

// ── Chart Panel (inline, no card wrapper) ───────────────────────────────────

function ChartPanel({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/40 p-2.5">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          {title}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex size-3.5 cursor-help items-center justify-center rounded-full bg-muted border border-border text-muted-foreground text-[9px]">
              ?
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-[280px]">{hint}</TooltipContent>
        </Tooltip>
      </div>
      {children}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

export function ShadowTab() {
  const [preset, setPreset] = useState<DatePresetKey>("last30d");
  const { stats, decisions, loading, refetch, isFetching } =
    useShadowData(preset);

  // ── Movement modal state ────────────────────────────────────────────────
  const [movementRow, setMovementRow] = useState<ShadowDecision | null>(null);

  const openMovement = useCallback((row: ShadowDecision) => {
    setMovementRow(row);
  }, []);

  const closeMovement = useCallback((open: boolean) => {
    if (!open) setMovementRow(null);
  }, []);

  const columns = useMemo(() => buildColumns(openMovement), [openMovement]);

  // Derive modal data from the selected row
  const movementData = movementRow?.oddsMovement ?? null;
  const movementEventLabel = movementRow
    ? movementRow.homeTeam && movementRow.awayTeam
      ? `${movementRow.homeTeam} vs ${movementRow.awayTeam}`
      : movementRow.betId
    : "";
  const movementMarketLabel = movementRow
    ? `[${movementRow.timeScope}] ${formatMarketType(movementRow.marketType ?? "")}${movementRow.familyLine != null ? ` ${movementRow.familyLine}` : ""}${movementRow.atomLabel ? ` · ${formatAtomLabel(movementRow.atomLabel)}` : ""}`
    : "";

  const toolbar = (
    <ShadowToolbar
      preset={preset}
      onPresetChange={setPreset}
      stats={stats}
      decisions={decisions}
      isFetching={isFetching}
      onRefetch={refetch}
    />
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <DataTable<ShadowDecision>
        data={decisions}
        columns={columns}
        getRowId={(row) => row.id}
        loading={loading}
        enableSorting
        enableColumnResizing
        enableColumnOrdering
        enableVirtualization
        rowHeight={30}
        persistenceKey="shadow-ab-decisions-v6"
        toolbar={toolbar}
        renderEmpty={() => "No model-scored bets found for this period."}
        rowClassName={(row) => {
          const outcome = row.outcome;
          if (outcome === "win" || outcome === "half_win")
            return "bg-emerald-500/[0.03]";
          if (outcome === "lose" || outcome === "half_lose")
            return "bg-rose-500/[0.03]";
          return undefined;
        }}
      />

      {/* Odds Movement Chart Modal */}
      <MovementDetailModal
        open={movementRow !== null}
        onOpenChange={closeMovement}
        data={movementData as Record<string, OddsMovementData> | OddsMovementData | null}
        eventLabel={movementEventLabel}
        marketLabel={movementMarketLabel}
        mlMeta={
          movementRow
            ? {
                mlScore: movementRow.mlScore,
                kellyRaw: movementRow.kellyRaw,
                mlMultiplier: movementRow.mlMultiplier,
                evPct: movementRow.evPct,
              }
            : null
        }
      />
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function KellyScatter({ decisions }: { decisions: ShadowDecision[] }) {
  const valid = decisions.filter(
    (d) =>
      d.kellyRaw != null &&
      d.mlKelly != null &&
      d.kellyRaw > 0 &&
      d.mlKelly > 0,
  );
  if (valid.length === 0)
    return (
      <p className="text-muted-foreground text-[10px] py-6 text-center">
        No data points to plot.
      </p>
    );

  const maxKelly = Math.max(
    ...valid.map((d) => Math.max(d.kellyRaw!, d.mlKelly!)),
  );

  return (
    <div className="relative h-36 bg-white/[0.02] rounded border border-white/[0.05] overflow-hidden">
      {/* Diagonal guide */}
      <div
        className="absolute border-t border-dashed border-white/10 pointer-events-none origin-bottom-left"
        style={{
          bottom: 0,
          left: 0,
          width: "141%",
          transform: "rotate(-45deg)",
        }}
      />
      {valid.map((d) => {
        const x = (d.kellyRaw! / maxKelly) * 100;
        const y = 100 - (d.mlKelly! / maxKelly) * 100;
        return (
          <Tooltip key={d.id}>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  "absolute w-2 h-2 rounded-full border border-white/40 cursor-help",
                  d.outcome === "win"
                    ? "bg-emerald-500"
                    : d.outcome === "lose"
                      ? "bg-red-500"
                      : d.outcome === "void"
                        ? "bg-slate-500"
                        : "bg-amber-400",
                )}
                style={{
                  left: `${x}%`,
                  top: `${y}%`,
                  transform: "translate(-50%, -50%)",
                  opacity: 0.8,
                }}
              />
            </TooltipTrigger>
            <TooltipContent className="text-[10px]">
              <div className="font-medium">
                {d.homeTeam && d.awayTeam
                  ? `${d.homeTeam} vs ${d.awayTeam}`
                  : d.betId}
              </div>
              <div className="text-muted-foreground">
                Base: {(d.kellyRaw! * 100).toFixed(2)}% · model:{" "}
                {(d.mlKelly! * 100).toFixed(2)}% · {d.outcome ?? "pending"}
              </div>
            </TooltipContent>
          </Tooltip>
        );
      })}
      <div className="absolute bottom-1 left-1 text-[8px] text-white/30 font-mono">
        Base stake →
      </div>
      <div className="absolute top-1 left-1 text-[8px] text-white/30 font-mono">
        ↑ Model stake
      </div>
    </div>
  );
}

function OutcomeBreakdown({
  stats,
  decisions,
}: {
  stats: ShadowStats;
  decisions: ShadowDecision[];
}) {
  const byOutcome = decisions.reduce<
    Record<OutcomeBucket, { mlMultipliers: number[] }>
  >((acc, d) => {
    const bucket =
      d.outcome === "win" || d.outcome === "half_win"
        ? "win"
        : d.outcome === "lose" || d.outcome === "half_lose"
          ? "lose"
          : d.outcome === "void"
            ? "void"
            : null;
    if (bucket && d.mlMultiplier != null) {
      acc[bucket].mlMultipliers.push(d.mlMultiplier);
    }
    return acc;
  }, {
    win: { mlMultipliers: [] },
    lose: { mlMultipliers: [] },
    void: { mlMultipliers: [] },
  });

  const outcomes: Array<{
    key: OutcomeBucket;
    label: string;
    count: number;
  }> = [
    { key: "win", label: "Wins", count: stats.wins },
    { key: "lose", label: "Losses", count: stats.losses },
    { key: "void", label: "Voids", count: stats.voids },
  ];
  return (
    <div className="space-y-2.5">
      {outcomes.map((o) => {
        const data = byOutcome[o.key];
        const pct = stats.resolved > 0 ? (o.count / stats.resolved) * 100 : 0;
        const avgMult =
          data.mlMultipliers.length > 0
            ? data.mlMultipliers.reduce((a, b) => a + b, 0) /
              data.mlMultipliers.length
            : null;

        return (
          <div key={o.key} className="space-y-0.5">
            <div className="flex items-center justify-between text-[10px]">
              <span className="font-medium text-white/80">{o.label}</span>
              <span className="font-mono text-white/60 tabular-nums">
                {o.count} ({pct.toFixed(1)}%)
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  o.key === "win"
                    ? "bg-emerald-500"
                    : o.key === "lose"
                      ? "bg-red-500"
                      : "bg-slate-500",
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
            {avgMult != null && (
              <p className="text-[9px] text-white/40 font-mono">
                Avg model change: ×{avgMult.toFixed(3)}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
