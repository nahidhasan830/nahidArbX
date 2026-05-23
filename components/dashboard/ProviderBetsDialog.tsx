"use client";

import { useMemo } from "react";
import { format } from "date-fns";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { MarketDisplay } from "@/components/ui/market-display";
import { derive } from "@/lib/bets-history/derive";
import { useBetsList } from "@/lib/bets-history/hooks";
import type { ValueBetRow } from "@/lib/bets-history/types";
import { cn } from "@/lib/utils";

export function ProviderBetsDialog({
  open,
  onOpenChange,
  provider,
  providerDisplayName,
  status,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: string | null;
  providerDisplayName: string | null;
  status: "pending" | "settled" | null;
}) {
  const filters = useMemo(() => {
    if (!provider || !status) return {};
    return {
      softProviders: [provider],
      outcome: status,
      placedOnly: true,
    };
  }, [provider, status]);

  const { data, isLoading } = useBetsList(filters, 50);

  const rows = useMemo(() => data?.pages[0]?.rows ?? [], [data]);
  const total = data?.pages[0]?.total ?? 0;

  const columns = useMemo<ColumnDef<ValueBetRow>[]>(
    () => [
      {
        id: "date",
        header: "Date",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {row.original.firstSeenAt
              ? format(new Date(row.original.firstSeenAt), "MMM d, HH:mm")
              : "—"}
          </span>
        ),
      },
      {
        id: "event",
        header: "Event",
        cell: ({ row }) => (
          <div className="font-medium text-[13px]">
            {row.original.homeTeam}{" "}
            <span className="text-muted-foreground">vs</span>{" "}
            {row.original.awayTeam}
          </div>
        ),
      },
      {
        id: "market",
        header: "Market / Selection",
        cell: ({ row }) => (
          <MarketDisplay
            marketType={row.original.marketType}
            timeScope={row.original.timeScope}
            familyLine={row.original.familyLine}
            selection={row.original.atomLabel}
            className="max-w-[220px] justify-start text-[12px]"
            textClassName="text-muted-foreground"
          />
        ),
      },
      {
        id: "odds",
        header: () => <div className="text-right">Odds</div>,
        cell: ({ row }) => (
          <div className="text-right font-mono text-[12px] text-emerald-400">
            {Number(row.original.softOdds).toFixed(2)}
          </div>
        ),
        meta: { align: "right" },
      },
      {
        id: "outcome",
        header: () => (
          <div className="text-right">
            {status === "settled" ? "Outcome" : "EV %"}
          </div>
        ),
        cell: ({ row }) => {
          const r = row.original;
          if (status === "settled") {
            const isWin = r.outcome === "won" || r.outcome === "half_won";
            const isLoss = r.outcome === "lost" || r.outcome === "half_lost";
            return (
              <div
                className={cn(
                  "text-right text-[12px] font-medium capitalize",
                  isWin
                    ? "text-emerald-400"
                    : isLoss
                      ? "text-danger"
                      : "text-muted-foreground",
                )}
              >
                {r.outcome}
              </div>
            );
          } else {
            const ev = r.sharpTrueProb && r.softOdds ? derive(r).evPct : null;
            return (
              <div className="text-right font-mono text-[12px]">
                {ev !== null ? ev.toFixed(2) + "%" : "—"}
              </div>
            );
          }
        },
        meta: { align: "right" },
      },
    ],
    [status],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col p-0 gap-0 overflow-hidden bg-card/95 backdrop-blur-xl border-white/[0.08] !rounded-xl">
        <DialogHeader className="px-5 py-4 border-b border-border/40 shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <span className="text-[14px] font-semibold text-foreground/90">
              {providerDisplayName}
            </span>
            {status && (
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px] uppercase",
                  status === "pending"
                    ? "text-amber-400 border-amber-400/30"
                    : "text-cyan-400 border-cyan-400/30",
                )}
              >
                {status} Bets
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 min-h-0 bg-background/50 flex flex-col">
          <DataTable
            data={rows}
            columns={columns}
            loading={isLoading}
            enableVirtualization={true}
            renderEmpty={() => `No ${status} bets found.`}
            renderFooter={() =>
              total > rows.length ? (
                <div className="text-center">
                  <span
                    className="text-[11px] text-muted-foreground uppercase tracking-wide cursor-pointer hover:text-foreground transition-colors"
                    onClick={() =>
                      window.open(
                        `/bets?provider=${provider}&status=${status}`,
                        "_blank",
                      )
                    }
                  >
                    View all {total} in Bets History →
                  </span>
                </div>
              ) : null
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
