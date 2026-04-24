"use client";

import { TermTooltip } from "@/components/ui/TermTooltip";
import type { OptimizationTrialRow } from "@/lib/optimizer/repository";

const fmt = (n: number | null | string, digits = 2): string => {
  if (n === null || n === undefined) return "—";
  const v = typeof n === "string" ? Number(n) : n;
  return Number.isFinite(v) ? v.toFixed(digits) : "—";
};

export function TrialsTable({
  trials,
  onSelect,
}: {
  trials: OptimizationTrialRow[];
  onSelect: (trial: OptimizationTrialRow) => void;
}) {
  if (trials.length === 0) {
    return (
      <p className="text-xs text-muted-foreground py-4 text-center">
        No trials match this filter yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border/60">
      <table className="w-full text-xs">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr className="text-left">
            <th className="px-2 py-2 font-medium">#</th>
            <th className="px-2 py-2 font-medium text-right">
              <TermTooltip term="composite_score">Composite</TermTooltip>
            </th>
            <th className="px-2 py-2 font-medium text-right">
              <TermTooltip term="roi">OOS ROI</TermTooltip>{" "}
              <TermTooltip term="ci" iconOnly />
            </th>
            <th className="px-2 py-2 font-medium text-right">
              <TermTooltip term="sortino">Sortino</TermTooltip>
            </th>
            <th className="px-2 py-2 font-medium text-right">
              <TermTooltip term="drawdown">Max DD</TermTooltip>
            </th>
            <th className="px-2 py-2 font-medium text-right">
              <TermTooltip term="sample_size">N</TermTooltip>
            </th>
            <th className="px-2 py-2 font-medium text-right">
              <TermTooltip term="dsr">DSR</TermTooltip>
            </th>
            <th className="px-2 py-2 font-medium text-right">
              <TermTooltip term="psr">PSR</TermTooltip>
            </th>
            <th className="px-2 py-2 font-medium">Frontier</th>
          </tr>
        </thead>
        <tbody>
          {trials.map((t) => (
            <tr
              key={t.id}
              className="border-t border-border/60 hover:bg-muted/20 cursor-pointer"
              onClick={() => onSelect(t)}
            >
              <td className="px-2 py-1.5 tabular-nums text-muted-foreground">
                {t.trialIndex}
              </td>
              <td className="px-2 py-1.5 tabular-nums text-right font-medium">
                {fmt(t.compositeScore, 3)}
              </td>
              <td className="px-2 py-1.5 tabular-nums text-right">
                {fmt(t.oosRoiMean)}%
                <span className="text-muted-foreground ml-1 text-[10px]">
                  [{fmt(t.oosRoiCiLow, 1)}, {fmt(t.oosRoiCiHigh, 1)}]
                </span>
              </td>
              <td className="px-2 py-1.5 tabular-nums text-right">
                {fmt(t.oosSortino, 2)}
              </td>
              <td className="px-2 py-1.5 tabular-nums text-right">
                {fmt(t.maxDrawdown, 2)}
              </td>
              <td className="px-2 py-1.5 tabular-nums text-right">
                {t.sampleSize ?? "—"}
              </td>
              <td className="px-2 py-1.5 tabular-nums text-right">
                {fmt(t.deflatedSharpe, 3)}
              </td>
              <td className="px-2 py-1.5 tabular-nums text-right">
                {fmt(t.probabilisticSharpe, 3)}
              </td>
              <td className="px-2 py-1.5">
                {t.onPareto ? (
                  <span className="text-[10px] text-emerald-600 font-medium">
                    ★ Pareto
                  </span>
                ) : (
                  <span className="text-muted-foreground text-[10px]">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
