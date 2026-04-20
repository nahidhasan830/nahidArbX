"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
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
import { RerunButton, type RerunChoice } from "./AiSettleDialog";
import { derive } from "@/lib/backtest/derive";
import { buildGoogleAiModeUrl } from "@/lib/backtest/google-verify";
import { canResettle, prettySettledBy } from "@/lib/backtest/resettle";
import type { Outcome, ValueBetRow } from "@/lib/backtest/types";
import { cn } from "@/lib/utils";
import { formatMarketType, formatAtomLabel } from "@/lib/formatting/labels";

type SortKey =
  | "firstSeenAt"
  | "evPctMax"
  | "kellyFraction"
  | "tickCount"
  | "eventStartTime";
type SortDir = "asc" | "desc" | "none";

const ROW_HEIGHT = 30;

const OUTCOME_PILL: Record<Outcome, string> = {
  pending: "bg-muted text-muted-foreground border border-border",
  won: "bg-emerald-500/15 text-emerald-500 border border-emerald-500/30",
  half_won: "bg-emerald-500/10 text-emerald-400 border border-emerald-500/25",
  lost: "bg-rose-500/15 text-rose-500 border border-rose-500/30",
  half_lost: "bg-rose-500/10 text-rose-400 border border-rose-500/25",
  void: "bg-slate-500/15 text-slate-400 border border-slate-500/30",
};

/** Compact two-char badge for the half outcomes: "½W" / "½L". */
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

const fmtDateTime = (iso: string) => {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (sameDay) return `Today ${time}`;
  if (isTomorrow) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "2-digit" })} ${time}`;
};

const fmtSeen = (iso: string) => {
  const d = new Date(iso);
  const diffMin = (Date.now() - d.getTime()) / 60000;
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${Math.floor(diffMin)}m`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h`;
  return `${Math.floor(diffMin / 1440)}d`;
};

type Decorated = ValueBetRow & { _evPctMax: number; _kellyFraction: number };

/**
 * Table header cell with a built-in hover tooltip explaining what the column
 * means. Accepts the same `className` and `onClick` as a native <th> so sort
 * handlers keep working transparently.
 */
function HeaderCell({
  children,
  hint,
  className,
  onClick,
}: {
  children: React.ReactNode;
  hint: string;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <th className={className} onClick={onClick}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help inline-flex items-center">
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="max-w-[280px] whitespace-pre-line"
        >
          {hint}
        </TooltipContent>
      </Tooltip>
    </th>
  );
}

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

export function BacktestTable({
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
          _evPctMax: d.evPctFirst,
          _kellyFraction: d.kellyFractionFirst,
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

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key || sortDir === "none") return "";
    return sortDir === "desc" ? " ↓" : " ↑";
  };

  // Virtualization
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom =
    virtualItems.length > 0
      ? totalSize - virtualItems[virtualItems.length - 1].end
      : 0;

  const lastVisibleIndex = virtualItems[virtualItems.length - 1]?.index ?? -1;
  useEffect(() => {
    if (!onLoadMore || !hasNextPage || isFetchingNextPage) return;
    if (lastVisibleIndex >= sorted.length - 10 && sorted.length > 0) {
      onLoadMore();
    }
  }, [
    lastVisibleIndex,
    sorted.length,
    hasNextPage,
    isFetchingNextPage,
    onLoadMore,
  ]);

  const showEmpty = !loading && sorted.length === 0;
  const showLoadingPlaceholder = loading && sorted.length === 0;

  const thBase =
    "text-left px-2 font-semibold text-[11px] text-muted-foreground whitespace-nowrap h-8";
  const tdBase = "px-2 text-[11px] whitespace-nowrap align-middle";

  return (
    <TooltipProvider delayDuration={200}>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className="bg-muted border-b border-border">
              <th className={cn(thBase, "w-8 px-2")}>
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
              </th>
              <HeaderCell
                className={thBase}
                hint="The sporting event — home team vs away team, plus competition and kickoff time."
              >
                Event
              </HeaderCell>
              <HeaderCell
                className={thBase}
                hint="Market type (e.g., MATCH_ODDS, OVER_UNDER 2.5). What you're actually betting on."
              >
                Market
              </HeaderCell>
              <HeaderCell
                className={thBase}
                hint="Which side of the market this value bet is on — e.g., Home Win, Over 2.5, Draw."
              >
                Outcome
              </HeaderCell>
              <HeaderCell
                className={cn(thBase, "text-right")}
                hint="Sharp reference price from Pinnacle (vig-removed). The baseline the soft book is being compared against."
              >
                Sharp
              </HeaderCell>
              <HeaderCell
                className={cn(thBase, "text-right")}
                hint="The soft bookmaker's price at entry — what you'd actually bet at. Hover a cell for closing/peak breakdown."
              >
                Soft
              </HeaderCell>
              <HeaderCell
                className={cn(
                  thBase,
                  "text-right cursor-pointer select-none hover:text-foreground",
                )}
                onClick={() => onSortChange("evPctMax")}
                hint={`Expected value as a percentage: (soft_odds × true_probability − 1) × 100. +2% means a 2% edge per unit staked.\n\nSort: click cycles desc → asc → none.`}
              >
                EV %{sortIndicator("evPctMax")}
              </HeaderCell>
              <HeaderCell
                className={cn(
                  thBase,
                  "text-right cursor-pointer select-none hover:text-foreground",
                )}
                onClick={() => onSortChange("kellyFraction")}
                hint={`Kelly fraction × 100 — the theoretically optimal share of bankroll for this bet. Most pros use ¼ or ½ Kelly in practice.\n\nSort: click cycles desc → asc → none.`}
              >
                Kelly{sortIndicator("kellyFraction")}
              </HeaderCell>
              <HeaderCell
                className={cn(
                  thBase,
                  "cursor-pointer select-none hover:text-foreground",
                )}
                onClick={() => onSortChange("firstSeenAt")}
                hint={`When the bet was first detected — timestamp of the first sync cycle that saw this price.\n\nSort: click cycles desc → asc → none.`}
              >
                Seen{sortIndicator("firstSeenAt")}
              </HeaderCell>
              <HeaderCell
                className={cn(
                  thBase,
                  "text-right cursor-pointer select-none hover:text-foreground",
                )}
                onClick={() => onSortChange("tickCount")}
                hint={`T = tick count. Number of times this bet has been re-observed during pre-match tracking. Higher T = more stable price, less likely to vanish.\n\nSort: click cycles desc → asc → none.`}
              >
                T{sortIndicator("tickCount")}
              </HeaderCell>
              <HeaderCell
                className={thBase}
                hint="Current settlement state: Pending, Won, Lost, Half-won, Half-lost, or Void."
              >
                Status
              </HeaderCell>
              <HeaderCell
                className={thBase}
                hint="Which source settled this bet — the deterministic tier (match_scores cache, football-data.org, live feed) or AI (url_context / Google search)."
              >
                Settled by
              </HeaderCell>
              <HeaderCell
                className={thBase}
                hint="When settlement was finalised (timestamp)."
              >
                Settled
              </HeaderCell>
              <HeaderCell
                className={cn(thBase, "text-right pr-3")}
                hint="Per-row actions: manually mark outcome, re-run AI settlement, open in Google AI Mode for verification."
              >
                Actions
              </HeaderCell>
            </tr>
          </thead>
          <tbody>
            {showLoadingPlaceholder && (
              <tr>
                <td
                  colSpan={14}
                  className="text-center text-muted-foreground py-8 text-xs"
                >
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="size-3.5 animate-spin" />
                    Loading value bets…
                  </span>
                </td>
              </tr>
            )}
            {showEmpty && (
              <tr>
                <td
                  colSpan={14}
                  className="text-center text-muted-foreground py-8 text-xs"
                >
                  No value bets match the current filters.
                </td>
              </tr>
            )}

            {sorted.length > 0 && paddingTop > 0 && (
              <tr aria-hidden="true" style={{ height: paddingTop }}>
                <td colSpan={14} />
              </tr>
            )}

            {virtualItems.map((vi) => {
              const row = sorted[vi.index];
              const selected = selectedIds.has(row.id);
              const running = rerunningIds?.has(row.id) ?? false;
              const gate = canResettle(row);
              const googleUrl = buildGoogleAiModeUrl(row);
              const evHigh = row._evPctMax >= 5;
              const evMed = row._evPctMax >= 2 && row._evPctMax < 5;
              const sharpName =
                PROVIDER_SHORT[row.sharpProvider] ?? row.sharpProvider;
              const softName =
                PROVIDER_SHORT[row.softProvider] ?? row.softProvider;
              return (
                <tr
                  key={row.id}
                  data-state={selected ? "selected" : undefined}
                  style={{ height: ROW_HEIGHT }}
                  className={cn(
                    "border-b border-border/50 hover:bg-muted/40 transition-colors",
                    selected && "bg-primary/5",
                  )}
                >
                  <td className={cn(tdBase, "w-8")}>
                    <Checkbox
                      checked={selected}
                      onCheckedChange={() => onToggleRow(row.id)}
                      aria-label={`Select ${row.id}`}
                      className="size-3.5"
                    />
                  </td>
                  <td className={tdBase}>
                    <div className="max-w-[420px] flex items-center gap-1.5 min-w-0">
                      <span
                        className="font-medium truncate"
                        title={row.homeTeam}
                      >
                        {row.homeTeam}
                      </span>
                      <span className="text-muted-foreground shrink-0">vs</span>
                      <span
                        className="font-medium truncate"
                        title={row.awayTeam}
                      >
                        {row.awayTeam}
                      </span>
                      <span className="text-muted-foreground ml-1 text-[10px] shrink-0">
                        {fmtDateTime(row.eventStartTime)}
                      </span>
                      {row.competition && (
                        <span
                          className="text-muted-foreground/70 text-[10px] truncate shrink min-w-0"
                          title={row.competition}
                        >
                          · {row.competition}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className={tdBase}>
                    <span className="text-muted-foreground text-[10px] mr-1">
                      [{row.timeScope}]
                    </span>
                    <span>
                      {formatMarketType(row.marketType)}
                      {row.familyLine != null && ` ${row.familyLine}`}
                    </span>
                  </td>
                  <td className={tdBase}>{formatAtomLabel(row.atomLabel)}</td>
                  <td className={cn(tdBase, "text-right tabular-nums")}>
                    <span
                      className={cn(
                        "text-[10px] mr-1",
                        PROVIDER_COLOR[row.sharpProvider],
                      )}
                    >
                      {sharpName}
                    </span>
                    <span className="font-medium">
                      {row.sharpOdds.toFixed(2)}
                    </span>
                  </td>
                  <td className={cn(tdBase, "text-right tabular-nums")}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex items-center gap-1 cursor-help">
                          <span
                            className={cn(
                              "text-[10px]",
                              PROVIDER_COLOR[row.softProvider],
                            )}
                          >
                            {softName}
                          </span>
                          <span className="font-medium">
                            {row.softOddsFirst.toFixed(2)}
                          </span>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="px-3 py-2">
                        <div className="flex items-baseline justify-between gap-4 pb-1.5 mb-1.5 border-b border-border">
                          <span
                            className={cn(
                              "text-[10px] font-semibold",
                              PROVIDER_COLOR[row.softProvider],
                            )}
                          >
                            {softName}
                          </span>
                          {row.softCommissionPct > 0 && (
                            <span className="text-[10px] opacity-60">
                              {row.softCommissionPct}% comm
                            </span>
                          )}
                        </div>
                        <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular-nums">
                          <span className="opacity-60">Entry (P&L)</span>
                          <span className="text-right font-medium">
                            {row.softOddsFirst.toFixed(2)}
                          </span>
                          <span className="opacity-60">Closing (CLV)</span>
                          <span className="text-right">
                            {row.softOddsLast.toFixed(2)}
                          </span>
                          <span className="opacity-60">Peak</span>
                          <span className="text-right">
                            {row.softOddsMax.toFixed(2)}
                          </span>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  </td>
                  <td className={cn(tdBase, "text-right")}>
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
                      {row._evPctMax >= 0 ? "+" : ""}
                      {row._evPctMax.toFixed(2)}%
                    </span>
                  </td>
                  <td className={cn(tdBase, "text-right tabular-nums")}>
                    {(row._kellyFraction * 100).toFixed(2)}
                  </td>
                  <td
                    className={cn(tdBase, "text-muted-foreground text-[10px]")}
                  >
                    {fmtSeen(row.firstSeenAt)}
                  </td>
                  <td className={cn(tdBase, "text-right tabular-nums")}>
                    {row.tickCount}
                  </td>
                  <td className={tdBase}>
                    {editingOutcomeId === row.id ? (
                      <Select
                        value={row.outcome}
                        defaultOpen
                        onValueChange={(v) => {
                          onMarkOutcome(row.id, v as Outcome);
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
                            OUTCOME_PILL[row.outcome],
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
                              <span className="text-[11px]">
                                {OUTCOME_LABEL[o]}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setEditingOutcomeId(row.id)}
                        title="Click to edit outcome"
                        className={cn(
                          "inline-flex items-center justify-center h-6 w-[82px] rounded-md px-1.5 text-[10px] font-medium transition-colors hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-primary/40",
                          OUTCOME_PILL[row.outcome],
                        )}
                      >
                        {OUTCOME_LABEL[row.outcome]}
                      </button>
                    )}
                  </td>
                  <td
                    className={cn(tdBase, "text-[10px] text-muted-foreground")}
                  >
                    {row.settledBySource ? (
                      <span
                        className="inline-flex items-center rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-medium text-foreground/80"
                        title={`Source: ${row.settledBySource}`}
                      >
                        {prettySettledBy(row.settledBySource)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/60">—</span>
                    )}
                  </td>
                  <td
                    className={cn(tdBase, "text-[10px] text-muted-foreground")}
                  >
                    {row.outcomeMarkedAt ? (
                      <span
                        title={new Date(row.outcomeMarkedAt).toLocaleString()}
                      >
                        {fmtSeen(row.outcomeMarkedAt)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/60">—</span>
                    )}
                  </td>
                  <td className={cn(tdBase, "text-right pr-3")}>
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
                        <TooltipContent>
                          Verify on Google AI Mode
                        </TooltipContent>
                      </Tooltip>

                      <div title={!gate.allowed ? gate.message : undefined}>
                        <RerunButton
                          id={row.id}
                          running={running}
                          disabled={!gate.allowed}
                          onRerun={onRerunRow}
                        />
                      </div>
                    </div>
                  </td>
                </tr>
              );
            })}

            {sorted.length > 0 && paddingBottom > 0 && (
              <tr aria-hidden="true" style={{ height: paddingBottom }}>
                <td colSpan={14} />
              </tr>
            )}

            {isFetchingNextPage && (
              <tr>
                <td
                  colSpan={14}
                  className="text-center text-muted-foreground py-3 text-xs"
                >
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="size-3.5 animate-spin" />
                    Loading more…
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </TooltipProvider>
  );
}
