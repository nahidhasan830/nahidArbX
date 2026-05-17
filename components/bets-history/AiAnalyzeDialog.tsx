"use client";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AiDialog } from "@/components/shared/AiDialog";
import type { AiAnalyzeResponse } from "@/lib/bets-history/api-client";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loading: boolean;
  response: AiAnalyzeResponse | null;
  scope: "selected" | "filtered";
};

export function AiAnalyzeDialog({
  open,
  onOpenChange,
  loading,
  response,
  scope,
}: Props) {
  const description = response
    ? `Analyzed ${response.analyzed} ${scope} bet${response.analyzed === 1 ? "" : "s"} · model ${response.analysis.model}`
    : `Analyzing ${scope} bets…`;

  return (
    <AiDialog
      open={open}
      onOpenChange={onOpenChange}
      title="AI analysis"
      description={description}
      loading={loading}
    >
      {response && (
        <div className="space-y-4">
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
              Summary
            </h3>
            <p className="text-sm leading-relaxed">
              {response.analysis.summary}
            </p>
          </section>

          {response.analysis.patterns.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                Patterns ({response.analysis.patterns.length})
              </h3>
              <ul className="list-disc list-inside space-y-1 text-sm">
                {response.analysis.patterns.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </section>
          )}

          {response.analysis.concerns.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                Concerns ({response.analysis.concerns.length})
              </h3>
              <ul className="list-disc list-inside space-y-1 text-sm">
                {response.analysis.concerns.map((c, i) => (
                  <li key={i} className="text-amber-300">
                    {c}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {response.analysis.recommendations.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                Recommendations ({response.analysis.recommendations.length})
              </h3>
              <ul className="list-disc list-inside space-y-1 text-sm">
                {response.analysis.recommendations.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </section>
          )}

          {response.analysis.by_market.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                By market
              </h3>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Market</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">Wins</TableHead>
                      <TableHead className="text-right">Losses</TableHead>
                      <TableHead className="text-right">Voids</TableHead>
                      <TableHead className="text-right">Pending</TableHead>
                      <TableHead className="text-right">Win %</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {response.analysis.by_market.map((m, i) => {
                      const decided = m.wins + m.losses;
                      const winRate =
                        decided > 0
                          ? ((m.wins / decided) * 100).toFixed(1)
                          : "—";
                      return (
                        <TableRow key={i}>
                          <TableCell className="text-sm">
                            {m.market}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {m.total}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-emerald-400">
                            {m.wins}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-rose-400">
                            {m.losses}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {m.voids}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {m.pending}
                          </TableCell>
                          <TableCell className="text-right tabular-nums font-medium">
                            {typeof winRate === "string" &&
                            winRate === "—" ? (
                              <span className="text-muted-foreground">
                                —
                              </span>
                            ) : (
                              `${winRate}%`
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </section>
          )}

          <div className="text-xs text-muted-foreground">
            <Badge variant="outline" className="text-[10px]">
              model: {response.analysis.model}
            </Badge>
          </div>
        </div>
      )}
    </AiDialog>
  );
}
