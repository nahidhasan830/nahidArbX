"use client";

import { useMemo, useState, useCallback } from "react";
import { format, parseISO } from "date-fns";
import { Loader2, MoreVertical, RefreshCw, Search, Trash2 } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { Checkbox } from "@/components/ui/checkbox";
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
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  MarketDisplay,
  formatScopedMarketText,
} from "@/components/ui/market-display";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DataTable } from "@/components/ui/data-table";
import { OddsMovementTooltipContent } from "@/components/spreadsheet/OddsMovementTooltip";
import { MovementDetailModal } from "./MovementDetailModal";
import { OutcomeStatusTooltipContent } from "./OutcomeStatusTooltip";
import { derive } from "@/lib/bets-history/derive";
import { buildGoogleAiModeUrl } from "@/lib/bets-history/google-verify";
import { prettySettledBy } from "@/lib/bets-history/resettle";
import type {
  Outcome,
  ValueBetRow,
  OddsMovementData,
} from "@/lib/bets-history/types";
import {
  getProviderShortName,
  getProviderTextInline,
} from "@/lib/providers/registry";
import { cn } from "@/lib/utils";
import { formatAtomLabel } from "@/lib/formatting/labels";
import { fmtDateTime, fmtSeen } from "@/lib/formatting/helpers";

function isOddsMovementData(v: unknown): v is OddsMovementData {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.sparkline) && typeof o.totalTicks === "number";
}

function getSharpOddsMovement(
  v: unknown,
  sharpProvider: string,
): OddsMovementData | null {
  if (isOddsMovementData(v)) return v;
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;

  const map = v as Record<string, unknown>;
  if (map[sharpProvider] && isOddsMovementData(map[sharpProvider])) {
    return map[sharpProvider] as OddsMovementData;
  }
  for (const val of Object.values(map)) {
    if (isOddsMovementData(val)) return val;
  }
  return null;
}

type SortKey =
  | "firstSeenAt"
  | "evPctMax"
  | "kellyFraction"
  | "tickCount"
  | "eventStartTime";
type SortDir = "asc" | "desc" | "none";

const PERSISTENCE_KEY = "bets-history-table:layout:v5";

const OUTCOME_PILL: Record<Outcome, string> = {
  pending: "bg-muted text-muted-foreground border border-border",
  won: "bg-emerald-500/15 text-emerald-500 border border-emerald-500/30",
  half_won: "bg-emerald-500/10 text-emerald-400 border border-emerald-500/25",
  lost: "bg-rose-500/15 text-rose-500 border border-rose-500/30",
  half_lost: "bg-rose-500/10 text-rose-400 border border-rose-500/25",
  void: "bg-slate-500/15 text-slate-400 border border-slate-500/30",
};

const OUTCOME_LABEL: Record<Outcome, string> = {
  pending: "Pending",
  won: "Won",
  half_won: "½ Won",
  lost: "Lost",
  half_lost: "½ Lost",
  void: "Void",
};

type Decorated = ValueBetRow & { _evPctMax: number; _kellyFraction: number };

const ML_DECISION_PILL: Record<string, string> = {
  boost:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  agree: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  shrink:
    "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  skip: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  none: "border-border bg-muted text-muted-foreground",
};

function cleanDecision(value: string | null | undefined) {
  if (value === "none") return "No ML";
  return value ? value.replace(/_/g, " ") : "No ML";
}

function formatSignedPct(value: number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function formatScore(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toFixed(3);
}

function formatMultiplier(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(2)}x`;
}

function formatStakePct(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(2)}%`;
}

export type BacktestTableProps = {
  rows: ValueBetRow[];
  loading?: boolean;
  selectedIds: Set<string>;
  onToggleRow: (id: string) => void;
  onToggleAllVisible: (ids: string[], check: boolean) => void;
  onMarkOutcome: (id: string, outcome: Outcome) => void;
  onDeleteBet: (id: string) => void;
  deletingIds?: Set<string>;
  onRerunRow: (id: string) => void;
  rerunningIds?: Set<string>;
  sortKey: SortKey;
  sortDir: SortDir;
  onSortChange: (key: SortKey) => void;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
  renderFooter?: () => React.ReactNode;
};

function SortableHeader({
  label,
  hint,
  sortKey,
  activeKey,
  activeDir,
  onSortChange,
  align = "left",
}: {
  label: string;
  hint: string;
  sortKey: SortKey;
  activeKey: SortKey;
  activeDir: SortDir;
  onSortChange: (key: SortKey) => void;
  align?: "left" | "right" | "center";
}) {
  const indicator =
    activeKey === sortKey && activeDir !== "none"
      ? activeDir === "desc"
        ? " ↓"
        : " ↑"
      : "";
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onSortChange(sortKey);
      }}
      className={cn(
        "cursor-pointer select-none hover:text-foreground inline-flex items-center",
        align === "right" && "justify-end",
        align === "center" && "justify-center",
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help inline-flex items-center">
            {label}
            {indicator}
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="max-w-[280px] whitespace-pre-line"
        >
          {hint}
        </TooltipContent>
      </Tooltip>
    </button>
  );
}

function StaticHeader({ label, hint }: { label: string; hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help inline-flex items-center">{label}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[280px] whitespace-pre-line">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}

export function BetsHistoryTable({
  rows,
  loading,
  selectedIds,
  onToggleRow,
  onToggleAllVisible,
  onMarkOutcome,
  onDeleteBet,
  deletingIds,
  onRerunRow,
  rerunningIds,
  sortKey,
  sortDir,
  onSortChange,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  renderFooter,
}: BacktestTableProps) {
  const [editingOutcomeId, setEditingOutcomeId] = useState<string | null>(null);
  const [movementRow, setMovementRow] = useState<Decorated | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Decorated | null>(null);

  const openMovement = useCallback((row: Decorated) => {
    setMovementRow(row);
  }, []);

  const closeMovement = useCallback((open: boolean) => {
    if (!open) setMovementRow(null);
  }, []);

  const decorated: Decorated[] = useMemo(
    () =>
      rows.map((r) => {
        const d = derive(r);
        return {
          ...r,
          _evPctMax: d.evPct,
          _kellyFraction: d.kellyFraction,
        };
      }),
    [rows],
  );

  const sorted = useMemo(() => {
    if (sortDir === "none") return decorated;
    const copy = [...decorated];
    const pick = (row: Decorated): string | number => {
      switch (sortKey) {
        case "firstSeenAt":
        case "eventStartTime":
          return row[sortKey];
        case "evPctMax":
          return row._evPctMax;
        case "kellyFraction":
          return row._kellyFraction;
        case "tickCount":
          return row.tickCount;
      }
    };
    copy.sort((a, b) => {
      const av = pick(a);
      const bv = pick(b);
      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "desc" ? bv.localeCompare(av) : av.localeCompare(bv);
      }
      return sortDir === "desc"
        ? (bv as number) - (av as number)
        : (av as number) - (bv as number);
    });
    return copy;
  }, [decorated, sortKey, sortDir]);

  const visibleIds = useMemo(() => sorted.map((r) => r.id), [sorted]);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someVisibleSelected = visibleIds.some((id) => selectedIds.has(id));

  const columns = useMemo<ColumnDef<Decorated, unknown>[]>(() => {
    return [
      {
        id: "select",
        header: () => (
          <Checkbox
            checked={
              allVisibleSelected
                ? true
                : someVisibleSelected
                  ? "indeterminate"
                  : false
            }
            onCheckedChange={(checked) =>
              onToggleAllVisible(visibleIds, checked === true)
            }
            aria-label="Select all visible"
            className="size-3.5"
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={selectedIds.has(row.original.id)}
            onCheckedChange={() => onToggleRow(row.original.id)}
            aria-label={`Select ${row.original.id}`}
            className="size-3.5"
          />
        ),
        size: 32,
        meta: { fixed: "left", initialSize: 32 },
      },
      {
        id: "ko",
        header: () => (
          <SortableHeader
            label="KO"
            hint={`Kickoff time. "Today HH:MM" / "Tomorrow HH:MM" / "Mon DD HH:MM".\n\nSort: click cycles desc → asc → none.`}
            sortKey="eventStartTime"
            activeKey={sortKey}
            activeDir={sortDir}
            onSortChange={onSortChange}
          />
        ),
        accessorKey: "eventStartTime",
        cell: ({ row }) => (
          <span className="text-[10px] text-muted-foreground">
            {fmtDateTime(row.original.eventStartTime)}
          </span>
        ),
        meta: { align: "center", initialSize: 110 },
      },
      {
        id: "event",
        header: () => (
          <StaticHeader
            label="Event"
            hint="The sporting event: home team vs away team. Hover for league and kickoff."
          />
        ),
        accessorFn: (row) => `${row.homeTeam} vs ${row.awayTeam}`,
        cell: ({ row }) => {
          const r = row.original;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="max-w-[300px] flex items-center gap-1.5 min-w-0 cursor-default">
                  <span className="font-medium truncate">{r.homeTeam}</span>
                  <span className="text-muted-foreground shrink-0">vs</span>
                  <span className="font-medium truncate">{r.awayTeam}</span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[320px] p-2.5">
                <div className="space-y-1 text-xs">
                  <p className="font-medium">
                    {r.homeTeam} vs {r.awayTeam}
                  </p>
                  <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-muted-foreground">
                    <span>League</span>
                    <span className="text-foreground">
                      {r.competition || "Unknown"}
                    </span>
                    <span>Kickoff</span>
                    <span className="text-foreground">
                      {fmtDateTime(r.eventStartTime)}
                    </span>
                  </div>
                </div>
              </TooltipContent>
            </Tooltip>
          );
        },
        meta: { initialSize: 260 },
      },
      {
        id: "market",
        header: () => (
          <StaticHeader
            label="Market"
            hint="Market type (e.g., MATCH_ODDS, OVER_UNDER 2.5). What you're actually betting on."
          />
        ),
        cell: ({ row }) => {
          const r = row.original;
          return (
            <MarketDisplay
              marketType={r.marketType}
              timeScope={r.timeScope}
              familyLine={r.familyLine}
              className="max-w-full text-[11px]"
            />
          );
        },
        meta: { align: "center", initialSize: 150 },
      },
      {
        id: "outcome",
        header: () => (
          <StaticHeader
            label="Outcome"
            hint="Which side of the market this value bet is on — e.g., Home Win, Over 2.5, Draw."
          />
        ),
        cell: ({ row }) => formatAtomLabel(row.original.atomLabel),
        meta: { align: "center", initialSize: 100 },
      },
      {
        id: "sharp",
        header: () => (
          <StaticHeader
            label="Sharp"
            hint="Sharp reference price from Pinnacle (vig-removed). The baseline the soft book is being compared against."
          />
        ),
        cell: ({ row }) => {
          const r = row.original;
          const sharpName = getProviderShortName(r.sharpProvider);
          return (
            <>
              <span
                className={cn(
                  "text-[10px] mr-1",
                  getProviderTextInline(r.sharpProvider),
                )}
              >
                {sharpName}
              </span>
              <span className="font-medium">{r.sharpOdds.toFixed(2)}</span>
            </>
          );
        },
        meta: { align: "center", initialSize: 95 },
      },
      {
        id: "soft",
        header: () => (
          <StaticHeader
            label="Soft"
            hint="The soft bookmaker's price at entry — what you'd actually bet at. Hover a cell for closing/peak breakdown."
          />
        ),
        cell: ({ row }) => {
          const r = row.original;
          const softName = getProviderShortName(r.softProvider);
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 cursor-help">
                  <span
                    className={cn(
                      "text-[10px]",
                      getProviderTextInline(r.softProvider),
                    )}
                  >
                    {softName}
                  </span>
                  <span className="font-medium">{r.softOdds.toFixed(2)}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="px-3 py-2">
                <div className="flex items-baseline justify-between gap-4 pb-1.5 mb-1.5 border-b border-border">
                  <span
                    className={cn(
                      "text-[10px] font-semibold",
                      getProviderTextInline(r.softProvider),
                    )}
                  >
                    {softName}
                  </span>
                  {r.softCommissionPct > 0 && (
                    <span className="text-[10px] opacity-60">
                      {r.softCommissionPct}% comm
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular-nums">
                  <span className="opacity-60">Entry (P&L)</span>
                  <span className="text-right font-medium">
                    {r.softOdds.toFixed(2)}
                  </span>
                  <span className="opacity-60">Closing sharp</span>
                  <span className="text-right">
                    {r.closingSharpOdds?.toFixed(2) ?? "—"}
                  </span>
                </div>
              </TooltipContent>
            </Tooltip>
          );
        },
        meta: { align: "center", initialSize: 95 },
      },
      {
        id: "movement",
        header: () => (
          <StaticHeader
            label="Δ"
            hint="Sharp-line price movement from opening to last observation. Hover for sparkline chart, opening→closing, and peak/trough range."
          />
        ),
        cell: ({ row }) => {
          const raw = row.original.oddsMovement;
          const m = getSharpOddsMovement(raw, row.original.sharpProvider);
          if (!m || m.sparkline.length < 2) {
            return (
              <span className="text-muted-foreground/40 text-[10px]">—</span>
            );
          }

          const first = m.sparkline[0][1];
          const last = m.sparkline[m.sparkline.length - 1][1];
          const changePct =
            first !== 0
              ? Math.round(((last - first) / first) * 10000) / 100
              : 0;
          const isUp = changePct > 0.01;
          const isDown = changePct < -0.01;
          const dirColor = isUp
            ? "text-emerald-400"
            : isDown
              ? "text-red-400"
              : "text-muted-foreground";
          const dirArrow = isUp ? "▲" : isDown ? "▼" : "";

          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => openMovement(row.original)}
                  className={`cursor-pointer font-mono text-[10px] tabular-nums hover:underline decoration-dotted underline-offset-2 ${dirColor}`}
                >
                  {dirArrow && (
                    <span className="text-[8px] mr-0.5 inline-block -translate-y-px">
                      {dirArrow}
                    </span>
                  )}
                  {changePct > 0 ? "+" : ""}
                  {changePct.toFixed(1)}%
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                className="p-0 overflow-hidden rounded-lg border border-border/60"
                sideOffset={6}
              >
                <OddsMovementTooltipContent
                  movement={m}
                  currentOdds={last}
                  onClickFullChart={() => openMovement(row.original)}
                />
              </TooltipContent>
            </Tooltip>
          );
        },
        meta: { align: "center", initialSize: 55 },
      },
      {
        id: "ev",
        header: () => (
          <SortableHeader
            label="EV %"
            hint={`Expected value as a percentage: (soft_odds × true_probability − 1) × 100. +2% means a 2% edge per unit staked.\n\nSort: click cycles desc → asc → none.`}
            sortKey="evPctMax"
            activeKey={sortKey}
            activeDir={sortDir}
            onSortChange={onSortChange}
            align="center"
          />
        ),
        accessorFn: (row) => row._evPctMax,
        cell: ({ row }) => {
          const ev = row.original._evPctMax;
          const evHigh = ev >= 5;
          const evMed = ev >= 2 && ev < 5;
          return (
            <span
              className={cn(
                "inline-flex items-center justify-center rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                evHigh &&
                  "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30",
                evMed &&
                  "bg-amber-500/15 text-amber-400 border border-amber-500/30",
                !evHigh &&
                  !evMed &&
                  "bg-muted text-muted-foreground border border-border",
              )}
            >
              {ev >= 0 ? "+" : ""}
              {ev.toFixed(2)}%
            </span>
          );
        },
        meta: { align: "center", initialSize: 80 },
      },
      {
        id: "kelly",
        header: () => (
          <SortableHeader
            label="Kelly %"
            hint={`Kelly-optimal share of your base balance, as a percentage. Classic Kelly = (b·p − q)/b where b = odds−1. Most pros bet ¼ or ½ Kelly in practice.\n\nSort: click cycles desc → asc → none.`}
            sortKey="kellyFraction"
            activeKey={sortKey}
            activeDir={sortDir}
            onSortChange={onSortChange}
            align="center"
          />
        ),
        accessorFn: (row) => row._kellyFraction,
        cell: ({ row }) => (
          <span>{(row.original._kellyFraction * 100).toFixed(2)}%</span>
        ),
        meta: { align: "center", initialSize: 85 },
      },
      {
        id: "mlAtPlace",
        header: () => (
          <StaticHeader
            label="ML@Place"
            hint="Frozen placement-time ML decision. Latest ML changes stay separate in the tooltip."
          />
        ),
        accessorFn: (row) => row.placedMlModelEdgePct,
        cell: ({ row }) => {
          const r = row.original;
          if (!r.placedAt) {
            return <span className="text-muted-foreground/40">—</span>;
          }

          const decision = r.placedMlDecision ?? "none";
          const hasSnapshot =
            r.placedMlScore != null ||
            r.placedMlModelEdgePct != null ||
            r.placedMlDecision != null ||
            r.placedMlKellyMultiplier != null;

          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "inline-flex h-5 cursor-help items-center gap-1 rounded-md border px-1.5 text-[10px] font-semibold tabular-nums",
                    ML_DECISION_PILL[decision] ?? ML_DECISION_PILL.none,
                  )}
                >
                  <span className="capitalize">{cleanDecision(decision)}</span>
                  {r.placedMlModelEdgePct != null && (
                    <span>{formatSignedPct(r.placedMlModelEdgePct, 1)}</span>
                  )}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[320px] p-2.5">
                <div className="space-y-2 text-xs">
                  <div>
                    <p className="mb-1 font-medium text-foreground">
                      Placement ML
                    </p>
                    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-muted-foreground">
                      <span>Score</span>
                      <span className="font-mono text-foreground">
                        {formatScore(r.placedMlScore)}
                      </span>
                      <span>Decision</span>
                      <span className="capitalize text-foreground">
                        {hasSnapshot
                          ? cleanDecision(r.placedMlDecision)
                          : "No snapshot"}
                      </span>
                      <span>Multiplier</span>
                      <span className="font-mono text-foreground">
                        {formatMultiplier(r.placedMlKellyMultiplier)}
                      </span>
                      <span>Model EV</span>
                      <span className="font-mono text-foreground">
                        {formatSignedPct(r.placedMlModelEdgePct, 2)}
                      </span>
                      <span>Booked odds</span>
                      <span className="font-mono text-foreground">
                        {r.odds == null ? "—" : r.odds.toFixed(2)}
                      </span>
                      <span>Model</span>
                      <span className="font-mono text-foreground">
                        {r.placedMlModelVersion == null
                          ? "—"
                          : `v${r.placedMlModelVersion}`}
                      </span>
                      <span>Placed</span>
                      <span className="text-foreground">
                        {format(parseISO(r.placedAt), "MMM d, yyyy HH:mm:ss")}
                      </span>
                    </div>
                  </div>
                  <div className="border-t border-border pt-2">
                    <p className="mb-1 font-medium text-foreground">
                      Latest ML
                    </p>
                    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-muted-foreground">
                      <span>Score</span>
                      <span className="font-mono text-foreground">
                        {formatScore(r.mlScore)}
                      </span>
                      <span>Stake</span>
                      <span className="font-mono text-foreground">
                        {formatStakePct(r.mlStakeFraction)}
                      </span>
                    </div>
                  </div>
                </div>
              </TooltipContent>
            </Tooltip>
          );
        },
        meta: { align: "center", initialSize: 112 },
      },
      {
        id: "tickCount",
        header: () => (
          <SortableHeader
            label="T"
            hint={`T = tick count. Number of times this bet has been re-observed during pre-match tracking. Higher T = more stable price.\n\nSort: click cycles desc → asc → none.`}
            sortKey="tickCount"
            activeKey={sortKey}
            activeDir={sortDir}
            onSortChange={onSortChange}
            align="center"
          />
        ),
        accessorKey: "tickCount",
        cell: ({ row }) => row.original.tickCount,
        meta: { align: "center", initialSize: 50 },
      },
      {
        id: "seen",
        header: () => (
          <SortableHeader
            label="Seen"
            hint={`When the bet was first detected — timestamp of the first sync cycle that saw this price.\n\nSort: click cycles desc → asc → none.`}
            sortKey="firstSeenAt"
            activeKey={sortKey}
            activeDir={sortDir}
            onSortChange={onSortChange}
          />
        ),
        accessorKey: "firstSeenAt",
        cell: ({ row }) => (
          <span className="text-muted-foreground text-[10px]">
            {fmtSeen(row.original.firstSeenAt)}
          </span>
        ),
        meta: { align: "center", initialSize: 70 },
      },
      {
        id: "status",
        header: () => (
          <StaticHeader
            label="Status"
            hint="Current settlement state: Pending, Won, Lost, Half-won, Half-lost, or Void."
          />
        ),
        cell: ({ row }) => {
          const r = row.original;
          if (editingOutcomeId === r.id) {
            return (
              <Select
                value={r.outcome}
                defaultOpen
                onValueChange={(v) => {
                  onMarkOutcome(r.id, v as Outcome);
                  setEditingOutcomeId(null);
                }}
                onOpenChange={(open) => {
                  if (!open) setEditingOutcomeId(null);
                }}
              >
                <SelectTrigger
                  size="sm"
                  className={cn(
                    "h-6 w-[82px] px-1.5 text-[10px] font-medium",
                    OUTCOME_PILL[r.outcome as Outcome],
                  )}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(
                    [
                      "pending",
                      "won",
                      "half_won",
                      "lost",
                      "half_lost",
                      "void",
                    ] as Outcome[]
                  ).map((o) => (
                    <SelectItem key={o} value={o}>
                      <span className="text-[11px]">{OUTCOME_LABEL[o]}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            );
          }
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setEditingOutcomeId(r.id)}
                  className={cn(
                    "inline-flex items-center justify-center h-6 w-[82px] rounded-md px-1.5 text-[10px] font-medium transition-colors hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-primary/40",
                    OUTCOME_PILL[r.outcome as Outcome],
                  )}
                >
                  {OUTCOME_LABEL[r.outcome as Outcome]}
                </button>
              </TooltipTrigger>
              <TooltipContent className="p-2.5">
                <OutcomeStatusTooltipContent
                  row={r}
                  outcomeLabel={OUTCOME_LABEL[r.outcome as Outcome]}
                />
              </TooltipContent>
            </Tooltip>
          );
        },
        meta: { align: "center", initialSize: 100 },
      },
      {
        id: "settledBy",
        header: () => (
          <StaticHeader
            label="Settled by"
            hint="Which source settled this bet — cache, ESPN, API-Football, SofaScore, or manual review."
          />
        ),
        cell: ({ row }) => {
          const r = row.original;
          if (!r.settledBySource) {
            return <span className="text-muted-foreground/60">—</span>;
          }
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-foreground/80 cursor-default">
                  {prettySettledBy(r.settledBySource)}
                </span>
              </TooltipTrigger>
              <TooltipContent>Source: {r.settledBySource}</TooltipContent>
            </Tooltip>
          );
        },
        meta: { align: "center", initialSize: 110 },
      },
      {
        id: "settledAt",
        header: () => (
          <StaticHeader
            label="Settled"
            hint="When settlement was finalised (timestamp)."
          />
        ),
        cell: ({ row }) => {
          const r = row.original;
          if (!r.settledAt) {
            return <span className="text-muted-foreground/60">—</span>;
          }
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-[10px] text-muted-foreground cursor-default">
                  {fmtSeen(r.settledAt)}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {format(parseISO(r.settledAt), "MMM d, yyyy HH:mm:ss")}
              </TooltipContent>
            </Tooltip>
          );
        },
        meta: { align: "center", initialSize: 70 },
      },
      {
        id: "actions",
        header: () => (
          <StaticHeader
            label="Actions"
            hint="Row actions: settle, verify, delete."
          />
        ),
        cell: ({ row }) => {
          const r = row.original;
          const running = rerunningIds?.has(r.id) ?? false;
          const deleting = deletingIds?.has(r.id) ?? false;

          return (
            <div className="flex items-center justify-center gap-0">
              {running || deleting ? (
                <div className="inline-flex items-center justify-center size-6">
                  <Loader2
                    className={cn(
                      "size-3.5 animate-spin",
                      deleting ? "text-destructive" : "text-muted-foreground",
                    )}
                  />
                </div>
              ) : (
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex items-center justify-center size-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                        >
                          <MoreVertical className="size-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent>Actions</TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="end" className="w-[190px] p-1">
                    <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground/70 px-2 py-1">
                      Settlement
                    </DropdownMenuLabel>
                    <DropdownMenuItem
                      onSelect={() => onRerunRow(r.id)}
                      className="cursor-pointer gap-2.5 rounded-md px-2 py-1.5"
                    >
                      <RefreshCw className="size-3.5 shrink-0 text-sky-400" />
                      <span className="text-[11px] font-medium">Re-Settle</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() =>
                        window.open(
                          buildGoogleAiModeUrl(r),
                          "_blank",
                          "noopener,noreferrer",
                        )
                      }
                      className="cursor-pointer gap-2.5 rounded-md px-2 py-1.5"
                    >
                      <Search className="size-3.5 shrink-0 text-amber-400" />
                      <span className="text-[11px] font-medium">
                        Google Search
                      </span>
                    </DropdownMenuItem>

                    <DropdownMenuSeparator className="my-1" />

                    <DropdownMenuItem
                      onSelect={() => setDeleteTarget(r)}
                      className="cursor-pointer gap-2.5 rounded-md px-2 py-1.5 text-destructive focus:text-destructive"
                    >
                      <Trash2 className="size-3.5 shrink-0" />
                      <span className="text-[11px] font-medium">
                        Delete bet
                      </span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          );
        },
        meta: { align: "center", fixed: "right", initialSize: 56 },
      },
    ];
  }, [
    allVisibleSelected,
    someVisibleSelected,
    visibleIds,
    selectedIds,
    editingOutcomeId,
    rerunningIds,
    sortKey,
    sortDir,
    onToggleRow,
    onToggleAllVisible,
    onMarkOutcome,
    deletingIds,
    onRerunRow,
    onSortChange,
    openMovement,
  ]);

  const movementData = movementRow
    ? (movementRow.oddsMovement as
        | Record<string, OddsMovementData>
        | OddsMovementData
        | null)
    : null;
  const movementEventLabel = movementRow
    ? `${movementRow.homeTeam} vs ${movementRow.awayTeam}`
    : "";
  const movementMarketLabel = movementRow
    ? `${movementRow.timeScope} · ${formatScopedMarketText({
        marketType: movementRow.marketType,
        familyLine: movementRow.familyLine,
        selection: movementRow.atomLabel,
      })}`
    : "";

  return (
    <>
      <DataTable<Decorated>
        data={sorted}
        columns={columns}
        getRowId={(row) => row.id}
        enableColumnResizing
        enableColumnOrdering
        enableVirtualization
        rowHeight={30}
        persistenceKey={PERSISTENCE_KEY}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        onLoadMore={onLoadMore}
        loading={loading}
        renderEmpty={() => "No value bets match the current filters."}
        renderLoading={() => (
          <span className="inline-flex items-center gap-2">
            <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-transparent" />
            Loading value bets…
          </span>
        )}
        renderFooter={renderFooter}
      />

      <MovementDetailModal
        open={movementRow !== null}
        onOpenChange={closeMovement}
        data={movementData}
        eventLabel={movementEventLabel}
        marketLabel={movementMarketLabel}
        marketType={movementRow?.marketType}
        timeScope={movementRow?.timeScope}
        familyLine={movementRow?.familyLine}
        selection={movementRow?.atomLabel}
        features={movementRow?.mlFeatures}
      />

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="size-4" />
              Delete Bet
            </DialogTitle>
            <DialogDescription>
              This will permanently remove the bet and its associated history
              data. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteTarget && (
            <div className="rounded-lg border border-border/60 bg-muted/30 p-4 space-y-3">
              <div className="text-sm font-semibold">
                {deleteTarget.homeTeam} vs {deleteTarget.awayTeam}
              </div>
              {deleteTarget.competition && (
                <div className="text-xs text-muted-foreground">
                  {deleteTarget.competition}
                </div>
              )}
              <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                <div className="text-muted-foreground">Market</div>
                <div className="min-w-0">
                  <MarketDisplay
                    marketType={deleteTarget.marketType}
                    timeScope={deleteTarget.timeScope}
                    familyLine={deleteTarget.familyLine}
                    className="max-w-full justify-start text-sm"
                  />
                </div>

                <div className="text-muted-foreground">Selection</div>
                <div>{formatAtomLabel(deleteTarget.atomLabel)}</div>

                <div className="text-muted-foreground">Kickoff</div>
                <div>{fmtDateTime(deleteTarget.eventStartTime)}</div>

                <div className="text-muted-foreground">Sharp</div>
                <div>
                  {getProviderShortName(deleteTarget.sharpProvider)}{" "}
                  <span className="font-medium tabular-nums">
                    {deleteTarget.sharpOdds.toFixed(2)}
                  </span>
                </div>

                <div className="text-muted-foreground">Soft</div>
                <div>
                  {getProviderShortName(deleteTarget.softProvider)}{" "}
                  <span className="font-medium tabular-nums">
                    {deleteTarget.softOdds.toFixed(2)}
                  </span>
                </div>

                <div className="text-muted-foreground">EV</div>
                <div className="font-medium tabular-nums text-emerald-400">
                  {deleteTarget._evPctMax >= 0 ? "+" : ""}
                  {deleteTarget._evPctMax.toFixed(2)}%
                </div>

                <div className="text-muted-foreground">Status</div>
                <div>
                  <span
                    className={cn(
                      "inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                      OUTCOME_PILL[deleteTarget.outcome as Outcome],
                    )}
                  >
                    {OUTCOME_LABEL[deleteTarget.outcome as Outcome]}
                  </span>
                </div>
              </div>
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteTarget) {
                  onDeleteBet(deleteTarget.id);
                  setDeleteTarget(null);
                }
              }}
            >
              Delete Permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
