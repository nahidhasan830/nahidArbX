"use client";

/**
 * Side drawer with the full trial details. Layout is a flex column:
 *
 *   SheetHeader  ── trial #, sampler, on-line badge
 *   <scroll>     ── summary metrics, settings, per-test breakdown
 *   <footer>     ── one-line recap + Promote-to-strategy CTA (sticky)
 *
 * "Settings tried" uses `formatParam` from `lib/lab/param-labels.ts` so
 * raw keys like `min_ev_pct` / provider-id arrays render as friendly
 * labels and chips. The per-test breakdown uses `<DataTable>` so a
 * 100-fold CPCV run virtualizes cleanly inside the sheet.
 */

import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { TermTooltip } from "@/components/ui/TermTooltip";
import { DataTable } from "@/components/ui/data-table";
import { formatParam } from "@/lib/lab/param-labels";
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
  const paramEntries = Object.entries(params);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-lg !p-0 gap-0">
        <SheetHeader className="border-b border-border/60 !pb-3">
          <SheetTitle className="flex items-center gap-2 text-sm">
            Trial #{trial.trialIndex}
            {trial.onPareto && (
              <span className="text-[10px] text-emerald-600 font-medium">
                ★ On the trade-off line
              </span>
            )}
          </SheetTitle>
          <SheetDescription className="text-[13px]">
            Picked by <span className="font-medium">{trial.sampler}</span>.
            Every number below is from{" "}
            <TermTooltip term="cpcv">
              bets it never saw during training
            </TermTooltip>
            .
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4 text-xs">
          <SummarySection trial={trial} />
          <SettingsSection entries={paramEntries} />
          <FoldsSection folds={folds} />
        </div>

        <footer className="mt-auto border-t border-border/60 bg-card px-4 py-3 space-y-2">
          <p className="text-[11px] text-muted-foreground tabular-nums">
            #{trial.trialIndex} · ROI{" "}
            <span className="text-foreground font-medium">
              {fmt(trial.oosRoiMean, 2)}%
            </span>{" "}
            · {trial.sampleSize ?? "—"} bets · DSR{" "}
            <span className="text-foreground">
              {fmt(trial.deflatedSharpe, 2)}
            </span>
          </p>
          <PromoteToStrategy
            trialId={trial.id}
            defaultName={`Trial #${trial.trialIndex} — ROI ${fmt(trial.oosRoiMean, 1)}%`}
          />
        </footer>
      </SheetContent>
    </Sheet>
  );
}

// ── Summary metrics ─────────────────────────────────────────────────────

function SummarySection({ trial }: { trial: OptimizationTrialRow }) {
  return (
    <section className="space-y-1.5">
      <SectionTitle>Summary</SectionTitle>
      <div className="grid grid-cols-2 gap-1.5">
        <Metric
          label={
            <TermTooltip term="roi" value={trial.oosRoiMean ?? undefined}>
              ROI
            </TermTooltip>
          }
        >
          {fmt(trial.oosRoiMean)}%{" "}
          <span className="text-muted-foreground text-[10px]">
            [{fmt(trial.oosRoiCiLow, 1)}, {fmt(trial.oosRoiCiHigh, 1)}]
          </span>
        </Metric>
        <Metric
          label={<TermTooltip term="composite_score">Composite</TermTooltip>}
        >
          {fmt(trial.compositeScore, 3)}
        </Metric>
        <Metric
          label={
            <TermTooltip term="sortino" value={trial.oosSortino ?? undefined}>
              Sortino
            </TermTooltip>
          }
        >
          {fmt(trial.oosSortino)}
        </Metric>
        <Metric
          label={
            <TermTooltip term="sharpe" value={trial.oosSharpe ?? undefined}>
              Sharpe
            </TermTooltip>
          }
        >
          {fmt(trial.oosSharpe)}
        </Metric>
        <Metric
          label={
            <TermTooltip term="dsr" value={trial.deflatedSharpe ?? undefined}>
              DSR
            </TermTooltip>
          }
        >
          {fmt(trial.deflatedSharpe, 3)}
        </Metric>
        <Metric
          label={
            <TermTooltip
              term="psr"
              value={trial.probabilisticSharpe ?? undefined}
            >
              PSR
            </TermTooltip>
          }
        >
          {fmt(trial.probabilisticSharpe, 3)}
        </Metric>
        <Metric
          label={
            <TermTooltip term="drawdown" value={trial.maxDrawdown ?? undefined}>
              Max DD
            </TermTooltip>
          }
        >
          {fmt(trial.maxDrawdown)}
        </Metric>
        <Metric
          label={
            <TermTooltip
              term="sample_size"
              value={trial.sampleSize ?? undefined}
            >
              Sample size
            </TermTooltip>
          }
        >
          {trial.sampleSize ?? "—"}
        </Metric>
      </div>
    </section>
  );
}

// ── Settings tried ──────────────────────────────────────────────────────

function SettingsSection({ entries }: { entries: [string, unknown][] }) {
  if (entries.length === 0) {
    return (
      <section className="space-y-1.5">
        <SectionTitle>Settings tried</SectionTitle>
        <p className="text-[11px] text-muted-foreground">No params recorded.</p>
      </section>
    );
  }
  return (
    <section className="space-y-1.5">
      <SectionTitle>Settings tried</SectionTitle>
      <ul className="rounded-md border border-border/60 bg-muted/30 divide-y divide-border/40">
        {entries.map(([k, v]) => {
          const { label, rendered } = formatParam(k, v);
          return (
            <li
              key={k}
              className="flex items-start justify-between gap-3 px-3 py-1.5 text-[11px]"
            >
              <span className="text-muted-foreground shrink-0 pt-0.5">
                {label}
              </span>
              <span className="tabular-nums text-right min-w-0">
                {rendered}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── Per-fold metrics ────────────────────────────────────────────────────

function FoldsSection({ folds }: { folds: FoldMetricJson[] }) {
  const columns = React.useMemo<ColumnDef<FoldMetricJson, unknown>[]>(
    () => [
      {
        id: "path",
        accessorKey: "path_index",
        header: "Path",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {row.original.path_index}
          </span>
        ),
        meta: { initialSize: 56 },
      },
      {
        id: "n",
        accessorKey: "n_bets",
        header: "N",
        cell: ({ row }) => row.original.n_bets,
        meta: { align: "right", initialSize: 70 },
      },
      {
        id: "roi",
        accessorKey: "roi_pct",
        header: "ROI",
        cell: ({ row }) => `${fmt(row.original.roi_pct, 2)}%`,
        meta: { align: "right", initialSize: 80 },
      },
      {
        id: "sortino",
        accessorKey: "sortino",
        header: "Sortino",
        cell: ({ row }) => fmt(row.original.sortino, 2),
        meta: { align: "right", initialSize: 80 },
      },
      {
        id: "maxDD",
        accessorKey: "max_drawdown",
        header: "Max DD",
        cell: ({ row }) => fmt(row.original.max_drawdown, 2),
        meta: { align: "right", initialSize: 80 },
      },
    ],
    [],
  );

  if (folds.length === 0) {
    return (
      <section className="space-y-1.5">
        <SectionTitle>Per-test breakdown</SectionTitle>
        <p className="text-[11px] text-muted-foreground">
          No fold-level metrics recorded.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-1.5">
      <SectionTitle>
        Per-test breakdown ({folds.length} tests on unseen bets)
      </SectionTitle>
      <div className="rounded-md border border-border/60 overflow-hidden">
        <DataTable<FoldMetricJson>
          data={folds}
          columns={columns}
          getRowId={(f) => String(f.path_index)}
          enableSorting
          enableVirtualization
          density="compact"
          className="max-h-64"
        />
      </div>
    </section>
  );
}

// ── Primitives ──────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
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
