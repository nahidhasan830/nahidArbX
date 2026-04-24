"use client";

/**
 * AlphaSearch run-detail page.
 *
 *  - Header: status, progress, summary, cancel.
 *  - Pareto scatter (ROI vs drawdown, point size = sample size).
 *  - Trial table with sort + filter.
 *  - Trial drawer for full config + per-fold breakdown.
 */

import { use, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, X } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Toggle } from "@/components/ui/toggle";
import { TermTooltip } from "@/components/ui/TermTooltip";
import { HelpBanner } from "@/components/lab/HelpBanner";
import { RunStatusBadge } from "@/components/lab/alphasearch/RunStatusBadge";
import { ParetoScatter } from "@/components/lab/alphasearch/ParetoScatter";
import { TrialsTable } from "@/components/lab/alphasearch/TrialsTable";
import { TrialDrawer } from "@/components/lab/alphasearch/TrialDrawer";
import type {
  OptimizationRunRow,
  OptimizationTrialRow,
} from "@/lib/optimizer/repository";

const REFRESH_RUN_MS = 3_000;
const REFRESH_TRIALS_MS = 5_000;

async function fetchRun(id: string): Promise<{ run: OptimizationRunRow }> {
  const res = await fetch(`/api/optimizer/runs/${id}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`run fetch failed: ${res.status}`);
  return res.json();
}

async function fetchTrials(
  id: string,
  paretoOnly: boolean,
): Promise<{ trials: OptimizationTrialRow[] }> {
  const url = `/api/optimizer/runs/${id}/trials?limit=500${paretoOnly ? "&paretoOnly=true" : ""}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`trials fetch failed: ${res.status}`);
  return res.json();
}

export default function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const qc = useQueryClient();
  const [paretoOnly, setParetoOnly] = useState(false);
  const [drawerTrial, setDrawerTrial] = useState<OptimizationTrialRow | null>(
    null,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);

  const runQ = useQuery({
    queryKey: ["optimizer", "run", id],
    queryFn: () => fetchRun(id),
    refetchInterval: (q) => {
      const status = q.state.data?.run?.status;
      // Poll fast while running; slow once terminal.
      return status === "queued" || status === "running"
        ? REFRESH_RUN_MS
        : 30_000;
    },
  });

  const trialsQ = useQuery({
    queryKey: ["optimizer", "trials", id, paretoOnly],
    queryFn: () => fetchTrials(id, paretoOnly),
    refetchInterval: () => {
      const status = runQ.data?.run?.status;
      return status === "queued" || status === "running"
        ? REFRESH_TRIALS_MS
        : false;
    },
  });

  const cancel = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/optimizer/runs/${id}/cancel`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      toast.success("Cancellation requested");
      qc.invalidateQueries({ queryKey: ["optimizer", "run", id] });
    },
    onError: (e: Error) => toast.error(`Cancel failed: ${e.message}`),
  });

  const run = runQ.data?.run;
  const trials = trialsQ.data?.trials ?? [];
  const summary = (run?.summary as Record<string, unknown> | null) ?? null;
  const pct = useMemo(() => {
    if (!run || run.nTrialsTarget === 0) return 0;
    return Math.round((run.nTrialsDone / run.nTrialsTarget) * 100);
  }, [run]);

  return (
    <AppShell
      title={run?.name ?? "Run"}
      titleBadge={run && <RunStatusBadge status={run.status} />}
      actions={
        <div className="flex items-center gap-2">
          <Link href="/lab/alphasearch">
            <Button variant="ghost" size="sm" className="gap-1.5">
              <ChevronLeft className="size-3.5" /> All runs
            </Button>
          </Link>
          {run && (run.status === "queued" || run.status === "running") && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => cancel.mutate()}
              disabled={cancel.isPending}
            >
              <X className="size-3.5" /> Cancel
            </Button>
          )}
        </div>
      }
    >
      {!run ? (
        <p className="text-xs text-muted-foreground">Loading run…</p>
      ) : (
        <div className="max-w-[1400px] space-y-4">
          {/* Header card */}
          <div className="rounded-md border border-border/60 bg-muted/20 p-4 space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Algorithm">{run.searchAlgorithm}</Stat>
              <Stat label="Seed">{run.rngSeed}</Stat>
              <Stat
                label={<TermTooltip term="trial">Trials completed</TermTooltip>}
              >
                {run.nTrialsDone} / {run.nTrialsTarget}
              </Stat>
              <Stat
                label={
                  <TermTooltip term="composite_score">Best score</TermTooltip>
                }
              >
                {typeof summary?.["best_composite_score"] === "number"
                  ? (summary["best_composite_score"] as number).toFixed(3)
                  : "—"}
              </Stat>
            </div>
            <RunOverfitChips summary={summary} />
            <RunCvBadge summary={summary} />
          </div>
          <Progress value={pct} className="h-1.5" />
          <DataFiltersSummary
            filters={
              (run.dataFilters as Record<string, unknown> | null) ?? null
            }
          />
          {run.error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-500">
              {run.error}
            </div>
          )}

          {/* Pareto scatter */}
          <div className="rounded-md border border-border/60 p-3 space-y-2">
            <h2 className="text-xs font-medium inline-flex items-center gap-1.5">
              <TermTooltip term="pareto">Pareto frontier</TermTooltip>
            </h2>
            <p className="text-[10px] text-muted-foreground">
              Each dot is one trial. <span className="text-primary">Blue</span>{" "}
              dots are on the frontier — they offer trade-offs you can&apos;t
              improve without making something worse. Bigger dots = more bets
              survived the filters.
            </p>
            <ParetoScatter trials={trials} />
          </div>

          {/* Help banner */}
          <HelpBanner id="alphasearch-trials" title="How to read the trials">
            <ul className="list-disc list-inside space-y-1">
              <li>
                Sort by <strong>Composite</strong> for the optimizer&apos;s top
                picks (it already accounts for sample size + drawdown + overfit
                penalty).
              </li>
              <li>
                <TermTooltip term="ci">Confidence intervals</TermTooltip> next
                to ROI tell you the noise band — wide CIs = small sample.
              </li>
              <li>
                <TermTooltip term="dsr">DSR</TermTooltip> &gt; 0.95 ≈
                statistically real (after accounting for the number of trials).
              </li>
              <li>
                Click any row for the full configuration + per-fold breakdown.
              </li>
            </ul>
          </HelpBanner>

          {/* Trials table */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-medium">Trials ({trials.length})</h2>
              <Toggle
                size="sm"
                pressed={paretoOnly}
                onPressedChange={setParetoOnly}
                className="h-7 text-[11px]"
              >
                Pareto only
              </Toggle>
            </div>
            <TrialsTable
              trials={trials}
              onSelect={(t) => {
                setDrawerTrial(t);
                setDrawerOpen(true);
              }}
            />
          </div>

          <TrialDrawer
            trial={drawerTrial}
            open={drawerOpen}
            onOpenChange={setDrawerOpen}
          />
        </div>
      )}
    </AppShell>
  );
}

function Stat({
  label,
  children,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-sm font-medium tabular-nums">{children}</div>
    </div>
  );
}

/**
 * PBO + White's Reality Check chips — render only after the run completes
 * (they're populated in summary by the Python side).
 */
function RunOverfitChips({
  summary,
}: {
  summary: Record<string, unknown> | null;
}) {
  if (!summary) return null;
  const pbo = summary["pbo"];
  const wrc = summary["wrc_pvalue"];
  if (typeof pbo !== "number" && typeof wrc !== "number") return null;

  // Color thresholds — research-backed defaults.
  const pboColor =
    typeof pbo === "number"
      ? pbo < 0.05
        ? "text-emerald-600"
        : pbo < 0.3
          ? "text-amber-600"
          : "text-red-500"
      : "text-muted-foreground";
  const wrcColor =
    typeof wrc === "number"
      ? wrc < 0.05
        ? "text-emerald-600"
        : wrc < 0.2
          ? "text-amber-600"
          : "text-red-500"
      : "text-muted-foreground";

  return (
    <div className="flex flex-wrap items-center gap-3 text-[11px]">
      {typeof pbo === "number" && (
        <span className="inline-flex items-center gap-1.5">
          <TermTooltip term="pbo">PBO</TermTooltip>
          <span className={`font-medium tabular-nums ${pboColor}`}>
            {(pbo * 100).toFixed(1)}%
          </span>
          <span className="text-[10px] text-muted-foreground">
            {pbo < 0.05
              ? "low overfit risk"
              : pbo < 0.3
                ? "watch carefully"
                : "search too aggressive — narrow space or get more data"}
          </span>
        </span>
      )}
      {typeof wrc === "number" && (
        <span className="inline-flex items-center gap-1.5">
          <TermTooltip term="wrc">WRC p</TermTooltip>
          <span className={`font-medium tabular-nums ${wrcColor}`}>
            {wrc.toFixed(3)}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {wrc < 0.05
              ? "best config beats baseline (significant)"
              : wrc < 0.2
                ? "weak evidence"
                : "indistinguishable from luck"}
          </span>
        </span>
      )}
    </div>
  );
}

/**
 * Shows which CV strategy was used (CPCV / walk-forward) + path count.
 */
function RunCvBadge({ summary }: { summary: Record<string, unknown> | null }) {
  if (!summary) return null;
  const cv = summary["cv"] as Record<string, unknown> | undefined;
  if (!cv) return null;
  const type = cv["type"];
  const nPaths = cv["n_paths"];
  if (typeof type !== "string") return null;
  return (
    <div className="text-[10px] text-muted-foreground">
      <TermTooltip term={type === "walkforward" ? "walkforward" : "cpcv"}>
        {type === "walkforward" ? "Walk-forward" : "CPCV"}
      </TermTooltip>{" "}
      · {typeof nPaths === "number" ? `${nPaths} OOS paths` : ""}
    </div>
  );
}

/**
 * Compact summary of the run's pre-search data filters. Shows nothing when
 * the filter object is empty (i.e. "include every settled bet").
 */
function DataFiltersSummary({
  filters,
}: {
  filters: Record<string, unknown> | null;
}) {
  if (!filters || Object.keys(filters).length === 0) return null;

  const chips: string[] = [];
  const arr = (k: string) =>
    Array.isArray(filters[k]) ? (filters[k] as string[]) : [];
  if (arr("excludeSoftProviders").length)
    chips.push(`exclude ${arr("excludeSoftProviders").join(", ")}`);
  if (arr("includeSoftProviders").length)
    chips.push(`only ${arr("includeSoftProviders").join(", ")}`);
  if (arr("excludeMarketTypes").length)
    chips.push(`exclude markets ${arr("excludeMarketTypes").join(", ")}`);
  if (arr("includeMarketTypes").length)
    chips.push(`only markets ${arr("includeMarketTypes").join(", ")}`);
  if (typeof filters.eventStartFrom === "string")
    chips.push(`from ${filters.eventStartFrom.slice(0, 10)}`);
  if (typeof filters.eventStartTo === "string")
    chips.push(`to ${filters.eventStartTo.slice(0, 10)}`);
  if (filters.placedOnly === true) chips.push("placed only");

  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 pt-1">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        <TermTooltip term="data_scope">Data scope</TermTooltip>
      </span>
      {chips.map((c) => (
        <span
          key={c}
          className="rounded-md border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px] text-foreground/80"
        >
          {c}
        </span>
      ))}
    </div>
  );
}
