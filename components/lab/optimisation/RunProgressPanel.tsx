"use client";

/**
 * RunProgressPanel — CI/CD-style live pipeline view for a running run.
 *
 * Visible while the run is `queued` or `running`. Walks the operator
 * through what the sidecar is doing at any moment, with:
 *   1. A big progress bar with running trial count + percentage.
 *   2. A vertical stage list (Load → CV splits → Evaluate → Summary)
 *      with per-stage state (pending / running / done) — same vocabulary
 *      as a GitLab / GitHub-Actions pipeline. Stage status is derived
 *      heuristically from DB columns (started_at, n_trials_done,
 *      summary, status) so no backend change is required.
 *   3. A throughput + ETA readout (trials/sec and remaining time).
 *   4. A pulsing "live" dot so the operator can see data is moving.
 *
 * The panel collapses itself once the run hits a terminal status; the
 * page's existing Pareto + Trials sections take over then.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  Database,
  FileBarChart,
  Layers,
  Loader2,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";
import { TermTooltip } from "@/components/ui/TermTooltip";
import type { OptimizationRunRow } from "@/lib/optimizer/repository";

// ── Types ────────────────────────────────────────────────────────────────

export interface RunProgressPanelProps {
  run: OptimizationRunRow;
}

type StageState = "pending" | "running" | "done" | "failed";

interface Stage {
  id: string;
  label: string;
  caption: string;
  icon: React.ComponentType<{ className?: string }>;
  state: StageState;
  /** Formatted side-text: elapsed time, trial count, etc. */
  detail?: string;
}

// ── Main component ───────────────────────────────────────────────────────

export function RunProgressPanel({ run }: RunProgressPanelProps) {
  const isTerminal =
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "cancelled";

  // Throughput / ETA — tracked in a ref so we don't re-render for every
  // tick but still show a smooth number that averages over the last ~30s.
  // `nTrialsDone` is sourced from the run row (same as the top status strip),
  // not from the trials API which caps at limit=500 and would freeze the
  // panel mid-sweep on large runs.
  const done = run.nTrialsDone;
  const target = run.nTrialsTarget;
  const pct =
    target === 0 ? 0 : Math.min(100, Math.round((done / target) * 100));

  const { throughput, etaSeconds } = useThroughput({ done, target, run });

  // Fallback ETA for the early window where throughput hasn't measured yet.
  // Pulls from the historical p50 endpoint so the user sees a real number
  // immediately instead of "ETA updating…".
  const cvType = (run.cvStrategy as { type?: string } | null)?.type ?? "cpcv";
  const estimateQ = useQuery({
    queryKey: [
      "optimizer",
      "estimate",
      run.nTrialsTarget,
      cvType,
      run.searchAlgorithm,
    ],
    queryFn: async () => {
      const res = await fetch(
        `/api/optimizer/runs/estimate?nTrials=${run.nTrialsTarget}&cvStrategy=${cvType}&searchAlgorithm=${run.searchAlgorithm}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as {
        estimatedSec: number | null;
        basis: string;
        sampleSize: number;
      };
    },
    enabled: !isTerminal,
    staleTime: 60_000,
  });

  // Prefer the live throughput-based ETA; fall back to the historical p50
  // when we haven't measured throughput yet.
  const resolvedEtaSec = (() => {
    if (etaSeconds != null && etaSeconds > 0) return etaSeconds;
    const est = estimateQ.data?.estimatedSec;
    if (est == null || est <= 0) return null;
    // Scale the p50 by remaining progress — if 30% already done, show 70% of p50.
    const fracRemaining = target > 0 ? 1 - Math.min(1, done / target) : 1;
    return Math.max(1, Math.round(est * fracRemaining));
  })();
  const etaBasis =
    etaSeconds != null && etaSeconds > 0
      ? "live throughput"
      : (estimateQ.data?.basis ?? null);

  const stages = buildStages(run, done, throughput);

  // While queued, show a quieter "awaiting sidecar" card.
  if (run.status === "queued") {
    return <QueuedCard />;
  }

  if (isTerminal && run.status !== "failed") {
    // Completed or cancelled — caller should show the Pareto/trials UI.
    return null;
  }

  return (
    <section className="rounded-lg border border-border/60 bg-card overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-border/60 bg-muted/20">
        <div className="flex items-center gap-2.5 min-w-0">
          <LiveDot status={run.status} />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold inline-flex items-center gap-1.5">
              {run.status === "running" ? "Optimisation running" : "Run failed"}
              <span className="text-xs font-normal text-muted-foreground">
                ·
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {done.toLocaleString()} / {target.toLocaleString()} trials
                {target > 0 && ` · ${pct}%`}
              </span>
            </h2>
            <p className="text-[13px] text-muted-foreground leading-snug mt-0.5">
              Watching the Python sidecar. Each stage below lights up as the
              optimizer advances.
            </p>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Throughput
          </div>
          <div className="text-sm font-semibold tabular-nums">
            {throughput > 0 ? `${throughput.toFixed(1)} trial/s` : "measuring…"}
          </div>
        </div>
      </header>

      <div className="px-5 py-4 space-y-4">
        <div className="space-y-1.5">
          <Progress value={pct} className="h-2.5" />
          <div className="flex items-center justify-between text-xs tabular-nums text-muted-foreground">
            <span>
              {done.toLocaleString()} / {target.toLocaleString()}
            </span>
            <span>
              {run.status === "failed"
                ? ""
                : resolvedEtaSec != null && resolvedEtaSec > 0
                  ? `~${formatEta(resolvedEtaSec)} remaining${etaBasis ? ` · ${etaBasis}` : ""}`
                  : "ETA updating…"}
            </span>
          </div>
        </div>

        <ol className="space-y-2">
          {stages.map((s, idx) => (
            <StageRow key={s.id} stage={s} last={idx === stages.length - 1} />
          ))}
        </ol>

        {run.status === "failed" && run.error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2.5 flex items-start gap-2 text-[13px] text-red-600 dark:text-red-400">
            <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
            <span className="leading-relaxed break-words">{run.error}</span>
          </div>
        )}
      </div>
    </section>
  );
}

// ── Stage derivation (heuristic from DB columns) ─────────────────────────

function buildStages(
  run: OptimizationRunRow,
  done: number,
  throughput: number,
): Stage[] {
  const started = run.startedAt != null;
  const hasTrials = done > 0;
  const hasSummary = run.summary != null;
  const terminal =
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "cancelled";
  const failed = run.status === "failed";

  const loadState: StageState =
    failed && !started ? "failed" : started ? "done" : "running";

  const splitState: StageState =
    failed && started && !hasTrials
      ? "failed"
      : hasTrials
        ? "done"
        : started
          ? "running"
          : "pending";

  const evalState: StageState = (() => {
    if (failed && hasTrials && !hasSummary) return "failed";
    if (hasSummary || done >= run.nTrialsTarget) return "done";
    if (hasTrials || started) return "running";
    return "pending";
  })();

  const summaryState: StageState = (() => {
    if (failed && !hasSummary) return "failed";
    if (hasSummary) return "done";
    if (terminal) return "failed"; // cancelled / failed without summary
    if (done >= run.nTrialsTarget) return "running";
    return "pending";
  })();

  return [
    {
      id: "load",
      label: "Load historical bets",
      caption: "Pulls every settled bet in scope from the database.",
      icon: Database,
      state: loadState,
      detail: started ? formatTimestamp(run.startedAt) : undefined,
    },
    {
      id: "splits",
      label: "Carve up the bet history for testing",
      caption:
        run.cvStrategy &&
        (run.cvStrategy as { type?: string }).type === "walkforward"
          ? "Train on older bets, test on newer ones, slide forward in time."
          : "Splits bets into 10 groups so each strategy can be tested on bets it never trained on.",
      icon: Layers,
      state: splitState,
    },
    {
      id: "eval",
      label: "Try strategies and score them",
      caption: "Each strategy is tested on every group of unseen bets.",
      icon: Activity,
      state: evalState,
      detail:
        evalState === "running"
          ? `${done.toLocaleString()} / ${run.nTrialsTarget.toLocaleString()}${
              throughput > 0 ? ` · ${throughput.toFixed(1)}/s` : ""
            }`
          : evalState === "done"
            ? `${done.toLocaleString()} tried`
            : undefined,
    },
    {
      id: "summary",
      label: "Wrap up the report",
      caption: "Builds the trade-off line and runs the overfit safety checks.",
      icon: FileBarChart,
      state: summaryState,
    },
  ];
}

// ── Queued card ──────────────────────────────────────────────────────────

function QueuedCard() {
  return (
    <section className="rounded-lg border border-border/60 bg-card px-5 py-4 flex items-center gap-3">
      <Loader2 className="size-4 animate-spin text-primary" />
      <div className="min-w-0">
        <h2 className="text-sm font-semibold">Queued</h2>
        <p className="text-[13px] text-muted-foreground mt-0.5 leading-relaxed">
          The sidecar will pick this run up within a few seconds. Telegram
          notification fires when the run completes.
        </p>
      </div>
    </section>
  );
}

// ── Stage row ────────────────────────────────────────────────────────────

function StageRow({ stage, last }: { stage: Stage; last: boolean }) {
  const Icon = stage.icon;
  const pending = stage.state === "pending";

  return (
    <li className="flex items-stretch gap-3">
      {/* Left column: status icon + connector line */}
      <div className="flex flex-col items-center shrink-0 pt-0.5">
        <span
          className={cn(
            "inline-flex items-center justify-center size-6 rounded-full border-2 transition-colors",
            stage.state === "done" &&
              "bg-emerald-500/15 border-emerald-500 text-emerald-600 dark:text-emerald-400",
            stage.state === "running" &&
              "bg-primary/15 border-primary text-primary",
            stage.state === "failed" &&
              "bg-red-500/15 border-red-500 text-red-600 dark:text-red-400",
            pending && "bg-muted border-border text-muted-foreground",
          )}
        >
          {stage.state === "done" && <CheckCircle2 className="size-3.5" />}
          {stage.state === "running" && (
            <Loader2 className="size-3.5 animate-spin" />
          )}
          {stage.state === "failed" && <XCircle className="size-3.5" />}
          {pending && <CircleDashed className="size-3.5" />}
        </span>
        {!last && (
          <span
            className={cn(
              "flex-1 w-px mt-1 mb-0.5 min-h-[20px] transition-colors",
              stage.state === "done" ? "bg-emerald-500/40" : "bg-border",
            )}
            aria-hidden
          />
        )}
      </div>

      {/* Right column: label / caption / detail */}
      <div
        className={cn(
          "flex-1 min-w-0 pb-3 flex items-start justify-between gap-3",
          pending && "opacity-60",
        )}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Icon className="size-3.5 text-muted-foreground" />
            <span className="text-sm font-semibold">{stage.label}</span>
          </div>
          <p className="text-[13px] text-muted-foreground leading-snug mt-0.5">
            {stage.caption}
            {stage.id === "splits" && (
              <>
                {" "}
                <TermTooltip term="cpcv" iconOnly />
              </>
            )}
          </p>
        </div>
        {stage.detail && (
          <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap shrink-0 pt-0.5">
            {stage.detail}
          </span>
        )}
      </div>
    </li>
  );
}

// ── Live dot ─────────────────────────────────────────────────────────────

function LiveDot({ status }: { status: string }) {
  const color =
    status === "failed"
      ? "bg-red-500"
      : status === "running"
        ? "bg-emerald-500"
        : "bg-muted-foreground";
  return (
    <span className="relative inline-flex items-center justify-center shrink-0">
      {status === "running" && (
        <span
          className={cn(
            "absolute inline-flex size-3 rounded-full opacity-60 animate-ping",
            color,
          )}
        />
      )}
      <span className={cn("relative inline-flex size-2 rounded-full", color)} />
    </span>
  );
}

// ── Throughput + ETA hook ────────────────────────────────────────────────

interface UseThroughputArgs {
  done: number;
  target: number;
  run: OptimizationRunRow;
}

function useThroughput({ done, target, run }: UseThroughputArgs): {
  throughput: number;
  etaSeconds: number | null;
} {
  // Track the last 60s of progress so we can estimate rate & ETA without
  // jitter. Sample state drives a useEffect-based recompute every 1s so
  // the ticker stays live even when `done` doesn't change between polls.
  const samples = React.useRef<Array<{ t: number; done: number }>>([]);
  const [metrics, setMetrics] = React.useState<{
    throughput: number;
    etaSeconds: number | null;
  }>({ throughput: 0, etaSeconds: null });

  // Record a sample each time `done` ticks.
  React.useEffect(() => {
    if (run.status !== "running" && run.status !== "queued") {
      samples.current = [];
      return;
    }
    const now = Date.now();
    samples.current.push({ t: now, done });
    const cutoff = now - 60_000;
    samples.current = samples.current.filter((s) => s.t >= cutoff);
  }, [done, run.status]);

  // Recompute the throughput/ETA readout every second while running so
  // the display animates even between DB polls. All time-dependent math
  // lives inside the effect — render stays pure.
  React.useEffect(() => {
    if (run.status !== "running") {
      setMetrics({ throughput: 0, etaSeconds: null });
      return;
    }
    const compute = () => {
      const arr = samples.current;
      let throughput = 0;
      if (arr.length >= 2) {
        const first = arr[0];
        const last = arr[arr.length - 1];
        const dt = (last.t - first.t) / 1000;
        const dd = last.done - first.done;
        throughput = dt > 0 ? Math.max(0, dd / dt) : 0;
      } else if (run.startedAt) {
        const startedMs = new Date(run.startedAt).getTime();
        const elapsed = (Date.now() - startedMs) / 1000;
        if (elapsed > 1 && done > 0) throughput = done / elapsed;
      }
      const remaining = Math.max(0, target - done);
      const eta = throughput > 0 ? Math.round(remaining / throughput) : null;
      setMetrics({ throughput, etaSeconds: eta });
    };
    compute();
    const id = setInterval(compute, 1000);
    return () => clearInterval(id);
  }, [run.status, run.startedAt, done, target]);

  return metrics;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
}

function formatTimestamp(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
