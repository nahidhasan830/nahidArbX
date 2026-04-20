"use client";

import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useStrategyExecutions } from "@/lib/backtest/hooks";
import type { Strategy } from "@/lib/backtest/api-client";
import { cn } from "@/lib/utils";
import { formatMarketType, formatAtomLabel } from "@/lib/formatting/labels";

type Props = {
  strategy: Strategy | null;
  onOpenChange: (o: boolean) => void;
};

const OUTCOME_COLORS: Record<string, string> = {
  pending: "text-muted-foreground",
  won: "text-emerald-400",
  half_won: "text-emerald-300",
  lost: "text-rose-400",
  half_lost: "text-rose-300",
  void: "text-slate-400",
  // Legacy alias — kept in case old strategy executions still carry it.
  push: "text-slate-400",
};

const fmtDateTime = (iso: string): string => {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, {
    month: "short",
    day: "2-digit",
  })} ${d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
};

const clvPct = (
  softOddsFirst: number,
  closingSharpOdds: number | null,
): number | null => {
  if (closingSharpOdds == null) return null;
  return (softOddsFirst / closingSharpOdds - 1) * 100;
};

export function ExecutionsDialog({ strategy, onOpenChange }: Props) {
  const open = !!strategy;
  const { data: rows = [], isLoading } = useStrategyExecutions(
    strategy?.id ?? null,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {strategy ? `Executions — ${strategy.name}` : "Executions"}
          </DialogTitle>
          <DialogDescription>
            {strategy
              ? `Every value bet the live matcher recorded against this strategy. Stake multiplier: ${strategy.stakeMultiplier.toFixed(2)}.`
              : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="size-4 animate-spin mr-2" />
              Loading executions…
            </div>
          ) : rows.length === 0 ? (
            <div className="text-[12px] text-muted-foreground py-8 text-center">
              No executions yet. Promote this strategy to{" "}
              <span className="font-medium">live</span> and wait for the next
              sync cycle.
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Matched</TableHead>
                    <TableHead>Event</TableHead>
                    <TableHead>Market</TableHead>
                    <TableHead>Book</TableHead>
                    <TableHead className="text-right">Odds</TableHead>
                    <TableHead className="text-right">CLV</TableHead>
                    <TableHead className="text-right">Outcome</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((exec) => {
                    const vb = exec.valueBet;
                    if (!vb) {
                      return (
                        <TableRow key={exec.executionId}>
                          <TableCell className="text-[11px] text-muted-foreground">
                            {fmtDateTime(exec.matchedAt)}
                          </TableCell>
                          <TableCell
                            colSpan={6}
                            className="text-[11px] text-muted-foreground italic"
                          >
                            bet row gone — likely deleted
                          </TableCell>
                        </TableRow>
                      );
                    }
                    const clv = clvPct(vb.softOddsFirst, vb.closingSharpOdds);
                    return (
                      <TableRow key={exec.executionId}>
                        <TableCell className="text-[11px] text-muted-foreground tabular-nums">
                          {fmtDateTime(exec.matchedAt)}
                        </TableCell>
                        <TableCell className="text-[11px]">
                          <span className="font-medium">{vb.homeTeam}</span>
                          <span className="text-muted-foreground mx-1">vs</span>
                          <span className="font-medium">{vb.awayTeam}</span>
                          <span className="text-muted-foreground ml-1.5 text-[10px]">
                            {fmtDateTime(vb.eventStartTime)}
                          </span>
                        </TableCell>
                        <TableCell className="text-[11px]">
                          <span className="text-muted-foreground text-[10px] mr-1">
                            {formatMarketType(vb.marketType)}
                          </span>
                          {formatAtomLabel(vb.atomLabel)}
                        </TableCell>
                        <TableCell className="text-[11px] text-muted-foreground">
                          {vb.softProvider}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-[11px]">
                          {vb.softOddsFirst.toFixed(2)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-right tabular-nums text-[11px]",
                            clv == null
                              ? "text-muted-foreground"
                              : clv > 0
                                ? "text-emerald-400"
                                : "text-rose-400",
                          )}
                        >
                          {clv == null
                            ? "—"
                            : `${clv > 0 ? "+" : ""}${clv.toFixed(2)}%`}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-right text-[11px] font-medium capitalize",
                            OUTCOME_COLORS[vb.outcome] ?? "",
                          )}
                        >
                          {vb.outcome}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
