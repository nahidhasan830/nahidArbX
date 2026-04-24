"use client";

/**
 * Trials table — every trial row with its OOS metrics, with a Quality
 * column that applies the shared `classifyTrial` rule from
 * `lib/optimizer/trial-quality.ts`. By default Unreliable trials
 * (n < 30, DSR < 0.5, or sentinel composite) are hidden so the
 * operator doesn't accidentally promote a 5-bet fluke; a toggle lets
 * them re-appear for debugging. Matches the composite-score floor
 * implemented in `services/optimizer/app/scoring.py`.
 */

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TermTooltip } from "@/components/ui/TermTooltip";
import { cn } from "@/lib/utils";
import {
  classifyTrial,
  type TrialQualityResult,
} from "@/lib/optimizer/trial-quality";
import type { OptimizationTrialRow } from "@/lib/optimizer/repository";

const fmt = (n: number | null | string | undefined, digits = 2): string => {
  if (n === null || n === undefined) return "—";
  const v = typeof n === "string" ? Number(n) : n;
  return Number.isFinite(v) ? v.toFixed(digits) : "—";
};

interface ClassifiedTrial {
  row: OptimizationTrialRow;
  quality: TrialQualityResult;
}

export function TrialsTable({
  trials,
  onSelect,
}: {
  trials: OptimizationTrialRow[];
  onSelect: (trial: OptimizationTrialRow) => void;
}) {
  const [showUnreliable, setShowUnreliable] = React.useState(false);

  const classified: ClassifiedTrial[] = React.useMemo(
    () =>
      trials.map((row) => ({
        row,
        quality: classifyTrial({
          sampleSize: row.sampleSize ?? null,
          deflatedSharpe: row.deflatedSharpe ?? null,
          oosRoiCiLow: row.oosRoiCiLow ?? null,
          compositeScore: row.compositeScore ?? null,
        }),
      })),
    [trials],
  );

  const visible = React.useMemo(
    () =>
      showUnreliable
        ? classified
        : classified.filter((c) => c.quality.quality !== "unreliable"),
    [classified, showUnreliable],
  );

  const hiddenCount = classified.length - visible.length;

  if (trials.length === 0) {
    return (
      <p className="text-xs text-muted-foreground py-6 text-center">
        No trials match this filter yet.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {/* Filter toolbar */}
      <div className="flex items-center justify-between px-1 text-[11px]">
        <span className="text-muted-foreground tabular-nums">
          Showing {visible.length} of {classified.length}
          {hiddenCount > 0 && (
            <span className="text-amber-600 dark:text-amber-400 ml-2">
              · {hiddenCount} unreliable hidden
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={() => setShowUnreliable((v) => !v)}
          className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
        >
          {showUnreliable ? (
            <>
              <EyeOff className="size-3.5" /> Hide unreliable
            </>
          ) : (
            <>
              <Eye className="size-3.5" /> Show unreliable
            </>
          )}
        </button>
      </div>

      <div className="overflow-x-auto rounded-md border border-border/60">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr className="text-left">
              <th className="px-2 py-2 font-medium">#</th>
              <th className="px-2 py-2 font-medium">Quality</th>
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
            {visible.map(({ row: t, quality }) => (
              <tr
                key={t.id}
                className={cn(
                  "border-t border-border/60 hover:bg-muted/20 cursor-pointer",
                  quality.quality === "unreliable" && "opacity-60",
                )}
                onClick={() => onSelect(t)}
              >
                <td className="px-2 py-1.5 tabular-nums text-muted-foreground">
                  {t.trialIndex}
                </td>
                <td className="px-2 py-1.5">
                  <QualityChip quality={quality} />
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
                    <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">
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
    </div>
  );
}

function QualityChip({ quality }: { quality: TrialQualityResult }) {
  const tone = quality.tone;
  const classes =
    tone === "positive"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      : tone === "warning"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400";

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium cursor-help whitespace-nowrap",
              classes,
            )}
          >
            {quality.label}
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="right"
          align="start"
          className="max-w-xs text-[11px] leading-relaxed"
        >
          {quality.reason}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
