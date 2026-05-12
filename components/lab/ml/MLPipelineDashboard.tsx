"use client";

/**
 * ML Optimizer Dashboard — compact guided operator layout.
 *
 * Split into composable sub-modules under dashboard/ for maintainability.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Cpu,
  Zap,
  AlertTriangle,
  Check,
  LayoutDashboard,
  Route,
  RefreshCw,
  ShieldCheck,
  Clock,
  Power,
  GitBranch,
  Activity,
  CheckCircle2,
  ServerCrash,
  ShieldAlert,
  LineChart,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { TabsContent } from "@/components/ui/tabs";
import { AppShell } from "@/components/nav/AppShell";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { TermTooltip } from "@/components/ui/TermTooltip";
import { cn } from "@/lib/utils";
import { FEATURE_CATALOG, CATEGORY_COLORS } from "@/lib/ml/feature-catalog";
import { RetrainButton } from "./MLModelStatus";
import { toast } from "sonner";
import {
  useMLTrainingStream,
  type MLTrainingState,
} from "@/components/hooks/useMLTrainingStream";
import { TrainingDataTable } from "./TrainingDataTable";
import { ModelHistoryTable } from "./ModelHistoryTable";
import type { MLTrainingUpdate } from "@/lib/events/event-bus";
import { ShadowTab } from "./dashboard/ShadowTab";
import { ChampionChallengerCard } from "./dashboard/ChampionChallengerCard";
import {
  Stat,
  SectionTitle,
  CompactPanel,
  Kv,
  STAGES,
  getStageStatuses,
  firstIncompleteStep,
  statusTone,
  statusLabel,
  OptimizerStatusPill,
} from "./dashboard/shared";
import type { StageStatus } from "./dashboard/types";

// Re-export types so existing imports from this file still work
export type { PipelineData, StageStatus } from "./dashboard/types";
import type { PipelineData } from "./dashboard/types";

// ── Query ─────────────────────────────────────────────────────────────

export function usePipeline() {
  return useQuery<PipelineData>({
    queryKey: ["ml", "pipeline"],
    queryFn: async () => {
      const res = await fetch("/api/ml/pipeline", { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    refetchInterval: (query) => {
      const state = query.state.data as PipelineData | undefined;
      return state?.training?.modelsInTraining ? 3000 : 15000;
    },
    retry: 1,
  });
}

// Stage helpers, status helpers, and UI primitives are now in dashboard/shared.tsx

// Shared UI components (Stat, HelpTip, SectionTitle, CompactPanel, Kv, OptimizerStatusPill)
// are now imported from dashboard/shared.tsx

// ── Main Dashboard ────────────────────────────────────────────────────

export function MLPipelineDashboard() {
  const { data, isLoading, isError, error, refetch, isFetching } =
    usePipeline();
  const [activeTab, setActiveTab] = useState<string>("overview");
  const trainingStream = useMLTrainingStream();
  const qc = useQueryClient();

  // Hydrate training state from polled pipeline data (persists across page refresh)
  const activeTraining = data?.training?.activeTraining;
  useEffect(() => {
    trainingStream.hydrateFromPipeline(activeTraining ?? null);
  }, [activeTraining]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refetch pipeline + model data when training reaches a terminal state
  const terminalPhase = trainingStream.currentTraining?.phase;
  const terminalModelId = trainingStream.currentTraining?.modelId;
  const prevTerminalRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      terminalPhase &&
      ["completed", "failed", "rejected"].includes(terminalPhase) &&
      terminalModelId !== prevTerminalRef.current
    ) {
      prevTerminalRef.current = terminalModelId ?? null;
      // Refetch pipeline diagnostics and model history
      void refetch();
      void qc.invalidateQueries({ queryKey: ["ml"] });
    }
  }, [terminalPhase, terminalModelId, refetch, qc]);

  if (isLoading) {
    return (
      <AppShell title="ML Optimizer" edgeToEdge>
        <div className="flex flex-1 items-center justify-center bg-background">
          <div className="flex flex-col items-center gap-3">
            <div className="size-8 rounded-full border-2 border-cyan-500/20 border-t-cyan-500 animate-spin" />
            <p className="text-cyan-500/70 font-mono text-[10px] uppercase tracking-widest animate-pulse">
              Booting...
            </p>
          </div>
        </div>
      </AppShell>
    );
  }

  if (isError || !data) {
    return (
      <TooltipProvider delayDuration={150}>
        <AppShell title="ML Optimizer" edgeToEdge>
          <div className="flex flex-1 items-center justify-center bg-background p-4">
            <div className="max-w-md rounded-2xl border border-rose-500/30 bg-rose-500/10 p-5 backdrop-blur-xl text-center">
              <AlertTriangle className="size-6 text-rose-400 mx-auto mb-2" />
              <h2 className="text-sm font-bold uppercase text-rose-400 mb-1">
                System Offline
              </h2>
              <p className="text-[11px] text-white/70 mb-3">
                `/api/ml/pipeline` failed. Verify DB & engine.
              </p>
              <div className="rounded-lg bg-background/50 border border-white/10 p-2 font-mono text-[10px] text-rose-300/90 truncate mb-3">
                {error instanceof Error ? error.message : "Unknown error"}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refetch()}
                disabled={isFetching}
                className="h-7 text-xs border-white/10 hover:bg-white/10 text-white w-full"
              >
                <RefreshCw
                  className={cn("mr-1.5 size-3", isFetching && "animate-spin")}
                />{" "}
                Retry Connection
              </Button>
            </div>
          </div>
        </AppShell>
      </TooltipProvider>
    );
  }

  const statuses = getStageStatuses(data);

  return (
    <TooltipProvider delayDuration={150}>
      <AppShell
        title="ML Optimizer"
        edgeToEdge
        tabs={[
          { value: "overview", label: "Overview", icon: LayoutDashboard },
          { value: "guide", label: "Guided setup", icon: Route },
          { value: "shadow", label: "Paper test", icon: LineChart },
        ]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      >
        <div className="relative flex flex-col flex-1 min-h-0 bg-background overflow-hidden text-foreground">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden" />

          <div className="relative z-10 flex flex-col flex-1 min-h-0 p-3 max-w-[1920px] mx-auto w-full">
            <TabsContent
              value="overview"
              className="flex-1 min-h-0 mt-0 outline-none"
            >
              <OverviewTab
                data={data}
                statuses={statuses}
                trainingStream={trainingStream}
              />
            </TabsContent>
            <TabsContent
              value="guide"
              className="flex-1 min-h-0 mt-0 outline-none"
            >
              <SetupGuideTab
                data={data}
                statuses={statuses}
                trainingStream={trainingStream}
              />
            </TabsContent>
            <TabsContent
              value="shadow"
              className="flex-1 min-h-0 mt-0 outline-none"
            >
              <ShadowTab />
            </TabsContent>
          </div>
        </div>
      </AppShell>
    </TooltipProvider>
  );
}

// ── Overview Tab ──────────────────────────────────────────────────────

function OverviewTab({
  data: d,
  statuses,
  trainingStream,
}: {
  data: PipelineData;
  statuses: StageStatus[];
  trainingStream: MLTrainingState;
}) {
  const coldDone = d.dataCollection.coldStartProgress >= 100;
  const contractHealthy =
    d.featureContract.allVersionsMatch &&
    d.featureContract.allLengthsMatch &&
    d.featureContract.allSemanticChecksPass;
  const hasDiagnosticWarning =
    !contractHealthy ||
    d.rejectedModels.length > 0 ||
    Boolean(d.inference.error) ||
    Boolean(d.scheduler.lastError || d.schedulerSettings?.lastError);
  const [showDetails, setShowDetails] = useState(false);
  const detailsOpen = showDetails || hasDiagnosticWarning;
  const paper = d.paperEvaluation;
  const paperDelta = paper.verdict.mlMinusSimpleRoiPct;
  const modelLoaded = d.inference.modelLoaded;
  const activeTraining =
    trainingStream.isTraining || d.training.modelsInTraining > 0;
  const headline = !contractHealthy
    ? "Clean the training set before judging the model"
    : activeTraining
      ? "A candidate model is building"
      : !coldDone
        ? "Collect more settled examples"
        : !modelLoaded
          ? "Ready for first training"
          : !paper.verdict.enoughMlGateSamples
            ? "Paper test needs more settled outcomes"
            : paper.verdict.mlBeatsSimpleRule
              ? "ML edge is ahead on paper"
              : "Simple rule is still ahead";
  const summary = !contractHealthy
    ? `${d.featureContract.semanticChecks.badLabeledCompetitionTier.toLocaleString()} labeled rows have inconsistent league-strength signals. Regenerate or exclude them before using model metrics.`
    : activeTraining
      ? `Training is running against ${d.dataCollection.qualifiedForTraining.toLocaleString()} clean examples. The dashboard will refresh when the job exits.`
      : !coldDone
        ? `${Math.max(0, d.dataCollection.coldStartThreshold - d.dataCollection.qualifiedForTraining).toLocaleString()} more clean settled bets are needed for a reliable first model.`
        : !modelLoaded
          ? "The dataset has enough examples. Start training to create a shadow model candidate."
          : !paper.verdict.enoughMlGateSamples
            ? `Only ${paper.metrics.mlGate.sampleSize.toLocaleString()} settled model-gate paper bets are available. Keep collecting outcomes.`
            : paper.verdict.mlBeatsSimpleRule
              ? `The model-gated paper cohort is ahead by ${paperDelta?.toFixed(2)} return points versus the simple EV rule.`
              : `The simple EV rule is ahead by ${Math.abs(paperDelta ?? 0).toFixed(2)} return points. Keep ML in observe-only mode.`;

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pb-3">
      {trainingStream.currentTraining && (
        <div className="shrink-0">
          <LiveTrainingPanel
            training={trainingStream.currentTraining}
            log={trainingStream.trainingLog}
            isConnected={trainingStream.isConnected}
            dataCount={d.dataCollection.qualifiedForTraining}
          />
        </div>
      )}

      <section className="grid shrink-0 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.8fr)]">
        <div className="relative overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 backdrop-blur-xl">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-cyan-400/0 via-cyan-300/60 to-cyan-400/0" />
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <OptimizerStatusPill data={d} />
              <h1 className="mt-3 max-w-3xl text-2xl font-semibold tracking-tight text-white">
                {headline}
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-relaxed text-white/65">
                {summary}
              </p>
            </div>
            {coldDone && (
              <RetrainButton
                size="sm"
                hasExistingModel={d.training.totalModels > 0}
                isTraining={activeTraining}
                trainingVersion={
                  trainingStream.currentTraining?.version ??
                  d.training.activeTraining?.version
                }
              />
            )}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Stat
              label="Real examples"
              value={d.dataCollection.qualifiedForTraining.toLocaleString()}
              tone={coldDone ? "text-emerald-400" : "text-cyan-300"}
              variant="hero"
            />
            <Stat
              label="Model vs rule"
              value={formatSignedPoints(paperDelta)}
              tone={
                paperDelta == null
                  ? "text-white/35"
                  : paperDelta >= 0
                    ? "text-emerald-400"
                    : "text-rose-400"
              }
              variant="hero"
            />
            <Stat
              label="Allowed mode"
              value={d.deploymentGate.permissionLevel.replaceAll("_", " ")}
              tone={
                d.deploymentGate.canGate || d.deploymentGate.canReduceStake
                  ? "text-emerald-400"
                  : "text-indigo-300"
              }
              variant="hero"
            />
            <Stat
              label="Scored bets"
              value={d.inference.totalScored.toLocaleString()}
              tone={modelLoaded ? "text-cyan-300" : "text-white/35"}
              variant="hero"
            />
          </div>
        </div>

        <NextActionPanel data={d} />
      </section>

      <section className="grid shrink-0 grid-cols-1 gap-3 xl:grid-cols-3">
        <PaperEvaluationCard data={d} />
        <ReadinessPanel data={d} contractHealthy={contractHealthy} />
        <PermissionPanel data={d} />
      </section>

      {(d.championChallenger?.champion || d.championChallenger?.challenger) && (
        <ChampionChallengerCard
          champion={d.championChallenger.champion}
          challenger={d.championChallenger.challenger}
        />
      )}

      <PipelineRail statuses={statuses} data={d} isTraining={activeTraining} />

      <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] backdrop-blur-xl">
        <div className="flex items-center justify-between gap-3 px-3 py-2">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white">
                Details
              </span>
              {hasDiagnosticWarning && (
                <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-amber-300">
                  Review needed
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-white/55">
              Model history, training rows, schedule settings, and edge-bucket
              diagnostics stay here unless you need to investigate.
            </p>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setShowDetails((v) => !v)}
                className="inline-flex size-8 items-center justify-center rounded-md border border-white/10 bg-white/[0.03] text-white/55 transition hover:border-cyan-400/40 hover:text-cyan-300"
              >
                {detailsOpen ? (
                  <ChevronUp className="size-4" />
                ) : (
                  <ChevronDown className="size-4" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {detailsOpen ? "Hide ML optimizer details." : "Show ML optimizer details."}
            </TooltipContent>
          </Tooltip>
        </div>

        {detailsOpen ? (
          <div className="grid grid-cols-1 gap-3 border-t border-white/[0.06] p-3 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.2fr)]">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-1">
              <SchedulerConfigPanel data={d} />
              <EdgeBucketPanel data={d} />
              <PaperLearningCurvePanel data={d} />
            </div>
            <div className="min-h-[420px] overflow-hidden rounded-xl border border-white/[0.05] bg-background/30">
              <ModelHistoryTable models={d.modelHistory ?? []} />
              <TrainingDataTable />
            </div>
          </div>
        ) : (
          <p className="border-t border-white/[0.06] px-3 py-2 text-sm text-white/55">
            Hidden by default. Open details when a warning appears or when you
            need to inspect the exact rows behind a training run.
          </p>
        )}
      </div>
    </div>
  );
}

function ReadinessPanel({
  data: d,
  contractHealthy,
}: {
  data: PipelineData;
  contractHealthy: boolean;
}) {
  const coldDone = d.dataCollection.coldStartProgress >= 100;
  return (
    <CompactPanel
      title="Readiness"
      help="Shows whether real settled data and feature contracts are strong enough for training."
    >
      <div className="mb-3">
        <div className="mb-1.5 flex items-center justify-between text-[10px] font-bold uppercase tracking-widest text-white/45">
          <span>
            {d.dataCollection.qualifiedForTraining.toLocaleString()} /{" "}
            {d.dataCollection.coldStartThreshold.toLocaleString()}
          </span>
          <span className={coldDone ? "text-emerald-400" : "text-cyan-300"}>
            {d.dataCollection.coldStartProgress}%
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-white/10">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-700",
              coldDone ? "bg-emerald-500" : "bg-cyan-500",
            )}
            style={{
              width: `${Math.min(d.dataCollection.coldStartProgress, 100)}%`,
            }}
          />
        </div>
      </div>

      <div className="space-y-1">
        <Kv
          label="Recent signal rate"
          value={`${d.dataCollection.recentFeatureRate}%`}
          tone={
            d.dataCollection.recentFeatureRate >= 80
              ? "text-emerald-400"
              : "text-amber-400"
          }
        />
        <Kv
          label="Feature contract"
          value={contractHealthy ? "Clean" : "Review"}
          tone={contractHealthy ? "text-emerald-400" : "text-rose-400"}
        />
        <Kv
          label="Clean examples"
          value={d.featureContract.semanticChecks.cleanLabeledExamples.toLocaleString()}
          tone="text-cyan-300"
        />
        <Kv
          label="League coverage"
          value={`${d.enrichmentCoverage.coveragePct}%`}
          tone={
            d.enrichmentCoverage.coveragePct >= 80
              ? "text-emerald-400"
              : "text-amber-400"
          }
        />
      </div>
    </CompactPanel>
  );
}

function PermissionPanel({ data: d }: { data: PipelineData }) {
  const canAffectBets =
    d.deploymentGate.canGate || d.deploymentGate.canReduceStake;
  return (
    <CompactPanel
      title="Live authority"
      help="Shows whether ML is observing only or allowed to change placement behavior."
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-white">
            {d.scoringMode}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-white/55">
            {canAffectBets
              ? "ML can now affect automatic placement. Watch paper and real outcomes closely."
              : "ML is not allowed to alter stakes or skip bets yet."}
          </p>
        </div>
        <ShieldCheck
          className={cn(
            "size-5 shrink-0",
            canAffectBets ? "text-emerald-400" : "text-indigo-300",
          )}
        />
      </div>
      <div className="space-y-1">
        <Kv
          label="Model loaded"
          value={
            d.inference.modelLoaded ? `v${d.inference.modelVersion}` : "No"
          }
          tone={d.inference.modelLoaded ? "text-emerald-400" : "text-white/35"}
        />
        <Kv
          label="Average latency"
          value={`${d.inference.avgInferenceMs.toFixed(2)}ms`}
          tone="text-cyan-300"
        />
        <Kv
          label="Can skip bets"
          value={d.deploymentGate.canGate ? "Yes" : "No"}
          tone={d.deploymentGate.canGate ? "text-emerald-400" : "text-white/35"}
        />
        <Kv
          label="Can reduce stake"
          value={d.deploymentGate.canReduceStake ? "Yes" : "No"}
          tone={
            d.deploymentGate.canReduceStake
              ? "text-emerald-400"
              : "text-white/35"
          }
        />
      </div>
      {d.inference.error && (
        <p className="mt-3 rounded-md border border-rose-500/20 bg-rose-500/10 p-2 text-sm leading-relaxed text-rose-300">
          {d.inference.error}
        </p>
      )}
    </CompactPanel>
  );
}

function EdgeBucketPanel({ data: d }: { data: PipelineData }) {
  return (
    <CompactPanel
      title="Model edge buckets"
      help="Settled ML-scored bets grouped by model EV at the offered odds. This matches the real gating policy better than raw score bands."
      className="min-h-[210px]"
    >
      {d.scoreBucketROI.some((b) => b.count > 0) ? (
        <div className="flex h-full flex-col">
          <div className="grid grid-cols-[1fr_0.7fr_0.8fr_0.8fr] gap-x-2 border-b border-white/[0.08] pb-1 text-[9px] font-bold uppercase tracking-widest text-white/40">
            <span>Edge</span>
            <span className="text-right">N</span>
            <span className="text-right">Return</span>
            <span className="text-right">Win</span>
          </div>
          <div className="mt-1 space-y-px">
            {d.scoreBucketROI.map((b) => (
              <Tooltip key={b.bucket}>
                <TooltipTrigger asChild>
                  <div className="grid grid-cols-[1fr_0.7fr_0.8fr_0.8fr] items-center gap-x-2 rounded px-1 py-1 transition hover:bg-white/[0.04]">
                    <span className="font-mono text-[11px] text-white/70">
                      {b.bucket}
                    </span>
                    <span className="text-right font-mono text-[11px] text-white/80">
                      {b.count.toLocaleString()}
                    </span>
                    <span
                      className={cn(
                        "text-right font-mono text-[11px]",
                        b.avgPnl > 0
                          ? "text-emerald-400"
                          : b.avgPnl < 0
                            ? "text-rose-400"
                            : "text-white/35",
                      )}
                    >
                      {b.count > 0 ? `${b.avgPnl.toFixed(1)}%` : "—"}
                    </span>
                    <span className="text-right font-mono text-[11px] text-white/70">
                      {b.count > 0 ? `${b.winRate.toFixed(1)}%` : "—"}
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent className="text-xs">
                  Average model edge:{" "}
                  {b.avgEdge == null ? "not available" : `${b.avgEdge}%`}
                  {b.count > 0 ? ` · CLV ${b.avgClv.toFixed(2)}%` : ""}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-[10px] font-mono text-white/30">
          Awaiting settled scored bets
        </div>
      )}
    </CompactPanel>
  );
}

// ── Custom Panels ─────────────────────────────────────────────────────

const TYPICAL_TRAINING_DURATION_MS = 15 * 60 * 1000; // ~15 minutes typical (includes Cloud Run cold start)

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function formatPct(value: number | null, digits = 1): string {
  return value == null ? "—" : `${value.toFixed(digits)}%`;
}

function formatSignedPoints(value: number | null): string {
  if (value == null) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)} pts`;
}

function roiTone(value: number | null): string {
  if (value == null) return "text-white/35";
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-rose-400";
  return "text-white/60";
}

function LiveTrainingPanel({
  training,
  log,
  isConnected,
  dataCount,
}: {
  training: MLTrainingUpdate;
  log: MLTrainingUpdate[];
  isConnected: boolean;
  /** Number of settled vectors being used for training. */
  dataCount: number;
}) {
  const isTerminal = ["completed", "failed", "rejected"].includes(
    training.phase,
  );

  // Elapsed timer: server provides base, local interval ticks for smoothness.
  const serverElapsedMs = training.elapsedMs ?? 0;
  const [tickMs, setTickMs] = useState(0);

  useEffect(() => {
    if (isTerminal) return;
    let first = true;
    const interval = setInterval(() => {
      setTickMs((prev) => {
        if (first) {
          first = false;
          return 0;
        }
        return prev + 1_000;
      });
    }, 1_000);
    return () => clearInterval(interval);
  }, [isTerminal, serverElapsedMs]);

  const elapsed = serverElapsedMs + tickMs;

  // Estimated progress based on typical training duration
  const progressPct = isTerminal
    ? 100
    : Math.min(Math.round((elapsed / TYPICAL_TRAINING_DURATION_MS) * 100), 99);
  const estimatedRemaining = Math.max(
    0,
    TYPICAL_TRAINING_DURATION_MS - elapsed,
  );

  // Determine banner color based on terminal state
  const bannerColor =
    training.phase === "completed"
      ? "border-emerald-500/40 bg-emerald-500/10"
      : training.phase === "failed"
        ? "border-red-500/40 bg-red-500/10"
        : training.phase === "rejected"
          ? "border-amber-500/40 bg-amber-500/10"
          : "border-cyan-500/40 bg-cyan-500/10";

  const glowColor =
    training.phase === "completed"
      ? "bg-emerald-500 shadow-[0_0_12px_rgba(16,185,129,0.8)]"
      : training.phase === "failed"
        ? "bg-red-500 shadow-[0_0_12px_rgba(239,68,68,0.8)]"
        : training.phase === "rejected"
          ? "bg-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.8)]"
          : "bg-cyan-500 shadow-[0_0_12px_rgba(34,211,238,0.8)]";

  const textColor =
    training.phase === "completed"
      ? "text-emerald-400"
      : training.phase === "failed"
        ? "text-red-400"
        : training.phase === "rejected"
          ? "text-amber-400"
          : "text-cyan-400";

  return (
    <div
      className={cn(
        "rounded-xl border p-3 transition-all duration-500",
        bannerColor,
      )}
    >
      {/* Header row */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "size-2 rounded-full",
              glowColor,
              !isTerminal && "animate-pulse",
            )}
          />
          <span
            className={cn(
              "text-[10px] font-extrabold uppercase tracking-widest",
              textColor,
            )}
          >
            {isTerminal
              ? training.phase === "completed"
                ? "Training Complete"
                : training.phase === "rejected"
                  ? "Model Rejected"
                  : "Training Failed"
              : "Model Build Running"}
          </span>
          <span className="text-[10px] font-bold text-white/60">
            v{training.version}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {isConnected && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-1 text-[9px] text-emerald-400/70">
                  <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Live
                </span>
              </TooltipTrigger>
              <TooltipContent>
                Live progress updates from the server.
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Metrics row — training-specific data (not pipeline phases) */}
      <div className="grid grid-cols-4 gap-2 mb-2.5">
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5">
          <div className="text-[8px] font-bold uppercase tracking-wider text-white/40">
            Examples
          </div>
          <div className="text-sm font-bold tabular-nums text-white">
            {dataCount.toLocaleString()}
          </div>
          <div className="text-[8px] text-white/30">settled bets</div>
        </div>
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5">
          <div className="text-[8px] font-bold uppercase tracking-wider text-white/40">
            Elapsed
          </div>
          <div
            className={cn(
              "text-sm font-bold tabular-nums font-mono",
              textColor,
            )}
          >
            {formatElapsed(elapsed)}
          </div>
          <div className="text-[8px] text-white/30">
            {isTerminal ? "total" : "running"}
          </div>
        </div>
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5">
          <div className="text-[8px] font-bold uppercase tracking-wider text-white/40">
            {isTerminal ? "Result" : "ETA"}
          </div>
          <div className="text-sm font-bold tabular-nums text-white">
            {isTerminal
              ? training.phase === "completed"
                ? "Deployed"
                : training.phase === "rejected"
                  ? "Rejected"
                  : "Failed"
              : estimatedRemaining > 0
                ? `~${formatElapsed(estimatedRemaining)}`
                : "Finalizing..."}
          </div>
          <div className="text-[8px] text-white/30">
            {isTerminal ? training.phase : "remaining"}
          </div>
        </div>
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5">
          <div className="text-[8px] font-bold uppercase tracking-wider text-white/40">
            Progress
          </div>
          <div className={cn("text-sm font-bold tabular-nums", textColor)}>
            {progressPct}%
          </div>
          <div className="text-[8px] text-white/30">estimated</div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="mb-2">
        <div className="h-2 overflow-hidden rounded-full bg-white/10">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-1000",
              glowColor,
            )}
            style={{ width: `${progressPct}%` }}
          />
        </div>
        {!isTerminal && (
          <div className="flex justify-between mt-1 text-[8px] text-white/30 font-mono">
            <span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help border-b border-dotted border-white/20">
                    Safe validation
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-[280px] text-xs leading-relaxed">
                  The trainer checks the model on hidden past bets from
                  different time periods so it cannot pass by memorizing one run
                  of results.
                </TooltipContent>
              </Tooltip>{" "}
              · 25 market signals · {dataCount.toLocaleString()} examples
            </span>
            <span>
              {estimatedRemaining > 0
                ? `~${formatElapsed(estimatedRemaining)} remaining`
                : `${formatElapsed(elapsed)} elapsed — finalizing`}
            </span>
          </div>
        )}
      </div>

      {/* Status Message */}
      <div className="flex items-center gap-2">
        {!isTerminal && (
          <Activity className={cn("size-3 animate-pulse", textColor)} />
        )}
        <p className="text-xs font-medium text-white/80">{training.message}</p>
      </div>

      {/* Metrics (for completed/rejected) */}
      {training.metrics && (
        <div className="mt-2 grid grid-cols-4 gap-2">
          {training.metrics.aucRoc != null && (
            <div className="rounded-md border border-white/5 bg-white/5 px-2 py-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="cursor-help text-[8px] font-bold uppercase tracking-wider text-white/40">
                    Winner separation
                  </div>
                </TooltipTrigger>
                <TooltipContent className="max-w-[260px] text-xs">
                  How well the model ranks better bets above worse bets. Higher
                  is better.
                </TooltipContent>
              </Tooltip>
              <div
                className={cn(
                  "text-xs font-bold tabular-nums",
                  (training.metrics.aucRoc ?? 0) > 0.55
                    ? "text-emerald-400"
                    : "text-amber-400",
                )}
              >
                {training.metrics.aucRoc.toFixed(4)}
              </div>
            </div>
          )}
          {training.metrics.dsr != null && (
            <div className="rounded-md border border-white/5 bg-white/5 px-2 py-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="cursor-help text-[8px] font-bold uppercase tracking-wider text-white/40">
                    Luck check
                  </div>
                </TooltipTrigger>
                <TooltipContent className="max-w-[260px] text-xs">
                  Discounts performance because many settings were tried. A
                  higher score means the result is less likely to be luck.
                </TooltipContent>
              </Tooltip>
              <div
                className={cn(
                  "text-xs font-bold tabular-nums",
                  (training.metrics.dsr ?? 0) > 0.8
                    ? "text-emerald-400"
                    : "text-amber-400",
                )}
              >
                {training.metrics.dsr.toFixed(3)}
              </div>
            </div>
          )}
          {training.metrics.pbo != null && (
            <div className="rounded-md border border-white/5 bg-white/5 px-2 py-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="cursor-help text-[8px] font-bold uppercase tracking-wider text-white/40">
                    Memory risk
                  </div>
                </TooltipTrigger>
                <TooltipContent className="max-w-[260px] text-xs">
                  The chance the model mostly memorized old results instead of
                  learning a pattern that should repeat.
                </TooltipContent>
              </Tooltip>
              <div
                className={cn(
                  "text-xs font-bold tabular-nums",
                  (training.metrics.pbo ?? 0) < 0.5
                    ? "text-emerald-400"
                    : "text-rose-400",
                )}
              >
                {Number(training.metrics.pbo ?? 0) > 0
                  ? training.metrics.pbo.toFixed(3)
                  : "n/a"}
              </div>
            </div>
          )}
          {training.metrics.permissionLevel && (
            <div className="rounded-md border border-white/5 bg-white/5 px-2 py-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="cursor-help text-[8px] font-bold uppercase tracking-wider text-white/40">
                    Allowed actions
                  </div>
                </TooltipTrigger>
                <TooltipContent className="max-w-[260px] text-xs">
                  What the approved model may do: observe only, skip weak bets,
                  or reduce weak stakes.
                </TooltipContent>
              </Tooltip>
              <div className="text-[10px] font-bold text-white">
                {training.metrics.permissionLevel}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Rejection reasons */}
      {training.metrics?.rejectionReasons &&
        training.metrics.rejectionReasons.length > 0 && (
          <div className="mt-2 space-y-1">
            {training.metrics.rejectionReasons.slice(0, 3).map((r, i) => (
              <div
                key={i}
                className="flex items-start gap-1.5 text-[10px] text-amber-300/80"
              >
                <AlertTriangle className="size-3 mt-px shrink-0" />
                <span>{r}</span>
              </div>
            ))}
          </div>
        )}

      {/* Recent Activity Log (last 3 entries) */}
      {log.length > 1 && (
        <div className="mt-2 border-t border-white/5 pt-2">
          <div className="text-[8px] font-bold uppercase tracking-widest text-white/30 mb-1">
            Activity Log
          </div>
          <div className="space-y-0.5">
            {log.slice(0, 3).map((entry, i) => (
              <div
                key={`${entry.modelId}-${entry.phase}-${i}`}
                className="flex items-center gap-2 text-[10px]"
              >
                <span className="text-white/30 font-mono tabular-nums w-10 shrink-0">
                  {new Date(entry.updatedAt).toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </span>
                <span
                  className={cn(
                    "size-1 rounded-full shrink-0",
                    entry.phase === "completed"
                      ? "bg-emerald-400"
                      : entry.phase === "failed"
                        ? "bg-red-400"
                        : entry.phase === "rejected"
                          ? "bg-amber-400"
                          : "bg-cyan-400",
                  )}
                />
                <span className="text-white/60 truncate">{entry.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function NextActionPanel({ data: d }: { data: PipelineData }) {
  const coldDone = d.dataCollection.coldStartProgress >= 100;
  const modelLoaded = d.inference.modelLoaded;
  const hasRejected = d.rejectedModels.length > 0 && !d.training.deployedModel;
  const semanticClean = d.featureContract.allSemanticChecksPass;
  const paper = d.paperEvaluation;

  const title = !semanticClean
    ? "Clean Training Data"
    : !coldDone
    ? "Collect More Examples"
    : hasRejected
      ? "Review Latest Rejection"
    : !modelLoaded
      ? "First Training Required"
        : !paper.verdict.enoughMlGateSamples
          ? "Gather Paper Results"
          : paper.verdict.mlBeatsSimpleRule
            ? "Paper Edge Visible"
            : "Simplify Before Retraining";
  const body = !semanticClean
    ? `${paper.semanticHealth.badLabeledCompetitionTier.toLocaleString()} labeled examples have inconsistent league-strength signals. Exclude or regenerate them before judging the model.`
    : !coldDone
    ? `${Math.max(0, d.dataCollection.coldStartThreshold - d.dataCollection.qualifiedForTraining).toLocaleString()} more qualified bets needed.`
    : hasRejected
      ? (d.rejectedModels[0]?.reasons?.[0] ??
        "A candidate model failed validation. Inspect the rejection before retraining.")
      : !modelLoaded
        ? "Dataset ready. Initiate training."
        : !paper.verdict.enoughMlGateSamples
          ? `Only ${paper.metrics.mlGate.sampleSize.toLocaleString()} settled paper-test samples. Keep measuring outcomes.`
          : paper.verdict.mlBeatsSimpleRule
            ? `The model is ahead of the simple rule by ${paper.verdict.mlMinusSimpleRoiPct?.toFixed(2)} return points on paper.`
            : `The simple rule is ahead of the model by ${Math.abs(paper.verdict.mlMinusSimpleRoiPct ?? 0).toFixed(2)} return points. Reduce complexity and retrain.`;
  const bodyTone = !semanticClean || hasRejected ? "text-amber-200" : "text-white/65";

  return (
    <div className="relative overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 backdrop-blur-xl">
      <div className="absolute left-0 top-0 h-full w-1 bg-cyan-500/50" />
      <div className="relative z-10 flex h-full flex-col">
        <div className="mb-2 flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-white/45">
              What to do next
            </p>
            <h2 className="mt-1 text-base font-semibold text-white">{title}</h2>
          </div>
          <OptimizerStatusPill data={d} />
        </div>
        <p className={cn("line-clamp-2 text-sm leading-relaxed", bodyTone)}>
          {body}
        </p>

        <div className="mt-auto pt-2">
          <p className="mb-2 line-clamp-2 text-sm text-white/55">
            The model only becomes useful after clean{" "}
            <TermTooltip term="training_examples">
              training examples
            </TermTooltip>{" "}
            produce paper results better than the baseline rule.
          </p>
          {coldDone && !modelLoaded && (
            <RetrainButton
              size="sm"
              hasExistingModel={d.training.totalModels > 0}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function PaperEvaluationCard({ data: d }: { data: PipelineData }) {
  const { metrics, verdict, semanticHealth } = d.paperEvaluation;
  const delta = verdict.mlMinusSimpleRoiPct;
  const status = !semanticHealth.semanticPass
    ? "Feature cleanup"
    : !verdict.enoughMlGateSamples
      ? "More samples"
    : verdict.mlBeatsSimpleRule
        ? "Model ahead"
        : "Rule ahead";
  const tone = !semanticHealth.semanticPass
    ? "text-amber-300"
    : !verdict.enoughMlGateSamples
      ? "text-cyan-300"
      : verdict.mlBeatsSimpleRule
        ? "text-emerald-400"
        : "text-rose-400";

  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 backdrop-blur-xl">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-white/45">
            Paper evaluation
          </p>
          <h2 className={cn("mt-1 text-base font-semibold", tone)}>
            {status}
          </h2>
        </div>
        <LineChart className={cn("size-5", tone)} />
      </div>
      <p className="line-clamp-2 text-sm leading-relaxed text-white/65">
        <TermTooltip term="shadow_mode">Shadow mode</TermTooltip> compares the
        model against a simple edge rule on settled clean examples.
      </p>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <Stat
          label="Simple return"
          value={formatPct(metrics.simpleEvCore.roiPct)}
          tone={roiTone(metrics.simpleEvCore.roiPct)}
        />
        <Stat
          label="Model return"
          value={formatPct(metrics.mlGate.roiPct)}
          tone={roiTone(metrics.mlGate.roiPct)}
        />
        <Stat
          label="Gap"
          value={formatSignedPoints(delta)}
          tone={
            delta == null
              ? "text-white/35"
              : delta > 0
                ? "text-emerald-400"
                : "text-rose-400"
          }
        />
      </div>
    </div>
  );
}

function PaperLearningCurvePanel({ data: d }: { data: PipelineData }) {
  const trend = d.paperEvaluation.trend.slice(-14);
  const roiValues = trend
    .flatMap((row) => [row.simpleRoiPct, row.mlGateRoiPct])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const maxAbs = Math.max(5, ...roiValues.map((v) => Math.abs(v)));

  const bar = (
    value: number | null,
    xClass: string,
    positiveClass: string,
  ) => {
    if (value == null) return null;
    const heightPct = Math.max(3, Math.min(48, (Math.abs(value) / maxAbs) * 48));
    return (
      <span
        className={cn(
          "absolute w-1 rounded-full",
          xClass,
          value >= 0 ? "bottom-1/2" : "top-1/2",
          value >= 0 ? positiveClass : "bg-rose-500/75",
        )}
        style={{ height: `${heightPct}%` }}
      />
    );
  };

  return (
    <CompactPanel
      title="Paper learning curve"
      help="Daily paper return on settled clean examples. Cyan is the simple edge rule; emerald is the model score rule."
      className="min-h-[170px]"
    >
      {trend.length > 0 ? (
        <div className="flex h-full flex-col">
          <div
            className="grid flex-1 gap-1"
            style={{
              gridTemplateColumns: `repeat(${trend.length}, minmax(0, 1fr))`,
            }}
          >
            {trend.map((row) => (
              <Tooltip key={row.day}>
                <TooltipTrigger asChild>
                  <div className="flex min-w-0 flex-col items-center gap-1">
                    <div className="relative h-16 w-full overflow-hidden rounded-md border border-white/[0.04] bg-white/[0.025]">
                      <span className="absolute left-0 right-0 top-1/2 h-px bg-white/10" />
                      {bar(row.simpleRoiPct, "left-[35%]", "bg-cyan-400")}
                      {bar(row.mlGateRoiPct, "left-[58%]", "bg-emerald-400")}
                    </div>
                    <span className="truncate font-mono text-[8px] text-white/35">
                      {row.day.slice(5)}
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent className="space-y-1 text-[10px]">
                  <div className="font-semibold">{row.day}</div>
                  <div className="text-cyan-300">
                    Rule: {formatPct(row.simpleRoiPct)} · N {row.simpleN}
                  </div>
                  <div className="text-emerald-300">
                    Model: {formatPct(row.mlGateRoiPct)} · N {row.mlGateN}
                  </div>
                  <div className="text-white/60">
                    Base: {formatPct(row.baselineRoiPct)} · N {row.baselineN}
                  </div>
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <Stat
              label="All bets return"
              value={formatPct(
                d.paperEvaluation.metrics.detectedBaseline.roiPct,
              )}
              tone={roiTone(d.paperEvaluation.metrics.detectedBaseline.roiPct)}
            />
            <Stat
              label="Rule bets"
              value={d.paperEvaluation.metrics.simpleEvCore.sampleSize}
              tone="text-cyan-300"
            />
            <Stat
              label="Model bets"
              value={d.paperEvaluation.metrics.mlGate.sampleSize}
              tone="text-emerald-300"
            />
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-[10px] font-mono text-white/30">
          Awaiting settled clean rows
        </div>
      )}
    </CompactPanel>
  );
}

function PipelineRail({
  statuses,
  data: _data,
  isTraining,
}: {
  statuses: StageStatus[];
  data: PipelineData;
  isTraining?: boolean;
}) {
  const current = firstIncompleteStep(statuses);
  const trainStageIdx = STAGES.findIndex((s) => s.key === "train");

  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-2.5 backdrop-blur-xl">
      <div className="flex items-center justify-between mb-1.5">
        <SectionTitle title="Guided Path" />
        <div className="rounded-full bg-white/[0.05] border border-white/[0.1] px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-white/60">
          Stage <span className="text-cyan-400">{current + 1}</span> /{" "}
          {STAGES.length}
        </div>
      </div>

      <div className="relative flex items-start w-full">
        {STAGES.map((stage, i) => {
          const Icon = stage.icon;
          const status = statuses[i];
          const isCurrent = i === current;
          const isComplete = status === "healthy";
          const isWarning = status === "warning";

          return (
            <div
              key={stage.key}
              className={cn(
                "flex items-start",
                i < STAGES.length - 1 ? "flex-1" : "shrink-0",
              )}
            >
              <div className="flex flex-col items-center relative z-10">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div
                      className={cn(
                        "relative flex size-8 items-center justify-center rounded-lg border transition-all duration-300",
                        isComplete
                          ? "border-emerald-500/50 bg-emerald-500/20 text-emerald-300"
                          : isCurrent
                            ? "border-cyan-400 bg-cyan-500/20 text-cyan-300 scale-110 shadow-[0_0_15px_rgba(34,211,238,0.3)]"
                            : isWarning
                              ? "border-amber-500/50 bg-amber-500/20 text-amber-300"
                              : "border-white/10 bg-white/5 text-white/30",
                      )}
                    >
                      {isComplete ? (
                        <Check className="size-4" />
                      ) : isWarning ? (
                        <AlertTriangle className="size-4" />
                      ) : (
                        <Icon
                          className={cn(
                            "size-4",
                            (isCurrent ||
                              (i === trainStageIdx && isTraining)) &&
                              "animate-pulse",
                          )}
                        />
                      )}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-sm space-y-2 p-3">
                    <p className="text-sm font-semibold text-foreground">
                      {stage.plainTitle}
                    </p>
                    <p className="text-[13px] leading-relaxed text-muted-foreground">
                      {stage.operatorMeaning}
                    </p>
                    <p className="border-t border-border/50 pt-2 text-[12px] leading-relaxed text-muted-foreground">
                      Example: {stage.example}
                    </p>
                  </TooltipContent>
                </Tooltip>
                <span
                  className={cn(
                    "mt-1.5 text-[9px] font-bold uppercase tracking-widest",
                    isComplete
                      ? "text-emerald-400"
                      : isCurrent
                        ? "text-cyan-400"
                        : "text-white/40",
                  )}
                >
                  {stage.label}
                </span>
                <span className="mt-0.5 max-w-20 truncate text-[8px] text-white/35">
                  {stage.desc}
                </span>
              </div>

              {i < STAGES.length - 1 && (
                <div className="flex-1 pt-3.5 px-2">
                  <div className="relative h-1 w-full rounded-full bg-white/5 overflow-hidden">
                    <div
                      className={cn(
                        "absolute inset-0 rounded-full transition-all duration-1000",
                        isComplete ? "bg-emerald-500" : "w-0",
                      )}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SchedulerConfigPanel({ data: d }: { data: PipelineData }) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const settings = d.schedulerSettings;

  const toggleScheduler = useCallback(async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const res = await fetch("/api/ml/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !settings.enabled }),
      });
      if (!res.ok)
        throw new Error(
          (await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`,
        );
      toast.success(
        !settings.enabled
          ? "Automatic retraining enabled"
          : "Automatic retraining disabled",
      );
      void queryClient.invalidateQueries({ queryKey: ["ml", "pipeline"] });
    } catch (err) {
      toast.error(
        `Schedule update failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSaving(false);
    }
  }, [settings, queryClient]);

  const updateCadence = useCallback(
    async (hours: number) => {
      setSaving(true);
      try {
        const res = await fetch("/api/ml/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cadenceHours: hours }),
        });
        if (!res.ok)
          throw new Error(
            (await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`,
          );
        toast.success(
          `Cycle set to ${hours < 24 ? `${hours}h` : `${hours / 24}d`}`,
        );
        void queryClient.invalidateQueries({ queryKey: ["ml", "pipeline"] });
      } catch (err) {
        toast.error(
          `Cadence update failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setSaving(false);
      }
    },
    [queryClient],
  );

  return (
    <CompactPanel
      title="Automatic retraining"
      help="Controls when the engine starts a background model build after enough new settled bets arrive."
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-bold uppercase tracking-widest text-white/50">
          Switch
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={toggleScheduler}
              disabled={saving || !settings}
              className={cn(
                "h-6 px-3 rounded-md border text-[10px] transition-all",
                settings?.enabled
                  ? "border-cyan-500/50 bg-cyan-500/20 text-cyan-300"
                  : "border-white/10 bg-white/5 text-white/40",
              )}
            >
              <Power
                className={cn(
                  "size-2.5 mr-1",
                  settings?.enabled && "text-cyan-400",
                )}
              />{" "}
              {settings?.enabled ? "Online" : "Offline"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {settings?.enabled
              ? "Disable automatic retraining."
              : "Enable automatic retraining."}
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="space-y-0.5 mb-3">
        <Kv
          label="Engine"
          value={d.scheduler.active ? "Watching" : "Paused"}
          tone={d.scheduler.active ? "text-emerald-400" : "text-white/40"}
        />
        <Kv label="Cycles" value={d.scheduler.totalRetrainTriggers} />
        <Kv
          label="Last check"
          value={
            d.scheduler.lastTickAt
              ? `${Math.round((Date.now() - d.scheduler.lastTickAt) / 1000)}s`
              : "—"
          }
          tone="text-white/40"
        />
        <Kv
          label="New-data rule"
          value={`${settings?.minGrowthPct ?? 20}%`}
          tone="text-cyan-300"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-widest text-white/40">
          <Clock className="size-2.5" /> Frequency
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          {[12, 24, 72, 168].map((h) => (
            <Tooltip key={h}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => void updateCadence(h)}
                  disabled={saving}
                  className={cn(
                    "h-5 rounded-[4px] border px-2 text-[9px] font-bold transition-all",
                    h === (settings?.cadenceHours ?? 24)
                      ? "border-cyan-500/50 bg-cyan-500/20 text-cyan-300"
                      : "border-white/10 bg-white/5 text-white/50",
                  )}
                >
                  {h < 24 ? `${h}H` : `${h / 24}D`}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                Run the retraining check every{" "}
                {h < 24 ? `${h} hours` : `${h / 24} days`}.
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>
      {(d.scheduler.lastError || settings?.lastError) && (
        <p className="mt-2 text-[9px] text-rose-400 truncate">
          {d.scheduler.lastError || settings?.lastError}
        </p>
      )}
    </CompactPanel>
  );
}

// ── Setup Guide Tab ───────────────────────────────────────────────────

function SetupGuideTab({
  data: d,
  statuses,
  trainingStream,
}: {
  data: PipelineData;
  statuses: StageStatus[];
  trainingStream: MLTrainingState;
}) {
  const [activeStep, setActiveStep] = useState(() =>
    firstIncompleteStep(statuses),
  );

  // Auto-advance to the next incomplete step when pipeline progresses
  const nextIncomplete = firstIncompleteStep(statuses);
  useEffect(() => {
    setActiveStep(nextIncomplete);
  }, [nextIncomplete]);

  return (
    <div className="flex h-full gap-4 p-3 max-w-[1920px] mx-auto w-full overflow-hidden">
      {/* Sidebar */}
      <div className="flex flex-col gap-2 w-64 shrink-0 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 backdrop-blur-xl h-full overflow-y-auto">
        <OptimizerStatusPill data={d} />
        <div className="space-y-1.5 mt-2">
          {STAGES.map((stage, i) => {
            const status = statuses[i];
            const isActive = i === activeStep;
            const Icon = stage.icon;
            return (
              <button
                key={stage.key}
                onClick={() => setActiveStep(i)}
                className={cn(
                  "group flex w-full items-center gap-3 rounded-lg border p-2 text-left transition-all",
                  isActive
                    ? "border-cyan-500/40 bg-cyan-500/10"
                    : "border-transparent hover:bg-white/[0.05]",
                )}
              >
                <div
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-md border",
                    status === "healthy"
                      ? "border-emerald-500/50 bg-emerald-500/20 text-emerald-300"
                      : status === "progressing"
                        ? "border-cyan-500/50 bg-cyan-500/20 text-cyan-300"
                        : status === "warning"
                          ? "border-amber-500/50 bg-amber-500/20 text-amber-300"
                          : "border-white/10 bg-white/5 text-white/40",
                  )}
                >
                  {status === "healthy" ? (
                    <Check className="size-3.5" />
                  ) : (
                    <Icon className="size-3.5" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p
                    className={cn(
                      "truncate text-xs font-bold",
                      isActive ? "text-cyan-400" : "text-white/80",
                    )}
                  >
                    {stage.label}
                  </p>
                  <p className="truncate text-[10px] text-white/40">
                    {stage.desc}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Detail Panel */}
      <div className="flex-1 min-w-0 h-full">
        <StepDetailPanel
          step={activeStep}
          data={d}
          statuses={statuses}
          trainingStream={trainingStream}
        />
      </div>
    </div>
  );
}

function StepDetailPanel({
  step,
  data: d,
  statuses,
  trainingStream,
}: {
  step: number;
  data: PipelineData;
  statuses: StageStatus[];
  trainingStream: MLTrainingState;
}) {
  const stage = STAGES[step] ?? STAGES[0];
  const status = statuses[step] ?? "waiting";
  const Icon = stage.icon;
  const coldDone = d.dataCollection.coldStartProgress >= 100;
  const remainingSettled = Math.max(
    0,
    d.dataCollection.coldStartThreshold - d.dataCollection.qualifiedForTraining,
  );

  const content = (() => {
    switch (step) {
      case 0:
        return {
          summary:
            "Each detected value bet needs a complete set of price, timing, and market signals before it can teach the model. This happens automatically while the engine runs.",
          rows: [
            ["Total bets", d.dataCollection.totalBets.toLocaleString()],
            [
              "With features",
              d.dataCollection.betsWithFeatures.toLocaleString(),
            ],
            ["Recent feature rate", `${d.dataCollection.recentFeatureRate}%`],
            ["Market signals", FEATURE_CATALOG.length.toLocaleString()],
          ],
          action:
            d.dataCollection.betsWithFeatures > 0
              ? "Data capture is active. Watch the recent feature rate; older bets can make the all-time average look worse than the current system."
              : "Start the main engine so live value-bet detection can begin writing learning signals.",
        };
      case 1:
        return {
          summary:
            "The model can only learn after bets finish. Wins and losses turn detected bets into examples, and the first model waits until enough clean examples exist.",
          rows: [
            [
              "Qualified for training",
              d.dataCollection.qualifiedForTraining.toLocaleString(),
            ],
            [
              "Cold-start target",
              d.dataCollection.coldStartThreshold.toLocaleString(),
            ],
            ["Progress", `${d.dataCollection.coldStartProgress}%`],
            ["Remaining", remainingSettled.toLocaleString()],
          ],
          action: coldDone
            ? "Enough clean settled bets are ready for the first model build."
            : `${remainingSettled.toLocaleString()} more settled bets with clean signals are needed before training is reliable.`,
        };
      case 2:
        return {
          summary:
            "Training builds a candidate model in the background, then tests it on hidden past bets. Use the table below to inspect exactly which bets are eligible.",
          rows: [
            ["Models trained", d.training.totalModels.toLocaleString()],
            [
              "Currently training",
              d.training.modelsInTraining.toLocaleString(),
            ],
            [
              "Training pool",
              d.dataCollection.qualifiedForTraining.toLocaleString(),
            ],
            ["Data growth", `${d.training.growthPct}%`],
          ],
          action:
            trainingStream.isTraining || d.training.modelsInTraining > 0
              ? `Training v${trainingStream.currentTraining?.version ?? d.training.activeTraining?.version ?? "?"} is running on ${d.dataCollection.qualifiedForTraining.toLocaleString()} settled examples. This usually takes 5-10 minutes.`
              : coldDone
                ? d.training.totalModels > 0
                  ? "Retrain manually or let automatic retraining wait for enough new examples. The table below shows the data that will be used."
                  : "Start the first model build. A candidate model will be created and then checked before it can go live."
                : "Awaiting completion of the settlement cold-start phase.",
        };
      case 3: {
        // Derive a contextual action from the most recent rejection reason
        const latestRejection = d.rejectedModels[0];
        const latestReasons = latestRejection?.reasons ?? [];
        const latestReasonLower = (latestReasons[0] ?? "").toLowerCase();

        let validateAction: string;
        if (d.training.deployedModel) {
          validateAction =
            "A verified model passed the safety checks and is available for live scoring.";
        } else if (
          latestReasonLower.includes("stale image") ||
          latestReasonLower.includes("feature_version")
        ) {
          validateAction =
            "The training image was out of sync. It has been rebuilt, so start a fresh model build.";
        } else if (latestReasonLower.includes("cold start")) {
          validateAction = `Training failed due to insufficient data (${latestReasons[0]}). Wait for more bets to settle before retraining.`;
        } else if (
          latestReasonLower.includes("auc") ||
          latestReasonLower.includes("dsr") ||
          latestReasonLower.includes("pbo") ||
          latestReasonLower.includes("monoton")
        ) {
          validateAction = `Model rejected by quality checks: "${latestReasons[0]}". Collect more data or review approval thresholds, then retrain.`;
        } else if (latestReasons.length > 0) {
          validateAction = `Last rejection: "${latestReasons[0]}". Address the issue and trigger a new training run.`;
        } else if (d.rejectedModels.length > 0) {
          validateAction =
            "Models have been rejected. Review the diagnostics below and retrain when the underlying issue is resolved.";
        } else {
          validateAction = "Awaiting a completed training run for validation.";
        }

        return {
          summary:
            "Safety checks protect live betting. A model must rank stronger bets above weaker bets, beat luck checks, and avoid memorizing old results before promotion.",
          rows: [
            ["Deployed model", d.training.deployedModel ? "Active" : "None"],
            ["Failed / Rejected", d.rejectedModels.length.toLocaleString()],
            ["Allowed actions", d.deploymentGate.permissionLevel],
            [
              "Gate refreshed",
              d.deploymentGate.lastRefreshedAt
                ? new Date(d.deploymentGate.lastRefreshedAt).toLocaleString()
                : "—",
            ],
          ],
          action: validateAction,
        };
      }
      case 4:
        return {
          summary:
            "The engine keeps the approved model loaded so each new value bet can be scored quickly before placement.",
          rows: [
            [
              "Model Version",
              d.inference.modelLoaded ? `v${d.inference.modelVersion}` : "None",
            ],
            ["Total scored", d.inference.totalScored.toLocaleString()],
            ["Average time", `${d.inference.avgInferenceMs.toFixed(2)}ms`],
            [
              "Avg score",
              d.scoreDistribution.totalScored > 0
                ? d.scoreDistribution.avgScore.toFixed(3)
                : "—",
            ],
          ],
          action: d.inference.modelLoaded
            ? "Live scoring is online. Check score-group performance before allowing the model to affect real bets."
            : "Waiting for an approved model. The engine will load it automatically when one is available.",
        };
      default:
        return {
          summary:
            "This controls what the model may do. It can start by observing only, then later skip weak bets or reduce weak stakes after paper results justify it.",
          rows: [
            ["Allowed mode", d.deploymentGate.permissionLevel],
            ["Can skip", d.deploymentGate.canGate ? "Allowed" : "Blocked"],
            [
              "Can reduce stake",
              d.deploymentGate.canReduceStake ? "Allowed" : "Blocked",
            ],
            [
              "Can increase stake",
              d.deploymentGate.canIncreaseStake ? "Allowed" : "Blocked",
            ],
          ],
          action:
            d.deploymentGate.canGate || d.deploymentGate.canReduceStake
              ? "The model can currently affect placement. Monitor paper return and real outcomes closely."
              : d.inference.modelLoaded
                ? "Observe-only analysis is active. Review differences between simple rules and model advice before granting active permissions."
                : "Complete live scoring before model-driven actions are available.",
        };
    }
  })();

  return (
    <div className="flex flex-col h-full rounded-xl border border-white/[0.08] bg-white/[0.02] backdrop-blur-xl overflow-hidden relative">
      <div className="flex-none p-3 pb-2 border-b border-white/[0.05]">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-3">
            <Icon className="size-6 text-cyan-400" />
            <h2 className="text-xl font-bold text-white tracking-tight">
              {stage.plainTitle}
            </h2>
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest",
                statusTone(status),
              )}
            >
              {statusLabel(status)}
            </span>
          </div>
          {(step === 2 || (step === 3 && !d.training.deployedModel)) &&
            coldDone && (
              <RetrainButton
                size="sm"
                hasExistingModel={d.training.totalModels > 0}
                isTraining={
                  trainingStream.isTraining || d.training.modelsInTraining > 0
                }
                trainingVersion={
                  trainingStream.currentTraining?.version ??
                  d.training.activeTraining?.version
                }
              />
            )}
        </div>
        <p className="line-clamp-2 text-sm text-white/65 leading-relaxed">
          {stage.operatorMeaning}
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-3">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-2">
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-2.5">
            <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-emerald-300">
              Good state
            </p>
            <p className="line-clamp-2 text-sm leading-relaxed text-white/70">
              {stage.goodState}
            </p>
          </div>
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-2.5">
            <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-amber-300">
              If blocked
            </p>
            <p className="line-clamp-2 text-sm leading-relaxed text-white/70">
              {stage.blockedReason}
            </p>
          </div>
          <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-2.5">
            <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-cyan-300">
              Example
            </p>
            <p className="line-clamp-2 text-sm leading-relaxed text-white/70">
              {stage.example}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {content.rows.map(([label, value]) => (
            <Stat key={label} label={label} value={value} />
          ))}
        </div>

        <div className="rounded-lg border border-white/[0.05] bg-background/40 p-3">
          <div className="flex items-center gap-2 mb-3">
            <GitBranch className="size-3.5 text-indigo-400" />
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-white/80">
              Supporting details
            </h3>
          </div>

          {step === 0 ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
                <span
                  key={cat}
                  className="flex items-center gap-1.5 text-[10px] font-medium text-white/60"
                >
                  <span className={cn("size-1.5 rounded-full", color)} />
                  {cat}:{" "}
                  <span className="text-white">
                    {FEATURE_CATALOG.filter((f) => f.cat === cat).length}
                  </span>
                </span>
              ))}
            </div>
          ) : step === 1 ||
            (step === 2 &&
              !(
                trainingStream.isTraining || d.training.modelsInTraining > 0
              )) ? (
            <div className="flex flex-col gap-3">
              <div>
                <div className="mb-1.5 flex justify-between text-[9px] font-bold uppercase tracking-widest text-white/50">
                  <span>
                    {d.dataCollection.qualifiedForTraining} examples
                  </span>
                  <span
                    className={cn(
                      coldDone ? "text-emerald-400" : "text-cyan-400",
                    )}
                  >
                    {d.dataCollection.coldStartProgress}%
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-white/10">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all duration-1000",
                      coldDone
                        ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]"
                        : "bg-cyan-500 shadow-[0_0_8px_rgba(34,211,238,0.8)]",
                    )}
                    style={{
                      width: `${Math.min(d.dataCollection.coldStartProgress, 100)}%`,
                    }}
                  />
                </div>
              </div>
              {step === 2 && coldDone && (
                <div className="-mx-3 -mb-3">
                  <ModelHistoryTable models={d.modelHistory ?? []} />
                  <TrainingDataTable />
                </div>
              )}
            </div>
          ) : step === 2 &&
            (trainingStream.isTraining || d.training.modelsInTraining > 0) ? (
            trainingStream.currentTraining ? (
              <LiveTrainingPanel
                training={trainingStream.currentTraining}
                log={trainingStream.trainingLog}
                isConnected={trainingStream.isConnected}
                dataCount={d.dataCollection.qualifiedForTraining}
              />
            ) : (
              <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 p-3">
                <div className="flex items-center gap-2 mb-1">
                  <Cpu className="size-3.5 text-cyan-400 animate-spin" />
                  <span className="text-[10px] font-bold uppercase tracking-widest text-cyan-400">
                    Model build running
                  </span>
                </div>
                <p className="text-[10px] text-white/60">
                  Background training is processing{" "}
                  {d.dataCollection.qualifiedForTraining.toLocaleString()}{" "}
                  settled examples...
                </p>
              </div>
            )
          ) : step === 3 ? (
            <div className="space-y-3">
              {d.training.deployedModel && (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 relative overflow-hidden">
                  <div className="absolute top-1/2 -translate-y-1/2 right-4 pointer-events-none z-0">
                    <ShieldCheck className="size-12 text-emerald-400/10" />
                  </div>
                  <div className="flex items-center justify-between mb-3 relative z-10">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="size-4 text-emerald-400" />
                      <span className="font-bold text-emerald-300 text-[10px] uppercase tracking-widest">
                        Live Model
                      </span>
                      <span className="rounded bg-emerald-400/20 px-1.5 py-0.5 text-[9px] font-bold text-emerald-300">
                        v
                        {
                          (d.training.deployedModel as Record<string, unknown>)
                            .version as number
                        }
                      </span>
                    </div>
                    <span className="text-[9px] text-white/50 pr-12">
                      {new Date(
                        ((d.training.deployedModel as Record<string, unknown>)
                          .deployedAt as string) ||
                          ((d.training.deployedModel as Record<string, unknown>)
                            .createdAt as string),
                      ).toLocaleString()}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 relative z-10">
                    <div className="flex flex-col">
                      <span className="text-[9px] uppercase tracking-widest text-white/40 mb-0.5">
                        Winner separation
                      </span>
                      <span className="text-white/90 text-xs font-mono">
                        {Number(
                          (d.training.deployedModel as Record<string, unknown>)
                            .oosAucRoc,
                        ).toFixed(4)}
                      </span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[9px] uppercase tracking-widest text-white/40 mb-0.5">
                        Luck check
                      </span>
                      <span className="text-white/90 text-xs font-mono">
                        {Number(
                          (d.training.deployedModel as Record<string, unknown>)
                            .deflatedSharpe,
                        ).toFixed(2)}
                      </span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[9px] uppercase tracking-widest text-white/40 mb-0.5">
                        Memory risk
                      </span>
                      <span className="text-white/90 text-xs font-mono">
                        {Number(
                          (d.training.deployedModel as Record<string, unknown>)
                            .pbo,
                        ) > 0
                          ? `${(
                              Number(
                                (
                                  d.training.deployedModel as Record<
                                    string,
                                    unknown
                                  >
                                ).pbo,
                              ) * 100
                            ).toFixed(1)}%`
                          : "n/a"}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {d.rejectedModels.length > 0 && (
                <div className="space-y-2 mt-3">
                  <span className="block text-[9px] font-bold uppercase tracking-widest text-white/50 mb-1">
                    Recent Rejections
                  </span>
                  {d.rejectedModels
                    .slice(0, 3)
                    .map((model: Record<string, unknown>, idx: number) => {
                      const failedAt = (model.trainingCompletedAt ??
                        model.createdAt) as string | null;
                      const timeLabel = failedAt
                        ? new Date(failedAt).toLocaleString(undefined, {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : null;
                      const ver = model.version as number;
                      const status = model.status as string;
                      const reasons = (model.reasons ?? []) as string[];
                      const versionLabel = ver === 0 ? "attempt" : `v${ver}`;
                      return (
                        <div
                          key={`${ver}-${idx}`}
                          className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-2.5"
                        >
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="font-bold text-rose-300 text-[10px]">
                              {versionLabel}
                            </span>
                            <div className="flex items-center gap-2">
                              {timeLabel && (
                                <span className="text-[9px] text-white/40">
                                  {timeLabel}
                                </span>
                              )}
                              <span className="text-[9px] font-mono text-white/30">
                                {status}
                              </span>
                            </div>
                          </div>
                          {reasons.length > 0 ? (
                            <div className="space-y-1">
                              {reasons.map((reason, ri) => (
                                <div
                                  key={ri}
                                  className="flex items-start gap-1.5 text-[10px]"
                                >
                                  <AlertTriangle className="size-3 mt-px shrink-0 text-amber-400/70" />
                                  <span className="text-white/70 leading-tight">
                                    {reason}
                                  </span>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-[10px] text-white/40">
                              No rejection details recorded.
                            </p>
                          )}
                        </div>
                      );
                    })}
                </div>
              )}

              {!d.training.deployedModel && d.rejectedModels.length === 0 && (
                <p className="text-[10px] font-mono text-white/30">
                  No validation history available.
                </p>
              )}
            </div>
          ) : step === 4 ? (
            !d.inference.modelLoaded ? (
              <div className="rounded-lg border border-white/5 bg-white/[0.02] p-6 flex flex-col items-center justify-center text-center mt-4">
                <ServerCrash className="size-8 text-white/20 mb-3" />
                <span className="text-xs font-bold text-white/60 mb-1 tracking-wide">
                  No model loaded
                </span>
                <span className="text-[10px] text-white/40 leading-relaxed max-w-[80%]">
                  The engine is using the normal rules until an approved model
                  is available.
                </span>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-white/60">
                    Score Distribution
                  </span>
                  <span className="text-[10px] text-white/40">
                    {d.scoreDistribution.totalScored.toLocaleString()} total
                    scored
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 flex flex-col items-center text-center">
                    <span className="block text-[9px] uppercase tracking-widest text-white/40 mb-1.5">
                      Strong scores (≥ 0.4)
                    </span>
                    <span className="text-2xl font-black text-emerald-400">
                      {d.scoreDistribution.aboveThreshold.toLocaleString()}
                    </span>
                  </div>
                  <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 flex flex-col items-center text-center">
                    <span className="block text-[9px] uppercase tracking-widest text-white/40 mb-1.5">
                      Weak scores (&lt; 0.4)
                    </span>
                    <span className="text-2xl font-black text-amber-400">
                      {d.scoreDistribution.belowThreshold.toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>
            )
          ) : step === 5 ? (
            !d.inference.modelLoaded ? (
              <div className="rounded-lg border border-white/5 bg-white/[0.02] p-6 flex flex-col items-center justify-center text-center mt-4">
                <ShieldAlert className="size-8 text-white/20 mb-3" />
                <span className="text-xs font-bold text-white/60 mb-1 tracking-wide">
                  Actions disabled
                </span>
                <span className="text-[10px] text-white/40 leading-relaxed max-w-[80%]">
                  Approve a model before it can skip weak bets or adjust stake
                  sizes.
                </span>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-3">
                  <span className="block text-[9px] uppercase tracking-widest text-indigo-400/70 mb-1">
                    Active allowed mode
                  </span>
                  <span className="text-sm font-bold text-indigo-300">
                    {d.scoringMode}
                  </span>
                </div>

                <div className="space-y-2">
                  <span className="block text-[9px] font-bold uppercase tracking-widest text-white/40 mb-2">
                    Action checklist
                  </span>
                  <div className="grid grid-cols-1 gap-2">
                    {(() => {
                      const levels = [
                        "shadow",
                        "gate_only",
                        "stake_reduce",
                        "stake_increase",
                      ];
                      const currentIndex = levels.indexOf(
                        d.deploymentGate.permissionLevel,
                      );
                      return (
                        <>
                          <div
                            className={cn(
                              "flex items-center justify-between p-2.5 rounded-lg border",
                              currentIndex >= 0
                                ? "border-indigo-500/30 bg-indigo-500/10"
                                : "border-white/5",
                            )}
                          >
                            <span
                              className={cn(
                                "text-[10px] font-medium tracking-wide",
                                currentIndex >= 0
                                  ? "text-indigo-200"
                                  : "text-white/40",
                              )}
                            >
                              Observe only
                            </span>
                            <CheckCircle2
                              className={cn(
                                "size-3.5",
                                currentIndex >= 0
                                  ? "text-indigo-400"
                                  : "text-white/10",
                              )}
                            />
                          </div>
                          <div
                            className={cn(
                              "flex items-center justify-between p-2.5 rounded-lg border",
                              currentIndex >= 1
                                ? "border-emerald-500/30 bg-emerald-500/10"
                                : "border-white/5",
                            )}
                          >
                            <span
                              className={cn(
                                "text-[10px] font-medium tracking-wide",
                                currentIndex >= 1
                                  ? "text-emerald-200"
                                  : "text-white/40",
                              )}
                            >
                              Skip weak scores
                            </span>
                            <CheckCircle2
                              className={cn(
                                "size-3.5",
                                currentIndex >= 1
                                  ? "text-emerald-400"
                                  : "text-white/10",
                              )}
                            />
                          </div>
                          <div
                            className={cn(
                              "flex items-center justify-between p-2.5 rounded-lg border",
                              currentIndex >= 2
                                ? "border-amber-500/30 bg-amber-500/10"
                                : "border-white/5",
                            )}
                          >
                            <span
                              className={cn(
                                "text-[10px] font-medium tracking-wide",
                                currentIndex >= 2
                                  ? "text-amber-200"
                                  : "text-white/40",
                              )}
                            >
                              Reduce weak stakes
                            </span>
                            <CheckCircle2
                              className={cn(
                                "size-3.5",
                                currentIndex >= 2
                                  ? "text-amber-400"
                                  : "text-white/10",
                              )}
                            />
                          </div>
                          <div
                            className={cn(
                              "flex items-center justify-between p-2.5 rounded-lg border",
                              currentIndex >= 3
                                ? "border-cyan-500/30 bg-cyan-500/10"
                                : "border-white/5",
                            )}
                          >
                            <span
                              className={cn(
                                "text-[10px] font-medium tracking-wide",
                                currentIndex >= 3
                                  ? "text-cyan-200"
                                  : "text-white/40",
                              )}
                            >
                              Full stake sizing
                            </span>
                            <CheckCircle2
                              className={cn(
                                "size-3.5",
                                currentIndex >= 3
                                  ? "text-cyan-400"
                                  : "text-white/10",
                              )}
                            />
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>
            )
          ) : (
            <p className="text-[10px] font-mono text-white/30">
              Awaiting telemetry data...
            </p>
          )}
        </div>

        <div className="sticky bottom-0 rounded-xl border border-cyan-500/30 bg-background/95 p-3 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center gap-2 mb-1.5">
            <Zap className="size-4 text-cyan-400 drop-shadow-[0_0_5px_rgba(34,211,238,0.8)] animate-pulse" />
            <h3 className="text-[10px] font-extrabold uppercase tracking-widest text-cyan-400">
              Required Operation
            </h3>
          </div>
          <p className="text-white/90 leading-relaxed text-sm font-medium">
            {content.action}
          </p>
        </div>
      </div>
    </div>
  );
}
