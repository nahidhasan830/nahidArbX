"use client";

/**
 * AlphaSearch run-detail page.
 *
 * Full-width two-column canvas:
 *   Row 1 — status strip (name + badge + key metric tiles edge-to-edge)
 *   Row 2 — progress bar + optional error card
 *   Row 3 — main grid:
 *     · Left (flex-1): Pareto scatter + trials table
 *     · Right (w-[360px] on ≥1280px, stacks below): side panel
 *       · CV strategy / Pareto frontier size / overfit chips
 *       · Data-scope chips
 *       · "How to read the trials" primer
 *
 * No `max-w-[1400px]` cap — the page uses every pixel the shell exposes.
 */

import { use, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Lightbulb, X } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Toggle } from "@/components/ui/toggle";
import { TermTooltip } from "@/components/ui/TermTooltip";
import { ProviderBadge } from "@/components/ui/ProviderBadge";
import { RunStatusBadge } from "@/components/lab/alphasearch/RunStatusBadge";
import { RunProgressPanel } from "@/components/lab/alphasearch/RunProgressPanel";
import { ParetoScatter } from "@/components/lab/alphasearch/ParetoScatter";
import { TrialsTable } from "@/components/lab/alphasearch/TrialsTable";
import { TrialDrawer } from "@/components/lab/alphasearch/TrialDrawer";
import { formatMarketType } from "@/lib/formatting/labels";
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
      edgeToEdge
      actions={
        <div className="flex items-center gap-2">
          <Link href="/lab/alphasearch">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 h-7 text-[11px]"
            >
              <ChevronLeft className="size-3.5" /> All runs
            </Button>
          </Link>
          {run && (run.status === "queued" || run.status === "running") && (
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
        </div>
      }
    >
      {!run ? (
        <div className="p-6 text-xs text-muted-foreground">Loading run…</div>
      ) : (
        <div className="flex flex-col gap-4 p-4 lg:p-6">
          {/* Row 1 — status strip with edge-to-edge stat tiles */}
          <StatusStrip
            run={run}
            summary={summary}
            paretoCount={
              typeof summary?.["n_pareto"] === "number"
                ? (summary["n_pareto"] as number)
                : trials.filter((t) => t.onPareto).length
            }
          />

          {/* Row 2 — live pipeline panel while running / queued / early
              failure. Hidden for completed + cancelled runs where the
              main canvas is the useful thing to show. */}
          {(run.status === "queued" ||
            run.status === "running" ||
            run.status === "failed") && (
            <RunProgressPanel run={run} trialsCompleted={trials.length} />
          )}

          {/* Compact progress bar kept for quick-glance context on
              completed/cancelled runs (the progress panel replaces it
              during active runs). */}
          {(run.status === "completed" || run.status === "cancelled") && (
            <Progress value={pct} className="h-2" />
          )}

          {/* Row 3 — main canvas: left (charts/table) + right (side panel) */}
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-4">
            {/* Left column */}
            <div className="flex flex-col gap-4 min-w-0">
              <section className="rounded-lg border border-border/60 bg-card p-4 space-y-3">
                <header className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="space-y-0.5">
                    <h2 className="text-sm font-semibold inline-flex items-center gap-1.5">
                      <TermTooltip term="pareto">Pareto frontier</TermTooltip>
                    </h2>
                    <p className="text-[11px] text-muted-foreground max-w-[640px]">
                      Each dot is one trial.{" "}
                      <span className="text-primary font-medium">Blue</span>{" "}
                      dots are on the frontier — they offer trade-offs you
                      can&apos;t improve without making something worse. Bigger
                      dots = more bets survived the filters.
                    </p>
                  </div>
                </header>
                <ParetoScatter trials={trials} />
              </section>

              <section className="rounded-lg border border-border/60 bg-card">
                <header className="flex items-center justify-between px-4 py-2.5 border-b border-border/60">
                  <div className="flex items-center gap-3">
                    <h2 className="text-sm font-semibold">Trials</h2>
                    <span className="text-[11px] text-muted-foreground tabular-nums">
                      {trials.length.toLocaleString()}
                    </span>
                  </div>
                  <Toggle
                    size="sm"
                    pressed={paretoOnly}
                    onPressedChange={setParetoOnly}
                    className="h-7 text-[11px]"
                  >
                    Pareto only
                  </Toggle>
                </header>
                <div className="p-2">
                  <TrialsTable
                    trials={trials}
                    onSelect={(t) => {
                      setDrawerTrial(t);
                      setDrawerOpen(true);
                    }}
                  />
                </div>
              </section>
            </div>

            {/* Right column — side panel */}
            <aside className="flex flex-col gap-4 xl:sticky xl:top-4 xl:self-start">
              <SidePanelCard title="Overview">
                <CvBadge summary={summary} />
                <OverfitChips summary={summary} />
                <DataScopeChips
                  filters={
                    (run.dataFilters as Record<string, unknown> | null) ?? null
                  }
                />
              </SidePanelCard>

              <SidePanelCard
                title="How to read the trials"
                icon={<Lightbulb className="size-3.5 text-amber-500" />}
              >
                <ul className="list-disc list-outside ml-4 space-y-1.5 text-[11px] leading-relaxed text-foreground/80">
                  <li>
                    Sort by <strong>Composite</strong> — already accounts for
                    sample size, drawdown, and overfit penalty.
                  </li>
                  <li>
                    <TermTooltip term="ci">Confidence intervals</TermTooltip>{" "}
                    next to ROI show the noise band — wide CI = small sample.
                  </li>
                  <li>
                    <TermTooltip term="dsr">DSR</TermTooltip> &gt; 0.95 ≈
                    statistically real after accounting for the number of
                    trials.
                  </li>
                  <li>
                    Click any row for the full config + per-fold breakdown.
                  </li>
                </ul>
              </SidePanelCard>
            </aside>
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

// ── Row 1 — status strip ─────────────────────────────────────────────────

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

  return (
    <div className="rounded-lg border border-border/60 bg-card grid grid-cols-2 md:grid-cols-4 xl:grid-cols-5 divide-x divide-border/60 overflow-hidden">
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
      <Stat label="Seed" mono className="hidden xl:flex">
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

// ── Side panel ───────────────────────────────────────────────────────────

function SidePanelCard({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border/60 bg-card">
      <header className="px-4 py-2.5 border-b border-border/60 flex items-center gap-2">
        {icon}
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground/80">
          {title}
        </h3>
      </header>
      <div className="p-4 space-y-3">{children}</div>
    </section>
  );
}

function CvBadge({ summary }: { summary: Record<string, unknown> | null }) {
  const cv = summary?.["cv"] as Record<string, unknown> | undefined;
  if (!cv) return null;
  const type = cv["type"];
  const nPaths = cv["n_paths"];
  if (typeof type !== "string") return null;
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-muted-foreground">Cross-validation</span>
      <span className="font-medium">
        <TermTooltip term={type === "walkforward" ? "walkforward" : "cpcv"}>
          {type === "walkforward" ? "Walk-forward" : "CPCV"}
        </TermTooltip>
        {typeof nPaths === "number" && (
          <span className="text-muted-foreground ml-1.5">· {nPaths} paths</span>
        )}
      </span>
    </div>
  );
}

function OverfitChips({
  summary,
}: {
  summary: Record<string, unknown> | null;
}) {
  if (!summary) return null;
  const pbo = summary["pbo"];
  const wrc = summary["wrc_pvalue"];
  if (typeof pbo !== "number" && typeof wrc !== "number") return null;

  return (
    <div className="space-y-2 text-[11px]">
      {typeof pbo === "number" && (
        <ChipRow
          label={<TermTooltip term="pbo">PBO</TermTooltip>}
          value={`${(pbo * 100).toFixed(1)}%`}
          tone={pbo < 0.05 ? "good" : pbo < 0.3 ? "warn" : "bad"}
          note={
            pbo < 0.05
              ? "low overfit risk"
              : pbo < 0.3
                ? "watch carefully"
                : "search too aggressive"
          }
        />
      )}
      {typeof wrc === "number" && (
        <ChipRow
          label={<TermTooltip term="wrc">WRC p</TermTooltip>}
          value={wrc.toFixed(3)}
          tone={wrc < 0.05 ? "good" : wrc < 0.2 ? "warn" : "bad"}
          note={
            wrc < 0.05
              ? "beats baseline"
              : wrc < 0.2
                ? "weak evidence"
                : "indistinguishable from luck"
          }
        />
      )}
    </div>
  );
}

function ChipRow({
  label,
  value,
  tone,
  note,
}: {
  label: React.ReactNode;
  value: string;
  tone: "good" | "warn" | "bad";
  note: string;
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : "text-red-600 dark:text-red-400";
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="flex flex-col items-end text-right">
        <span className={`font-semibold tabular-nums ${toneClass}`}>
          {value}
        </span>
        <span className="text-[10px] text-muted-foreground">{note}</span>
      </span>
    </div>
  );
}

function DataScopeChips({
  filters,
}: {
  filters: Record<string, unknown> | null;
}) {
  if (!filters || Object.keys(filters).length === 0) {
    return (
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">Data scope</span>
        <span className="font-medium text-foreground/80">All settled bets</span>
      </div>
    );
  }

  const arr = (k: string) =>
    Array.isArray(filters[k]) ? (filters[k] as string[]) : [];

  return (
    <div className="space-y-2">
      <div className="text-[11px] text-muted-foreground inline-flex items-center gap-1.5">
        <TermTooltip term="data_scope">Data scope</TermTooltip>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {arr("excludeSoftProviders").map((p) => (
          <ExcludedProviderChip key={`ex-${p}`} id={p} />
        ))}
        {arr("includeSoftProviders").map((p) => (
          <IncludedProviderChip key={`in-${p}`} id={p} />
        ))}
        {arr("excludeMarketTypes").map((m) => (
          <MarketChip key={`exm-${m}`} id={m} mode="exclude" />
        ))}
        {arr("includeMarketTypes").map((m) => (
          <MarketChip key={`inm-${m}`} id={m} mode="include" />
        ))}
        {typeof filters.eventStartFrom === "string" && (
          <PlainChip>
            From {(filters.eventStartFrom as string).slice(0, 10)}
          </PlainChip>
        )}
        {typeof filters.eventStartTo === "string" && (
          <PlainChip>
            To {(filters.eventStartTo as string).slice(0, 10)}
          </PlainChip>
        )}
        {filters.placedOnly === true && <PlainChip>Placed only</PlainChip>}
      </div>
    </div>
  );
}

function PlainChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] text-foreground/80">
      {children}
    </span>
  );
}

function ExcludedProviderChip({ id }: { id: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/5 px-2 py-0.5 text-[11px] text-red-600 dark:text-red-400">
      <span>−</span>
      <ProviderBadge
        id={id}
        size="sm"
        short
        className="!border-0 !bg-transparent !text-inherit"
      />
    </span>
  );
}

function IncludedProviderChip({ id }: { id: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/5 px-2 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">
      <span>+</span>
      <ProviderBadge
        id={id}
        size="sm"
        short
        className="!border-0 !bg-transparent !text-inherit"
      />
    </span>
  );
}

function MarketChip({ id, mode }: { id: string; mode: "include" | "exclude" }) {
  const sign = mode === "include" ? "+" : "−";
  const tone =
    mode === "include"
      ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400"
      : "border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${tone}`}
    >
      <span>{sign}</span>
      {formatMarketType(id)}
    </span>
  );
}
