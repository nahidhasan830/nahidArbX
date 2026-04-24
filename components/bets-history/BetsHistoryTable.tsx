"use client";

import { useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
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
import { DataTable } from "@/components/ui/data-table";
import { RerunButton, type RerunChoice } from "./AiSettleDialog";
import { derive } from "@/lib/bets-history/derive";
import { buildGoogleAiModeUrl } from "@/lib/bets-history/google-verify";
import { canResettle, prettySettledBy } from "@/lib/bets-history/resettle";
import type { Outcome, ValueBetRow } from "@/lib/bets-history/types";
import { cn } from "@/lib/utils";
import { formatMarketType, formatAtomLabel } from "@/lib/formatting/labels";
import { fmtDateTime, fmtSeen } from "@/lib/formatting/helpers";

type SortKey =
  | "firstSeenAt"
  | "evPctMax"
  | "kellyFraction"
  | "tickCount"
  | "eventStartTime";
type SortDir = "asc" | "desc" | "none";

const PERSISTENCE_KEY = "bets-history-table:layout:v1";

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

const PROVIDER_SHORT: Record<string, string> = {
  "ninewickets-exchange": "9W-Ex",
  "ninewickets-sportsbook": "9W-SB",
  betconstruct: "BC",
  pinnacle: "Pinnacle",
};

const PROVIDER_COLOR: Record<string, string> = {
  "ninewickets-exchange": "text-purple-400 dark:text-purple-300",
  "ninewickets-sportsbook": "text-amber-400 dark:text-amber-300",
  betconstruct: "text-sky-400 dark:text-sky-300",
  pinnacle: "text-cyan-400 dark:text-cyan-300",
};

type Decorated = ValueBetRow & { _evPctMax: number; _kellyFraction: number };

export type BacktestTableProps = {
  rows: ValueBetRow[];
  loading?: boolean;
  selectedIds: Set<string>;
  onToggleRow: (id: string) => void;
  onToggleAllVisible: (ids: string[], check: boolean) => void;
  onMarkOutcome: (id: string, outcome: Outcome) => void;
  onRerunRow: (id: string, choice: RerunChoice) => void;
  rerunningIds?: Set<string>;
  sortKey: SortKey;
  sortDir: SortDir;
  onSortChange: (key: SortKey) => void;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
};

// Clickable header for parent-controlled sort. Cycles via the parent's
// `onSortChange` (desc → asc → none), not DataTable's internal state — we keep
// this one sort axis controlled so it persists to localStorage alongside
// filter prefs via useBetsHistoryPrefs.
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
  onRerunRow,
  rerunningIds,
  sortKey,
  sortDir,
  onSortChange,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: BacktestTableProps) {
  const [editingOutcomeId, setEditingOutcomeId] = useState<string | null>(null);

  // EV displayed in the row is evPctFirst — the EV at the entry price we'd
  // have actually bet at. Using evPctMax (best price ever observed) would
  // inflate the headline number, since we rarely actually get the peak price.
  // The legacy field name `_evPctMax` is kept to avoid a cascading rename
  // through the sort key persisted in localStorage.
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
            hint="The sporting event — home team vs away team, plus competition."
          />
        ),
        accessorFn: (row) => `${row.homeTeam} vs ${row.awayTeam}`,
        cell: ({ row }) => {
          const r = row.original;
          return (
            <div className="max-w-[380px] flex items-center gap-1.5 min-w-0">
              <span className="font-medium truncate" title={r.homeTeam}>
                {r.homeTeam}
              </span>
              <span className="text-muted-foreground shrink-0">vs</span>
              <span className="font-medium truncate" title={r.awayTeam}>
                {r.awayTeam}
              </span>
              {r.competition && (
                <span
                  className="text-muted-foreground/70 text-[10px] truncate shrink min-w-0"
                  title={r.competition}
                >
                  · {r.competition}
                </span>
              )}
            </div>
          );
        },
        meta: { initialSize: 320 },
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
            <>
              <span className="text-muted-foreground text-[10px] mr-1">
                [{r.timeScope}]
              </span>
              <span>
                {formatMarketType(r.marketType)}
                {r.familyLine != null && ` ${r.familyLine}`}
              </span>
            </>
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
          const sharpName = PROVIDER_SHORT[r.sharpProvider] ?? r.sharpProvider;
          return (
            <>
              <span
                className={cn(
                  "text-[10px] mr-1",
                  PROVIDER_COLOR[r.sharpProvider],
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
          const softName = PROVIDER_SHORT[r.softProvider] ?? r.softProvider;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 cursor-help">
                  <span
                    className={cn(
                      "text-[10px]",
                      PROVIDER_COLOR[r.softProvider],
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
                      PROVIDER_COLOR[r.softProvider],
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
                  <span className="opacity-60">Closing (CLV)</span>
                  <span className="text-right">
                    {r.closingSoftOdds?.toFixed(2) ?? "—"}
                  </span>
                </div>
              </TooltipContent>
            </Tooltip>
          );
        },
        meta: { align: "center", initialSize: 95 },
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
            <button
              type="button"
              onClick={() => setEditingOutcomeId(r.id)}
              title="Click to edit outcome"
              className={cn(
                "inline-flex items-center justify-center h-6 w-[82px] rounded-md px-1.5 text-[10px] font-medium transition-colors hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-primary/40",
                OUTCOME_PILL[r.outcome as Outcome],
              )}
            >
              {OUTCOME_LABEL[r.outcome as Outcome]}
            </button>
          );
        },
        meta: { align: "center", initialSize: 100 },
      },
      {
        id: "settledBy",
        header: () => (
          <StaticHeader
            label="Settled by"
            hint="Which source settled this bet — the deterministic tier (match_scores cache, football-data.org, live feed) or AI (url_context / Google search)."
          />
        ),
        cell: ({ row }) => {
          const r = row.original;
          if (!r.settledBySource) {
            return <span className="text-muted-foreground/60">—</span>;
          }
          return (
            <span
              className="inline-flex items-center rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-foreground/80"
              title={`Source: ${r.settledBySource}`}
            >
              {prettySettledBy(r.settledBySource)}
            </span>
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
          if (!r.outcomeMarkedAt) {
            return <span className="text-muted-foreground/60">—</span>;
          }
          return (
            <span
              className="text-[10px] text-muted-foreground"
              title={new Date(r.outcomeMarkedAt).toLocaleString()}
            >
              {fmtSeen(r.outcomeMarkedAt)}
            </span>
          );
        },
        meta: { align: "center", initialSize: 70 },
      },
      {
        id: "actions",
        header: () => (
          <StaticHeader
            label="Actions"
            hint="Per-row actions: re-run AI settlement, open in Google AI Mode for verification."
          />
        ),
        cell: ({ row }) => {
          const r = row.original;
          const running = rerunningIds?.has(r.id) ?? false;
          const gate = canResettle(r);
          const googleUrl = buildGoogleAiModeUrl(r);
          return (
            <div className="flex items-center justify-end gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <a
                    href={googleUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center justify-center size-6 rounded-md hover:bg-accent"
                  >
                    <ExternalLink className="size-3.5" />
                  </a>
                </TooltipTrigger>
                <TooltipContent>Verify on Google AI Mode</TooltipContent>
              </Tooltip>

              <div title={!gate.allowed ? gate.message : undefined}>
                <RerunButton
                  id={r.id}
                  running={running}
                  disabled={!gate.allowed}
                  onRerun={onRerunRow}
                />
              </div>
            </div>
          );
        },
        meta: { align: "center", fixed: "right", initialSize: 80 },
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
    onRerunRow,
    onSortChange,
  ]);

  return (
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
    />
  );
}
