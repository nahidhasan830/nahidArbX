"use client";

/**
 * Optimisation run-detail page.
 *
 * Single full-width canvas (no right sidebar):
 *   Row 1 — back link
 *   Row 2 — StatusStrip (Algorithm · Trials · Best score · On frontier · CV · Seed)
 *   Row 3 — RunProgressPanel / Progress bar
 *   Row 4 — ResultsReport + UnreliableWinnerBanner
 *   Row 5 — DataScopeStrip (chip strip)
 *   Row 6 — ParetoScatter (lg:flex-[2]) + TrialQualityBreakdown (lg:flex-[1])
 *   Row 7 — Trials section: TrialsToolbar + virtualized TrialsTable
 *   Drawer — TrialDrawer (modal)
 */

import { use, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { TermTooltip } from "@/components/ui/TermTooltip";
import { RunStatusBadge } from "@/components/lab/optimisation/RunStatusBadge";
import { RunProgressPanel } from "@/components/lab/optimisation/RunProgressPanel";
import { ParetoScatter } from "@/components/lab/optimisation/ParetoScatter";
import {
  ResultsReport,
  UnreliableWinnerBanner,
} from "@/components/lab/optimisation/ResultsReport";
import {
  TrialsTable,
  type ClassifiedTrial,
} from "@/components/lab/optimisation/TrialsTable";
import { TrialDrawer } from "@/components/lab/optimisation/TrialDrawer";
import {
  TrialsToolbar,
  type TrialsViewMode,
} from "@/components/lab/optimisation/TrialsToolbar";
import { TrialQualityBreakdown } from "@/components/lab/optimisation/TrialQualityBreakdown";
import { DataScopeStrip } from "@/components/lab/optimisation/DataScopeStrip";
import { classifyTrial } from "@/lib/optimizer/trial-quality";
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
  mode: TrialsViewMode,
): Promise<{ trials: OptimizationTrialRow[] }> {
  const limit = mode === "top50" ? 50 : 500;
  const paretoFlag = mode === "pareto" ? "&paretoOnly=true" : "";
  const url = `/api/optimizer/runs/${id}/trials?limit=${limit}${paretoFlag}`;
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
  const router = useRouter();
  const [viewMode, setViewMode] = useState<TrialsViewMode>("top50");
  const [showUnreliable, setShowUnreliable] = useState(false);
  const [drawerTrial, setDrawerTrial] = useState<OptimizationTrialRow | null>(
    null,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);

  const runQ = useQuery({
    queryKey: ["optimizer", "run", id],
    queryFn: () => fetchRun(id),
    refetchInterval: (q) => {
      const status = q.state.data?.run?.status;
      return status === "queued" || status === "running"
        ? REFRESH_RUN_MS
        : 30_000;
    },
  });

  const trialsQ = useQuery({
    queryKey: ["optimizer", "trials", id, viewMode],
    queryFn: () => fetchTrials(id, viewMode),
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

  const rerun = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/optimizer/runs/${id}/rerun`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { run: { id: string } };
    },
    onSuccess: (data) => {
      toast.success("New run queued — opening it now");
      qc.invalidateQueries({ queryKey: ["optimizer", "runs"] });
      router.push(`/lab/optimisation/${data.run.id}`);
    },
    onError: (e: Error) => toast.error(`Rerun failed: ${e.message}`),
  });

  const run = runQ.data?.run;
  const trials = useMemo(
    () => trialsQ.data?.trials ?? [],
    [trialsQ.data?.trials],
  );
  const trialsLoaded = trialsQ.isSuccess;
  const summary = (run?.summary as Record<string, unknown> | null) ?? null;
  const pct = useMemo(() => {
    if (!run || run.nTrialsTarget === 0) return 0;
    return Math.round((run.nTrialsDone / run.nTrialsTarget) * 100);
  }, [run]);

  // Classify once; share between the breakdown panel and the table.
  const classifiedTrials: ClassifiedTrial[] = useMemo(
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

  const visibleTrials = useMemo(
    () =>
      showUnreliable
        ? classifiedTrials
        : classifiedTrials.filter((c) => c.quality.quality !== "unreliable"),
    [classifiedTrials, showUnreliable],
  );

  const hiddenUnreliableCount = classifiedTrials.length - visibleTrials.length;

  return (
    <AppShell
      title={run?.name ?? "Run"}
      titleBadge={run && <RunStatusBadge status={run.status} />}
      edgeToEdge
      actions={
        run ? (
          <div className="flex items-center gap-1.5">
            {(run.status === "queued" || run.status === "running") && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 h-7 text-[11px]"
                onClick={() => cancel.mutate()}
                disabled={cancel.isPending}
              >
                <X className="size-3.5" /> Cancel
              </Button>
            )}
            {(run.status === "completed" ||
              run.status === "failed" ||
              run.status === "cancelled") && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 h-7 text-[11px]"
                onClick={() => rerun.mutate()}
                disabled={rerun.isPending}
              >
                <RotateCcw className="size-3.5" /> Rerun
              </Button>
            )}
          </div>
        ) : null
      }
    >
      {!run ? (
        <div className="flex-1 min-h-0 overflow-y-auto p-6 text-[13px] text-muted-foreground">
          Loading run…
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="flex flex-col gap-4 p-4 lg:p-6">
            <Link
              href="/lab/optimisation"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors self-start -mb-1"
            >
              <ChevronLeft className="size-3.5" /> All runs
            </Link>

            <StatusStrip
              run={run}
              summary={summary}
              paretoCount={
                typeof summary?.["n_pareto"] === "number"
                  ? (summary["n_pareto"] as number)
                  : trials.filter((t) => t.onPareto).length
              }
            />

            {(run.status === "queued" ||
              run.status === "running" ||
              run.status === "failed") && <RunProgressPanel run={run} />}

            {(run.status === "completed" || run.status === "cancelled") && (
              <Progress value={pct} className="h-2" />
            )}

            {run.status === "completed" &&
              (trialsLoaded ? (
                <>
                  <ResultsReport run={run} trials={trials} />
                  <UnreliableWinnerBanner run={run} trials={trials} />
                </>
              ) : (
                <ResultsReportSkeleton />
              ))}

            <DataScopeStrip
              filters={
                (run.dataFilters as Record<string, unknown> | null) ?? null
              }
            />

            <div className="flex flex-col lg:flex-row gap-4">
              <section className="rounded-lg border border-border/60 bg-card p-4 space-y-3 flex-1 lg:flex-[2] min-w-0">
                <header className="flex items-start justify-between gap-3 flex-wrap">
                  <h2 className="text-sm font-semibold inline-flex items-center gap-1.5">
                    <TermTooltip term="pareto">Trade-off line</TermTooltip>
                  </h2>
                </header>
                <ParetoScatter trials={trials} />
              </section>

              <TrialQualityBreakdown
                trials={trials}
                className="lg:flex-[1] lg:min-w-[260px]"
              />
            </div>

            <section className="rounded-lg border border-border/60 bg-card overflow-hidden">
              <header className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border/60">
                <div className="flex items-center gap-3">
                  <h2 className="text-sm font-semibold">Trials</h2>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {trials.length.toLocaleString()} loaded
                  </span>
                </div>
              </header>
              <TrialsToolbar
                viewMode={viewMode}
                onViewModeChange={setViewMode}
                showUnreliable={showUnreliable}
                onShowUnreliableChange={setShowUnreliable}
                visibleCount={visibleTrials.length}
                totalLoaded={classifiedTrials.length}
                hiddenUnreliableCount={hiddenUnreliableCount}
                onLoadAll={() => setViewMode("all")}
              />
              <div className="p-2">
                <TrialsTable
                  trials={visibleTrials}
                  onSelect={(t) => {
                    setDrawerTrial(t);
                    setDrawerOpen(true);
                  }}
                  loading={trialsQ.isLoading}
                />
              </div>
            </section>

            <TrialDrawer
              trial={drawerTrial}
              open={drawerOpen}
              onOpenChange={setDrawerOpen}
            />
          </div>
        </div>
      )}
    </AppShell>
  );
}

// ── Results report skeleton ─────────────────────────────────────────────

function ResultsReportSkeleton() {
  return (
    <section className="rounded-lg border border-border/60 bg-card overflow-hidden">
      <header className="flex items-center gap-2.5 px-5 py-3.5 border-b border-border/60 bg-muted/20">
        <Skeleton className="size-5 rounded-full" />
        <div className="space-y-1.5 flex-1">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-64" />
        </div>
      </header>
      <div className="p-5 space-y-5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-2.5 w-40" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
          </div>
        ))}
      </div>
    </section>
  );
}

// ── StatusStrip ─────────────────────────────────────────────────────────

function StatusStrip({
  run,
  summary,
  paretoCount,
}: {
  run: OptimizationRunRow;
  summary: Record<string, unknown> | null;
  paretoCount: number;
}) {
  const bestComposite =
    typeof summary?.["best_composite_score"] === "number"
      ? (summary["best_composite_score"] as number).toFixed(3)
      : "—";

  const cv = summary?.["cv"] as Record<string, unknown> | undefined;
  const cvType =
    cv && typeof cv["type"] === "string" ? (cv["type"] as string) : null;
  const cvPaths =
    cv && typeof cv["n_paths"] === "number" ? (cv["n_paths"] as number) : null;
  const cvLabel = cvType
    ? cvType === "walkforward"
      ? "Walk-forward"
      : "CPCV"
    : null;

  return (
    <div className="rounded-lg border border-border/60 bg-card grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 divide-x divide-border/60 overflow-hidden">
      <Stat label="Algorithm" mono>
        {run.searchAlgorithm}
      </Stat>
      <Stat label={<TermTooltip term="trial">Trials</TermTooltip>} mono>
        {run.nTrialsDone.toLocaleString()} /{" "}
        {run.nTrialsTarget.toLocaleString()}
      </Stat>
      <Stat
        label={<TermTooltip term="composite_score">Best score</TermTooltip>}
        mono
      >
        {bestComposite}
      </Stat>
      <Stat label={<TermTooltip term="pareto">On frontier</TermTooltip>} mono>
        {paretoCount.toLocaleString()}
      </Stat>
      <Stat
        label={
          <TermTooltip term={cvType === "walkforward" ? "walkforward" : "cpcv"}>
            Cross-validation
          </TermTooltip>
        }
      >
        {cvLabel ? (
          <span className="inline-flex items-baseline gap-1.5">
            <span>{cvLabel}</span>
            {cvPaths != null && (
              <span className="text-muted-foreground text-[11px] font-normal">
                · {cvPaths} paths
              </span>
            )}
          </span>
        ) : (
          "—"
        )}
      </Stat>
      <Stat label="Seed" mono>
        {run.rngSeed}
      </Stat>
    </div>
  );
}

function Stat({
  label,
  mono = false,
  className = "",
  children,
}: {
  label: React.ReactNode;
  mono?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`flex flex-col justify-center gap-0.5 px-4 py-3 min-w-0 ${className}`}
    >
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground truncate">
        {label}
      </div>
      <div
        className={`text-base font-semibold truncate ${mono ? "tabular-nums" : ""}`}
      >
        {children}
      </div>
    </div>
  );
}
