"use client";

/**
 * AutoPlacerTable — DataTable displaying every auto-placer decision:
 * attempts, skips, rejects, errors, and successes.
 *
 * Data comes from the `auto_placer_log` table, NOT the bets table.
 * Each row is one decision event, so the same bet ID may appear
 * multiple times (once per tick).
 */

import { useMemo } from "react";
import { format, parseISO } from "date-fns";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DataTable } from "@/components/ui/data-table";
import {
  MarketDisplay,
  inferMarketScopeFromBetId,
} from "@/components/ui/market-display";
import {
  getProviderShortName,
  getProviderTextInline,
} from "@/lib/providers/registry";
import { cn } from "@/lib/utils";
import { fmtDateTime, fmtSeen, fmtMoney } from "@/lib/formatting/helpers";
import type { AutoPlacerLogRow } from "@/lib/db/schema";

const PERSISTENCE_KEY = "auto-placer-log-table:layout:v2";

// ── Status styling ──

const STATUS_PILL: Record<string, string> = {
  placed: "bg-emerald-500/15 text-emerald-500 border border-emerald-500/30",
  pending: "bg-amber-500/15 text-amber-400 border border-amber-500/30",
  skipped: "bg-zinc-500/15 text-zinc-400 border border-zinc-500/30",
  rejected: "bg-rose-500/15 text-rose-400 border border-rose-500/30",
  error: "bg-red-500/15 text-red-400 border border-red-500/30",
};

const STATUS_LABEL: Record<string, string> = {
  placed: "Placed",
  pending: "Pending",
  skipped: "Skipped",
  rejected: "Rejected",
  error: "Error",
};

const ML_DECISION_PILL: Record<string, string> = {
  boost:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  agree: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  shrink:
    "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  skip: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
};

function cleanDecision(value: string | null | undefined) {
  return value ? value.replace(/_/g, " ") : "—";
}

function formatSignedPct(value: number | null | undefined, digits = 1) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function formatMultiplier(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(2)}x`;
}

// ── Gate styling ──

const GATE_COLORS: Record<string, string> = {
  toggle: "text-zinc-400",
  adapter: "text-zinc-400",
  ml_score: "text-purple-400",
  row_missing: "text-zinc-400",
  inflight: "text-zinc-400",
  refs: "text-amber-400",
  account: "text-red-400",
  ev_floor: "text-amber-400",
  balance: "text-red-400",
  market_max: "text-amber-400",
  stake_min: "text-amber-400",
  dedup: "text-zinc-400",
  book_reject: "text-rose-400",
  book_error: "text-red-400",
  placed: "text-emerald-400",
  pending: "text-amber-400",
  unknown: "text-muted-foreground",
};

const GATE_LABELS: Record<string, string> = {
  toggle: "Toggle Off",
  adapter: "No Adapter",
  ml_score: "ML Gate",
  row_missing: "Row Missing",
  inflight: "In-Flight",
  refs: "Ref Resolve",
  account: "Account",
  ev_floor: "EV Floor",
  balance: "Balance",
  market_max: "Market Max",
  stake_min: "Stake Min",
  dedup: "Dedup",
  book_reject: "Book Reject",
  book_error: "Book Error",
  placed: "Placed ✓",
  pending: "Pending…",
  unknown: "Unknown",
};

const GATE_TOOLTIPS: Record<string, string> = {
  toggle: "Auto-place toggle is OFF for this provider",
  adapter: "No betting adapter registered for this provider",
  ml_score: "ML model confidence below minimum threshold",
  row_missing: "Value bet row not found in DB after detection",
  inflight: "Another placement for this selection is already running",
  refs: "Couldn't resolve book-native market/selection references",
  account: "Account info fetch failed or account suspended",
  ev_floor: "EV% decayed below minimum threshold at placement time",
  balance: "Insufficient balance or auto-place floor exceeds balance",
  market_max: "Market max bet below auto-place bucket size",
  stake_min: "Kelly stake below book minimum bet amount",
  dedup: "Selection already reserved/placed by an earlier tick",
  book_reject: "Book rejected the bet (business rule)",
  book_error: "Transport/auth/parse error communicating with book",
  placed: "Bet successfully placed and confirmed",
  pending: "Bet accepted by book, awaiting confirmation",
  unknown: "Gate could not be determined",
};

export type AutoPlacerLogTableProps = {
  rows: AutoPlacerLogRow[];
  loading?: boolean;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
  renderFooter?: () => React.ReactNode;
};

export function AutoPlacerLogTable({
  rows,
  loading,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  renderFooter,
}: AutoPlacerLogTableProps) {
  const columns = useMemo<ColumnDef<AutoPlacerLogRow, unknown>[]>(
    () => [
      // ── Time ──
      {
        id: "time",
        accessorKey: "createdAt",
        header: "Time",
        cell: ({ row }) => {
          const t = row.original.createdAt;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-[10px] text-muted-foreground cursor-help">
                  {fmtSeen(t)}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                {format(parseISO(t), "MMM d, yyyy HH:mm:ss")}
              </TooltipContent>
            </Tooltip>
          );
        },
        meta: {
          hint: "When the auto-placer evaluated this bet.",
          align: "center" as const,
          initialSize: 55,
        },
      },
      // ── Status ──
      {
        id: "status",
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => {
          const s = row.original.status;
          return (
            <span
              className={cn(
                "inline-flex items-center justify-center h-5 rounded-md px-2 text-[10px] font-medium",
                STATUS_PILL[s] ?? STATUS_PILL.skipped,
              )}
            >
              {STATUS_LABEL[s] ?? s}
            </span>
          );
        },
        meta: {
          hint: "Outcome: placed, pending, skipped, rejected, or error.",
          align: "center" as const,
          initialSize: 80,
        },
      },
      // ── Gate ──
      {
        id: "gate",
        accessorKey: "gate",
        header: "Gate",
        cell: ({ row }) => {
          const g = row.original.gate;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "text-[10px] font-medium cursor-help",
                    GATE_COLORS[g] ?? GATE_COLORS.unknown,
                  )}
                >
                  {GATE_LABELS[g] ?? g}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                {GATE_TOOLTIPS[g] ?? "Unknown gate"}
              </TooltipContent>
            </Tooltip>
          );
        },
        meta: {
          hint: "Which pipeline gate produced this outcome.",
          align: "center" as const,
          initialSize: 95,
        },
      },
      // ── Provider ──
      {
        id: "provider",
        accessorKey: "softProvider",
        header: "Provider",
        cell: ({ row }) => {
          const p = row.original.softProvider;
          const name = getProviderShortName(p);
          return (
            <span
              className={cn(
                "inline-flex items-center rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium",
                getProviderTextInline(p),
              )}
            >
              {name}
            </span>
          );
        },
        meta: {
          hint: "Soft bookmaker targeted.",
          initialSize: 90,
        },
      },
      // ── Event ──
      {
        id: "event",
        accessorFn: (row) =>
          [row.homeTeam, row.awayTeam].filter(Boolean).join(" v ") || "—",
        header: "Event",
        cell: ({ row }) => {
          const r = row.original;
          if (!r.homeTeam)
            return <span className="text-muted-foreground/40">—</span>;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="max-w-[200px] flex items-center gap-1 min-w-0 cursor-help">
                  <span className="font-medium truncate">{r.homeTeam}</span>
                  <span className="text-muted-foreground shrink-0">v</span>
                  <span className="font-medium truncate">{r.awayTeam}</span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-sm">
                <div className="font-medium">
                  {r.homeTeam} vs {r.awayTeam}
                </div>
                {r.competition && (
                  <div className="text-muted-foreground text-[10px]">
                    {r.competition}
                  </div>
                )}
              </TooltipContent>
            </Tooltip>
          );
        },
        meta: { hint: "Event teams.", initialSize: 200 },
      },
      // ── Market ──
      {
        id: "market",
        header: "Market",
        accessorKey: "marketType",
        cell: ({ row }) => {
          const m = row.original.marketType;
          if (!m) return <span className="text-muted-foreground/40">—</span>;
          return (
            <MarketDisplay
              marketType={m}
              timeScope={inferMarketScopeFromBetId(row.original.betId)}
              className="max-w-full text-[11px]"
            />
          );
        },
        meta: {
          hint: "Market type.",
          align: "center" as const,
          initialSize: 110,
        },
      },
      // ── Selection ──
      {
        id: "selection",
        header: "Selection",
        accessorKey: "atomLabel",
        cell: ({ row }) => {
          const l = row.original.atomLabel;
          if (!l) return <span className="text-muted-foreground/40">—</span>;
          return <span className="text-[11px]">{l}</span>;
        },
        meta: {
          hint: "Which side of the market.",
          align: "center" as const,
          initialSize: 80,
        },
      },
      // ── Soft Odds ──
      {
        id: "softOdds",
        header: "Odds",
        accessorKey: "softOdds",
        cell: ({ row }) => {
          const o = row.original.softOdds;
          if (o == null)
            return <span className="text-muted-foreground/40">—</span>;
          return (
            <span className="tabular-nums font-medium">{o.toFixed(2)}</span>
          );
        },
        meta: {
          hint: "Soft odds at decision time.",
          align: "right" as const,
          initialSize: 60,
        },
      },
      // ── EV% ──
      {
        id: "ev",
        header: "EV%",
        accessorKey: "evPct",
        cell: ({ row }) => {
          const ev = row.original.evPct;
          if (ev == null)
            return <span className="text-muted-foreground/40">—</span>;
          const high = ev >= 5;
          const med = ev >= 2 && ev < 5;
          return (
            <span
              className={cn(
                "inline-flex items-center justify-center rounded px-1 py-0.5 text-[10px] font-semibold tabular-nums",
                high &&
                  "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30",
                med &&
                  "bg-amber-500/15 text-amber-400 border border-amber-500/30",
                !high &&
                  !med &&
                  "bg-muted text-muted-foreground border border-border",
              )}
            >
              {ev >= 0 ? "+" : ""}
              {ev.toFixed(1)}%
            </span>
          );
        },
        meta: {
          hint: "Expected value % at decision time.",
          align: "center" as const,
          initialSize: 65,
        },
      },
      {
        id: "mlDecision",
        header: "ML",
        accessorKey: "mlDecision",
        cell: ({ row }) => {
          const decision = row.original.mlDecision;
          if (!decision) {
            return <span className="text-muted-foreground/40">—</span>;
          }
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "inline-flex h-5 cursor-help items-center gap-1 rounded-md border px-1.5 text-[10px] font-semibold tabular-nums",
                    ML_DECISION_PILL[decision] ??
                      "border-border bg-muted text-muted-foreground",
                  )}
                >
                  <span className="capitalize">{cleanDecision(decision)}</span>
                  <span>{formatSignedPct(row.original.mlModelEdgePct)}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[280px] p-2.5">
                <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                  <span>Decision</span>
                  <span className="capitalize text-foreground">
                    {cleanDecision(decision)}
                  </span>
                  <span>Model EV</span>
                  <span className="font-mono text-foreground">
                    {formatSignedPct(row.original.mlModelEdgePct, 2)}
                  </span>
                  <span>Multiplier</span>
                  <span className="font-mono text-foreground">
                    {formatMultiplier(row.original.mlKellyMultiplier)}
                  </span>
                  <span>Score</span>
                  <span className="font-mono text-foreground">
                    {row.original.mlScore == null
                      ? "—"
                      : row.original.mlScore.toFixed(3)}
                  </span>
                </div>
              </TooltipContent>
            </Tooltip>
          );
        },
        meta: {
          hint: "ML decision, model EV, and Kelly multiplier logged for this decision event.",
          align: "center" as const,
          initialSize: 108,
        },
      },
      // ── Stake ──
      {
        id: "stake",
        header: "Stake",
        accessorKey: "stake",
        cell: ({ row }) => {
          const s = row.original.stake;
          if (s == null)
            return <span className="text-muted-foreground/40">—</span>;
          return (
            <span className="tabular-nums font-medium">{fmtMoney(s)}</span>
          );
        },
        meta: {
          hint: "Stake amount attempted.",
          align: "right" as const,
          initialSize: 85,
        },
      },
      // ── Balance ──
      {
        id: "balance",
        header: "Balance",
        accessorKey: "balance",
        cell: ({ row }) => {
          const b = row.original.balance;
          if (b == null)
            return <span className="text-muted-foreground/40">—</span>;
          return (
            <span className="tabular-nums text-muted-foreground">
              {fmtMoney(b)}
            </span>
          );
        },
        meta: {
          hint: "Account balance at decision time.",
          align: "right" as const,
          initialSize: 85,
        },
      },
      // ── Booked ──
      {
        id: "booked",
        header: "Booked",
        accessorKey: "bookedOdds",
        cell: ({ row }) => {
          const o = row.original.bookedOdds;
          if (o == null)
            return <span className="text-muted-foreground/40">—</span>;
          return (
            <span className="tabular-nums font-medium">{o.toFixed(2)}</span>
          );
        },
        meta: {
          hint: "Odds confirmed by the book (placed/pending only).",
          align: "right" as const,
          initialSize: 65,
        },
      },
      // ── Reason ──
      {
        id: "reason",
        header: "Reason",
        accessorKey: "reason",
        cell: ({ row }) => {
          const r = row.original.reason;
          if (!r) return <span className="text-muted-foreground/40">—</span>;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-[10px] text-muted-foreground truncate max-w-[200px] inline-block cursor-help">
                  {r}
                </span>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                className="max-w-md whitespace-pre-wrap text-xs"
              >
                {r}
              </TooltipContent>
            </Tooltip>
          );
        },
        meta: {
          hint: "Detailed reason for skip/reject/error.",
          initialSize: 200,
        },
      },
      // ── KO ──
      {
        id: "kickoff",
        header: "KO",
        accessorKey: "eventStartTime",
        cell: ({ row }) => {
          const t = row.original.eventStartTime;
          if (!t) return <span className="text-muted-foreground/40">—</span>;
          return (
            <span className="text-[10px] text-muted-foreground">
              {fmtDateTime(t)}
            </span>
          );
        },
        meta: {
          hint: "Event kickoff time.",
          align: "center" as const,
          initialSize: 95,
        },
      },
    ],
    [],
  );

  return (
    <DataTable<AutoPlacerLogRow>
      data={rows}
      columns={columns}
      getRowId={(row) => String(row.id)}
      enableSorting
      enableColumnResizing
      enableColumnOrdering
      enableVirtualization
      rowHeight={30}
      persistenceKey={PERSISTENCE_KEY}
      hasNextPage={hasNextPage}
      isFetchingNextPage={isFetchingNextPage}
      onLoadMore={onLoadMore}
      loading={loading}
      renderFooter={renderFooter}
      rowClassName={(row) => {
        const s = row.status;
        if (s === "placed" || s === "pending")
          return "bg-emerald-500/[0.03] hover:bg-emerald-500/[0.06]";
        if (s === "rejected" || s === "error")
          return "bg-rose-500/[0.03] hover:bg-rose-500/[0.06]";
        if (s === "skipped") return "hover:bg-muted/40";
        return undefined;
      }}
      renderEmpty={() => (
        <div className="flex flex-col items-center gap-1.5 py-12 text-muted-foreground">
          <span className="text-sm font-medium">No log entries</span>
          <span className="text-xs opacity-70">
            The auto-placer hasn&apos;t made any decisions yet, or adjust your
            filters.
          </span>
        </div>
      )}
    />
  );
}
