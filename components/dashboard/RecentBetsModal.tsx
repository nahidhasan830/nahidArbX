"use client";

/**
 * Modal that shows the operator's bet activity as reported by the 9W
 * main site (not our DB) — last 7 days, settled + unsettled.
 *
 * Data comes from GET /api/betting-accounts/recent-bets which already
 * merges generateSettledBetsSummary + generateSettledBetsDetail +
 * generateUnsettledBetsDetail for us, so this component just renders.
 */
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { RecentBet } from "@/app/api/accounts/recent-bets/route";

export interface RecentBetsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bets: RecentBet[];
  currency: string;
  periodDays: number;
  totals: {
    totalProfitLoss: number | null;
    totalTurnover: number | null;
    totalBetAmount: number | null;
    pendingCount: number;
    settledCount: number;
  };
  providerDisplayName: string;
}

export function RecentBetsModal({
  open,
  onOpenChange,
  bets,
  currency,
  periodDays,
  totals,
  providerDisplayName,
}: RecentBetsModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-3xl max-h-[85vh] overflow-hidden flex flex-col gap-2">
        <DialogHeader className="pb-2 border-b border-border/50">
          <DialogTitle className="text-base">
            {providerDisplayName} — last {periodDays} days
          </DialogTitle>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span>
              {totals.settledCount} settled · {totals.pendingCount} pending
            </span>
            {totals.totalBetAmount != null && (
              <>
                <Dot />
                <span>
                  Turnover{" "}
                  <span className="tabular-nums text-foreground font-medium">
                    {money(totals.totalBetAmount, currency)}
                  </span>
                </span>
              </>
            )}
            {totals.totalProfitLoss != null && (
              <>
                <Dot />
                <span>
                  P&L{" "}
                  <span
                    className={cn(
                      "tabular-nums font-medium",
                      totals.totalProfitLoss > 0
                        ? "text-emerald-500"
                        : totals.totalProfitLoss < 0
                          ? "text-danger"
                          : "text-foreground",
                    )}
                  >
                    {totals.totalProfitLoss > 0 ? "+" : ""}
                    {money(totals.totalProfitLoss, currency)}
                  </span>
                </span>
              </>
            )}
          </div>
        </DialogHeader>

        {/* Bet list — scrollable table. Kept compact. Show time, match details, status, stake, odds, P&L. */}
        <div className="flex-1 overflow-y-auto">
          {bets.length === 0 ? (
            <div className="py-10 text-center text-xs text-muted-foreground">
              No bets in the last {periodDays} days.
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 bg-background">
                <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border/50">
                  <th className="text-left py-1.5 px-2 font-medium">When</th>
                  <th className="text-left py-1.5 px-2 font-medium">Status</th>
                  <th className="text-left py-1.5 px-2 font-medium">
                    Match / Market
                  </th>
                  <th className="text-right py-1.5 px-2 font-medium">Stake</th>
                  <th className="text-right py-1.5 px-2 font-medium">Odds</th>
                  <th className="text-right py-1.5 px-2 font-medium">P&L</th>
                  <th className="text-right py-1.5 px-2 font-medium">Ticket</th>
                </tr>
              </thead>
              <tbody>
                {bets.map((bet) => (
                  <BetRow key={bet.id} bet={bet} currency={currency} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BetRow({ bet, currency }: { bet: RecentBet; currency: string }) {
  const placed = new Date(bet.placedAt);
  const dateStr = placed.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <tr className="border-b border-border/30 hover:bg-muted/40">
      <td className="py-1.5 px-2 tabular-nums">{dateStr}</td>
      <td className="py-1.5 px-2">
        {bet.status === "pending" ? (
          <Badge
            variant="outline"
            className="text-[9px] h-4 px-1.5 border-amber-500/40 text-amber-500"
          >
            Pending
          </Badge>
        ) : bet.result === "win" ? (
          <Badge
            variant="outline"
            className="text-[9px] h-4 px-1.5 border-emerald-500/40 text-emerald-500"
          >
            Win
          </Badge>
        ) : bet.result === "lose" ? (
          <Badge
            variant="outline"
            className="text-[9px] h-4 px-1.5 border-danger/40 text-danger"
          >
            Lose
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="text-[9px] h-4 px-1.5 text-muted-foreground"
          >
            Void
          </Badge>
        )}
      </td>
      <td className="py-1.5 px-2">
        {(() => {
          const e = bet.enrichment;
          const primary =
            e?.homeTeam && e?.awayTeam
              ? `${e.homeTeam} vs ${e.awayTeam}`
              : (e?.eventName ?? bet.gameName);
          const marketParts = [
            e?.marketType ?? bet.betType,
            e?.atomLabel,
          ].filter(Boolean);
          return (
            <>
              <div
                className="font-medium truncate max-w-[220px]"
                title={primary || ""}
              >
                {primary || "—"}
              </div>
              <div
                className="text-[10px] text-muted-foreground truncate max-w-[220px]"
                title={marketParts.join(" · ") || ""}
              >
                {marketParts.length > 0 ? marketParts.join(" · ") : "—"}
              </div>
            </>
          );
        })()}
      </td>
      <td className="py-1.5 px-2 text-right tabular-nums">
        {bet.stake != null ? money(bet.stake, currency) : "—"}
      </td>
      <td className="py-1.5 px-2 text-right tabular-nums font-mono">
        {bet.odds != null ? Number(bet.odds).toFixed(2) : "—"}
      </td>
      <td
        className={cn(
          "py-1.5 px-2 text-right tabular-nums font-medium",
          bet.profit == null
            ? "text-muted-foreground"
            : bet.profit > 0
              ? "text-emerald-500"
              : bet.profit < 0
                ? "text-danger"
                : "text-foreground",
        )}
      >
        {bet.profit == null
          ? "—"
          : `${bet.profit > 0 ? "+" : ""}${money(bet.profit, currency)}`}
      </td>
      <td
        className="py-1.5 px-2 text-right text-muted-foreground font-mono text-[10px]"
        title={`transactionId ${bet.transactionId}`}
      >
        {bet.vendorTxnId}
      </td>
    </tr>
  );
}

function Dot() {
  return <span className="opacity-40">·</span>;
}

function money(n: number, currency: string): string {
  return `${currency} ${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
