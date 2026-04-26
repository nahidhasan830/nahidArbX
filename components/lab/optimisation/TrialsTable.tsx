"use client";

/**
 * Trials table — virtualized DataTable wired to the run-detail page.
 *
 * Each row is a classified trial (`row.row` = the persisted row, `row.quality`
 * = `classifyTrial` result). Quality is computed once in the parent and
 * passed down so the breakdown panel and this table share the same buckets.
 *
 * Filtering by `showUnreliable` happens in the parent — this component
 * receives only the rows it should render.
 */

import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DataTable } from "@/components/ui/data-table";
import { cn } from "@/lib/utils";
import type { TrialQualityResult } from "@/lib/optimizer/trial-quality";
import type { OptimizationTrialRow } from "@/lib/optimizer/repository";

export interface ClassifiedTrial {
  row: OptimizationTrialRow;
  quality: TrialQualityResult;
}

const fmt = (n: number | null | string | undefined, digits = 2): string => {
  if (n === null || n === undefined) return "—";
  const v = typeof n === "string" ? Number(n) : n;
  return Number.isFinite(v) ? v.toFixed(digits) : "—";
};

const PERSISTENCE_KEY = "lab.optimisation.trials.v1";

export function TrialsTable({
  trials,
  onSelect,
  loading,
}: {
  trials: ClassifiedTrial[];
  onSelect: (trial: OptimizationTrialRow) => void;
  loading?: boolean;
}) {
  const columns = React.useMemo<ColumnDef<ClassifiedTrial, unknown>[]>(
    () => [
      {
        id: "trialIndex",
        accessorFn: (r) => r.row.trialIndex,
        header: "#",
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {row.original.row.trialIndex}
          </span>
        ),
        meta: {
          hint: "Trial index — the order the optimiser sampled this configuration.",
          initialSize: 56,
        },
      },
      {
        id: "quality",
        header: "Quality",
        cell: ({ row }) => <QualityChip quality={row.original.quality} />,
        meta: {
          hint: "Trustworthiness bucket from the shared classifier (n, DSR, CI, composite).",
          initialSize: 110,
        },
      },
      {
        id: "composite",
        accessorFn: (r) => Number(r.row.compositeScore ?? 0),
        header: "Composite",
        cell: ({ row }) => (
          <span className="font-medium">
            {fmt(row.original.row.compositeScore, 3)}
          </span>
        ),
        meta: {
          align: "right",
          hint: "Composite score blends ROI, smoothness of returns, and sample-size penalty into one number.",
          initialSize: 96,
        },
      },
      {
        id: "roi",
        accessorFn: (r) => Number(r.row.oosRoiMean ?? 0),
        header: "ROI",
        cell: ({ row }) => {
          const r = row.original.row;
          return (
            <>
              {fmt(r.oosRoiMean)}%
              <span className="text-muted-foreground ml-1 text-[10px]">
                [{fmt(r.oosRoiCiLow, 1)}, {fmt(r.oosRoiCiHigh, 1)}]
              </span>
            </>
          );
        },
        meta: {
          align: "right",
          hint: "Return on investment on bets it never saw, with the 95% believable range in brackets.",
          initialSize: 160,
        },
      },
      {
        id: "sortino",
        accessorFn: (r) => Number(r.row.oosSortino ?? 0),
        header: "Sortino",
        cell: ({ row }) => fmt(row.original.row.oosSortino, 2),
        meta: {
          align: "right",
          hint: "Smoothness of returns when only counting downside swings — higher is better.",
          initialSize: 84,
        },
      },
      {
        id: "maxDD",
        accessorFn: (r) => Number(r.row.maxDrawdown ?? 0),
        header: "Max DD",
        cell: ({ row }) => fmt(row.original.row.maxDrawdown, 2),
        meta: {
          align: "right",
          hint: "Worst peak-to-trough drop on bets it never saw — lower is better.",
          initialSize: 84,
        },
      },
      {
        id: "n",
        accessorFn: (r) => r.row.sampleSize ?? 0,
        header: "N",
        cell: ({ row }) => row.original.row.sampleSize ?? "—",
        meta: {
          align: "right",
          hint: "Number of out-of-sample bets that survived the trial's filters.",
          initialSize: 70,
        },
      },
      {
        id: "dsr",
        accessorFn: (r) => Number(r.row.deflatedSharpe ?? 0),
        header: "DSR",
        cell: ({ row }) => fmt(row.original.row.deflatedSharpe, 3),
        meta: {
          align: "right",
          hint: "Deflated Sharpe — adjusts for trial count; 0.8+ means 'unlikely to be a fluke'.",
          initialSize: 78,
        },
      },
      {
        id: "psr",
        accessorFn: (r) => Number(r.row.probabilisticSharpe ?? 0),
        header: "PSR",
        cell: ({ row }) => fmt(row.original.row.probabilisticSharpe, 3),
        meta: {
          align: "right",
          hint: "Probabilistic Sharpe — chance the true Sharpe beats the threshold.",
          initialSize: 78,
        },
      },
      {
        id: "pareto",
        accessorFn: (r) => (r.row.onPareto ? 1 : 0),
        header: "Trade-off",
        cell: ({ row }) =>
          row.original.row.onPareto ? (
            <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">
              ★ On line
            </span>
          ) : (
            <span className="text-muted-foreground text-[10px]">—</span>
          ),
        meta: {
          hint: "Whether this trial sits on the trade-off line (Pareto-frontier).",
          initialSize: 96,
        },
      },
    ],
    [],
  );

  if (!loading && trials.length === 0) {
    return (
      <p className="text-xs text-muted-foreground py-8 text-center">
        No trials match this filter.
      </p>
    );
  }

  return (
    <DataTable<ClassifiedTrial>
      data={trials}
      columns={columns}
      getRowId={(t) => t.row.id}
      enableSorting
      enableColumnResizing
      enableVirtualization
      density="compact"
      persistenceKey={PERSISTENCE_KEY}
      onRowClick={(t) => onSelect(t.row)}
      rowClassName={(t) =>
        t.quality.quality === "unreliable" ? "opacity-60" : undefined
      }
      loading={loading}
      className="max-h-[60vh]"
    />
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
  );
}
