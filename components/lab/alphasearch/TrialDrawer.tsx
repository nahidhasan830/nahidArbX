"use client";

/**
 * Side drawer with the full trial details — sampled config, fold-by-fold
 * metrics, "Promote to strategy" CTA (Phase 3).
 */

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { TermTooltip } from "@/components/ui/TermTooltip";
import type { OptimizationTrialRow } from "@/lib/optimizer/repository";
import type { FoldMetricJson } from "@/lib/optimizer/types";
import { PromoteToStrategy } from "./PromoteToStrategy";

const fmt = (n: number | null | string | undefined, digits = 2): string => {
  if (n === null || n === undefined) return "—";
  const v = typeof n === "string" ? Number(n) : n;
  return Number.isFinite(v) ? v.toFixed(digits) : "—";
};

export function TrialDrawer({
  trial,
  open,
  onOpenChange,
}: {
  trial: OptimizationTrialRow | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  if (!trial) return null;
  const params = (trial.params as Record<string, unknown>) ?? {};
  const folds = (trial.foldMetrics as FoldMetricJson[] | null) ?? [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 text-sm">
            Trial #{trial.trialIndex}
            {trial.onPareto && (
              <span className="text-[10px] text-emerald-600 font-medium">
                ★ Pareto frontier
              </span>
            )}
          </SheetTitle>
          <SheetDescription className="text-xs">
            Sampled by <span className="font-medium">{trial.sampler}</span>. All
            metrics are{" "}
            <TermTooltip term="cpcv">out-of-sample (CPCV)</TermTooltip>.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5 px-4 py-4 text-xs">
          {/* Summary metrics */}
          <section className="space-y-2">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Summary
            </h3>
            <div className="grid grid-cols-2 gap-2">
              <Metric label={<TermTooltip term="roi">OOS ROI</TermTooltip>}>
                {fmt(trial.oosRoiMean)}%{" "}
                <span className="text-muted-foreground text-[10px]">
                  [{fmt(trial.oosRoiCiLow, 1)}, {fmt(trial.oosRoiCiHigh, 1)}]
                </span>
              </Metric>
              <Metric
                label={
                  <TermTooltip term="composite_score">Composite</TermTooltip>
                }
              >
                {fmt(trial.compositeScore, 3)}
              </Metric>
              <Metric label={<TermTooltip term="sortino">Sortino</TermTooltip>}>
                {fmt(trial.oosSortino)}
              </Metric>
              <Metric label={<TermTooltip term="sharpe">Sharpe</TermTooltip>}>
                {fmt(trial.oosSharpe)}
              </Metric>
              <Metric label={<TermTooltip term="dsr">DSR</TermTooltip>}>
                {fmt(trial.deflatedSharpe, 3)}
              </Metric>
              <Metric label={<TermTooltip term="psr">PSR</TermTooltip>}>
                {fmt(trial.probabilisticSharpe, 3)}
              </Metric>
              <Metric label={<TermTooltip term="drawdown">Max DD</TermTooltip>}>
                {fmt(trial.maxDrawdown)}
              </Metric>
              <Metric
                label={
                  <TermTooltip term="sample_size">Sample size</TermTooltip>
                }
              >
                {trial.sampleSize ?? "—"}
              </Metric>
            </div>
          </section>

          {/* Sampled config */}
          <section className="space-y-2">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Sampled configuration
            </h3>
            <div className="rounded-md border border-border/60 bg-muted/30 p-3 space-y-1 text-[11px]">
              {Object.entries(params).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <span className="text-muted-foreground">{k}</span>
                  <span className="tabular-nums text-right">
                    {Array.isArray(v)
                      ? v.join(", ")
                      : typeof v === "number"
                        ? v.toFixed(3).replace(/\.?0+$/, "")
                        : String(v)}
                  </span>
                </div>
              ))}
            </div>
          </section>

          {/* Per-fold metrics */}
          <section className="space-y-2">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Per-fold breakdown ({folds.length} OOS paths)
            </h3>
            <div className="overflow-x-auto rounded-md border border-border/60">
              <table className="w-full text-[10px]">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr className="text-left">
                    <th className="px-2 py-1.5">Path</th>
                    <th className="px-2 py-1.5 text-right">N</th>
                    <th className="px-2 py-1.5 text-right">ROI</th>
                    <th className="px-2 py-1.5 text-right">Sortino</th>
                    <th className="px-2 py-1.5 text-right">Max DD</th>
                  </tr>
                </thead>
                <tbody>
                  {folds.slice(0, 50).map((f) => (
                    <tr
                      key={f.path_index}
                      className="border-t border-border/60"
                    >
                      <td className="px-2 py-1 text-muted-foreground">
                        {f.path_index}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {f.n_bets}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {fmt(f.roi_pct, 2)}%
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {fmt(f.sortino, 2)}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {fmt(f.max_drawdown, 2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {folds.length > 50 && (
                <p className="text-[10px] text-muted-foreground py-1.5 text-center">
                  …showing first 50 of {folds.length} folds
                </p>
              )}
            </div>
          </section>

          {/* Promote to live strategy */}
          <section className="rounded-md border border-border/60 bg-muted/30 px-3 py-3 space-y-2">
            <p className="text-[11px] text-muted-foreground">
              <strong className="text-foreground">
                Promote to live strategy
              </strong>{" "}
              creates a saved configuration the value detector consults on every
              tick. Matching bets get tagged with the strategy id so live
              performance is attributed.
            </p>
            <PromoteToStrategy
              trialId={trial.id}
              defaultName={`Trial #${trial.trialIndex} — ROI ${fmt(trial.oosRoiMean, 1)}%`}
            />
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Metric({
  label,
  children,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 px-2 py-1.5">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="text-sm font-medium tabular-nums">{children}</div>
    </div>
  );
}
