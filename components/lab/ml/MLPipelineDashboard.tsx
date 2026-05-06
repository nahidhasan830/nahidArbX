"use client";

/**
 * ML Optimizer Dashboard — Ultra-Compact Premium Layout
 *
 * Dark mode, glassmorphism, glowing gradients, high data density.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Database, Cpu, TrendingUp, Zap,
  AlertTriangle, Check,
  LayoutDashboard, Route, Info, RefreshCw, ShieldCheck,
  Clock, Power, CircleDot, Gauge, GitBranch, Activity
} from "lucide-react";
import { TabsContent } from "@/components/ui/tabs";
import { AppShell } from "@/components/nav/AppShell";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FEATURE_CATALOG, CATEGORY_COLORS } from "@/lib/ml/feature-catalog";
import { RetrainButton } from "./MLModelStatus";
import { toast } from "sonner";
import { useMLTrainingStream, type MLTrainingState } from "@/components/hooks/useMLTrainingStream";
import type { MLTrainingUpdate } from "@/lib/events/event-bus";

// ── Types ─────────────────────────────────────────────────────────────

export interface PipelineData {
  dataCollection: {
    totalBets: number;
    betsWithFeatures: number;
    settledWithFeatures: number;
    coldStartThreshold: number;
    coldStartProgress: number;
    featureExtractionHealthy: boolean;
    recentFeatureRate: number;
  };
  training: {
    totalModels: number;
    deployedModel: Record<string, unknown> | null;
    latestModel: Record<string, unknown> | null;
    modelsInTraining: number;
    readyToRetrain: boolean;
    newDataSinceLastTrain: number;
    growthPct: number;
    activeTraining: {
      modelId: string;
      version: number;
      status: string;
      startedAt: string;
      elapsedMs: number | null;
    } | null;
  };
  inference: {
    modelLoaded: boolean;
    modelVersion: number | null;
    totalScored: number;
    avgInferenceMs: number;
    error?: string;
  };
  scheduler: {
    active: boolean;
    lastTickAt: number | null;
    totalRetrainTriggers: number;
    lastError: string | null;
  };
  deploymentGate: {
    permissionLevel: string;
    modelVersion: number | null;
    canGate: boolean;
    canReduceStake: boolean;
    canIncreaseStake: boolean;
    lastRefreshedAt: string | null;
  };
  scoringMode: string;
  scoreDistribution: {
    buckets: { range: string; count: number }[];
    avgScore: number;
    belowThreshold: number;
    aboveThreshold: number;
    totalScored: number;
  };
  featureContract: {
    currentVersion: number;
    currentFeatureCount: number;
    currentNamesHash: string;
    versionDistribution: { version: number | null; count: number }[];
    lengthDistribution: { length: number | null; count: number }[];
    allVersionsMatch: boolean;
    allLengthsMatch: boolean;
  };
  enrichmentCoverage: {
    distinctCompetitions: number;
    enrichedCompetitions: number;
    highConfidence: number;
    coveragePct: number;
  };
  trainingComposition: {
    byType: Record<string, number>;
    byLabel: Record<string, number>;
    totalExamples: number;
  };
  scoreBucketROI: {
    bucket: string;
    count: number;
    avgPnl: number;
    avgClv: number;
    winRate: number;
  }[];
  rejectedModels: {
    version: number;
    status: string;
    reasons: string[];
    createdAt: string | null;
    trainingSamples: number;
    oosAucRoc: number | null;
    deflatedSharpe: number | null;
    pbo: number | null;
  }[];
  schedulerSettings: {
    enabled: boolean;
    cadenceHours: number;
    minNewSettledExamples: number;
    minGrowthPct: number;
    nextRunAt: string | null;
    lastRunAt: string | null;
    lastError: string | null;
    updatedAt: string;
  } | null;
}

type StageStatus = "healthy" | "action" | "progressing" | "waiting" | "warning";

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

// ── Stage helpers ─────────────────────────────────────────────────────

const STAGES = [
  { key: "capture", label: "Capture", icon: Database, desc: "Extract features" },
  { key: "settle", label: "Settle", icon: CircleDot, desc: "Generate labels" },
  { key: "train", label: "Train", icon: Cpu, desc: "LightGBM CPCV" },
  { key: "validate", label: "Validate", icon: ShieldCheck, desc: "Safety gates" },
  { key: "score", label: "Score", icon: Gauge, desc: "ONNX Inference" },
  { key: "act", label: "Act", icon: TrendingUp, desc: "Gate & Stake" },
] as const;

function getStageStatuses(d: PipelineData): StageStatus[] {
  const s1: StageStatus = d.dataCollection.betsWithFeatures > 0 ? "healthy" : "progressing";
  const coldDone = d.dataCollection.settledWithFeatures >= d.dataCollection.coldStartThreshold;
  const s2: StageStatus = coldDone ? "healthy" : "progressing";
  const s3: StageStatus = d.training.modelsInTraining > 0
    ? "progressing" : d.training.totalModels > 0 ? "healthy" : (s2 === "healthy" ? "action" : "waiting");
  const hasRejected = d.rejectedModels.length > 0;
  const s4: StageStatus = d.training.deployedModel
    ? "healthy"
    : hasRejected && d.training.totalModels > 0
      ? "warning"
      : s3 === "healthy"
        ? "progressing"
        : "waiting";
  const s5: StageStatus = d.inference.modelLoaded ? "healthy" : (s4 === "healthy" ? "progressing" : "waiting");
  const canAffectBets = d.deploymentGate.canGate || d.deploymentGate.canReduceStake;
  const s6: StageStatus = canAffectBets ? "healthy" : d.inference.modelLoaded ? "progressing" : "waiting";
  return [s1, s2, s3, s4, s5, s6];
}

function firstIncompleteStep(statuses: StageStatus[]): number {
  const idx = statuses.findIndex((s) => s !== "healthy");
  return idx === -1 ? 0 : idx;
}

function statusTone(status: StageStatus): string {
  return status === "healthy"
    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
    : status === "action"
      ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
    : status === "progressing"
      ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-400"
      : status === "warning"
        ? "border-rose-500/40 bg-rose-500/10 text-rose-400"
        : "border-white/10 bg-white/5 text-white/40";
}

function statusLabel(status: StageStatus): string {
  return status === "healthy" ? "Ready" : status === "action" ? "Action" : status === "progressing" ? "Working" : status === "warning" ? "Review" : "Waiting";
}

function scoringModeHelp(permissionLevel: string, modelLoaded: boolean) {
  if (!modelLoaded) return "Pass-through: existing rules apply.";
  if (permissionLevel === "gate_only") return "Gate-only: skip low-confidence bets.";
  if (permissionLevel === "stake_reduce") return "Stake-reduce: shrink weak bets.";
  if (permissionLevel === "stake_increase") return "Stake-adjust: optimize stakes fully.";
  return "Shadow mode: observation only.";
}

// ── Shared UI Components ──────────────────────────────────────────────

export function Stat({ label, value, tone, variant = "default" }: { label: string; value: React.ReactNode; tone?: string; variant?: "default" | "hero" }) {
  const isHero = variant === "hero";
  return (
    <div className={cn(
      "group relative flex flex-col justify-center overflow-hidden rounded-xl border transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_4px_15px_-5px_rgba(0,0,0,0.6)]",
      isHero ? "bg-white/[0.04] border-white/[0.08]" : "bg-white/[0.02] border-white/[0.04]",
      isHero ? "p-2.5" : "p-2"
    )}>
      {isHero && (
        <div className={cn(
          "absolute -inset-px bg-gradient-to-b opacity-0 transition-opacity duration-300 group-hover:opacity-100",
          tone ? tone.replace("text-", "from-").replace("-400", "-500/20") + " to-transparent" : "from-white/10 to-transparent"
        )} />
      )}
      <div className="relative z-10">
        <p className="text-[9px] font-bold uppercase tracking-widest text-white/50 mb-0.5 whitespace-nowrap overflow-hidden text-ellipsis">{label}</p>
        <div className={cn("font-semibold tracking-tight", isHero ? "text-lg" : "text-sm", tone ?? "text-white")}>
          {typeof value === "number" ? value.toLocaleString() : value}
        </div>
      </div>
    </div>
  );
}

function HelpTip({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex size-3.5 cursor-help items-center justify-center rounded-full bg-white/5 border border-white/10 text-white/50 transition-colors hover:border-cyan-400/50 hover:text-cyan-300 hover:bg-cyan-500/10">
          <Info className="size-2.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[280px] bg-background/95 backdrop-blur-xl border-white/10 text-xs leading-relaxed text-white/80 p-2 shadow-2xl">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

function SectionTitle({ title, help }: { title: string; help?: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center gap-1.5 shrink-0">
      <h4 className="text-[10px] font-bold tracking-widest text-white/80 uppercase">{title}</h4>
      {help && <HelpTip>{help}</HelpTip>}
    </div>
  );
}

function OptimizerStatusPill({ data: d }: { data: PipelineData }) {
  const ready = d.dataCollection.coldStartProgress >= 100;
  const modelLoaded = d.inference.modelLoaded;
  const canAffectBets = d.deploymentGate.canGate || d.deploymentGate.canReduceStake;
  const label = !ready ? "Collecting" : !modelLoaded ? "Ready to train" : canAffectBets ? "Live Gating" : "Shadow Mode";
  
  const tone = !ready
    ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-400"
    : !modelLoaded
      ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
      : canAffectBets
        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
        : "border-indigo-500/40 bg-indigo-500/10 text-indigo-400";

  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-bold tracking-widest uppercase", tone)}>
      <ShieldCheck className="size-3" />
      {label}
    </span>
  );
}

function CompactPanel({ title, help, children, className }: { title: string; help?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("group relative overflow-hidden rounded-xl border border-white/[0.05] bg-white/[0.02] p-3 backdrop-blur-xl transition-all duration-300 hover:bg-white/[0.03] hover:border-white/[0.08] flex flex-col", className)}>
      <div className="absolute -inset-px bg-gradient-to-br from-white/[0.03] to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      <div className="relative z-10 flex flex-col h-full">
        <SectionTitle title={title} help={help} />
        <div className="flex-1 min-h-0 overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  );
}

function Kv({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="flex items-center justify-between py-0.5 text-[11px]">
      <span className="text-white/50">{label}</span>
      <span className={cn("font-medium tracking-tight tabular-nums", tone ?? "text-white")}>{value}</span>
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────

export function MLPipelineDashboard() {
  const { data, isLoading, isError, error, refetch, isFetching } = usePipeline();
  const [activeTab, setActiveTab] = useState<string>("overview");
  const trainingStream = useMLTrainingStream();
  const qc = useQueryClient();

  // Hydrate training state from polled pipeline data (persists across page refresh)
  const activeTraining = data?.training?.activeTraining;
  useEffect(() => {
    if (activeTraining) {
      trainingStream.hydrateFromPipeline(activeTraining);
    }
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
              <p className="text-cyan-500/70 font-mono text-[10px] uppercase tracking-widest animate-pulse">Booting...</p>
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
              <h2 className="text-sm font-bold uppercase text-rose-400 mb-1">System Offline</h2>
              <p className="text-[11px] text-white/70 mb-3">`/api/ml/pipeline` failed. Verify DB & engine.</p>
              <div className="rounded-lg bg-background/50 border border-white/10 p-2 font-mono text-[10px] text-rose-300/90 truncate mb-3">
                {error instanceof Error ? error.message : "Unknown error"}
              </div>
              <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching} className="h-7 text-xs border-white/10 hover:bg-white/10 text-white w-full">
                <RefreshCw className={cn("mr-1.5 size-3", isFetching && "animate-spin")} /> Retry Connection
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
          { value: "guide", label: "Pipeline Setup", icon: Route },
        ]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      >
        <div className="relative flex flex-col flex-1 min-h-0 bg-background overflow-hidden text-foreground">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden" />
          
          <div className="relative z-10 flex flex-col flex-1 min-h-0 p-3 max-w-[1920px] mx-auto w-full">
            <TabsContent value="overview" className="flex-1 min-h-0 mt-0 outline-none">
              <OverviewTab data={data} statuses={statuses} trainingStream={trainingStream} />
            </TabsContent>
            <TabsContent value="guide" className="flex-1 min-h-0 mt-0 outline-none">
              <SetupGuideTab data={data} statuses={statuses} trainingStream={trainingStream} />
            </TabsContent>
          </div>
        </div>
      </AppShell>
    </TooltipProvider>
  );
}

// ── Overview Tab ──────────────────────────────────────────────────────

function OverviewTab({ data: d, statuses, trainingStream }: { data: PipelineData; statuses: StageStatus[]; trainingStream: MLTrainingState }) {
  const coldDone = d.dataCollection.coldStartProgress >= 100;
  const dist = d.scoreDistribution;
  const maxBucket = dist ? Math.max(...dist.buckets.map((b) => b.count), 1) : 1;
  const contractHealthy = d.featureContract.allVersionsMatch && d.featureContract.allLengthsMatch;

  return (
    <div className="flex flex-col h-full gap-2.5 overflow-hidden">
      {/* ── Zone 1: Next Action Banner or Live Training ── */}
      <div className="shrink-0">
        {trainingStream.currentTraining ? (
          <LiveTrainingPanel training={trainingStream.currentTraining} log={trainingStream.trainingLog} isConnected={trainingStream.isConnected} dataCount={d.dataCollection.settledWithFeatures} />
        ) : (
          <NextActionPanel data={d} />
        )}
      </div>

      {/* ── Zone 2: Hero KPIs ── */}
      <div className="shrink-0 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
        <Stat label="Settled + Features" value={d.dataCollection.settledWithFeatures} tone="text-cyan-400" variant="hero" />
        <Stat label="Feature Rate" value={`${d.dataCollection.recentFeatureRate}%`} tone={d.dataCollection.recentFeatureRate > 80 ? "text-emerald-400" : "text-white/40"} variant="hero" />
        <Stat label="Scorer" value={d.inference.modelLoaded ? `v${d.inference.modelVersion}` : "No model"} tone={d.inference.modelLoaded ? "text-emerald-400" : "text-white/40"} variant="hero" />
        <Stat label="Total Bets" value={d.dataCollection.totalBets} variant="hero" />
        <Stat label="With Features" value={d.dataCollection.betsWithFeatures} variant="hero" />
        <Stat label="Scoring Mode" value={d.scoringMode} tone={d.inference.modelLoaded ? (d.deploymentGate.permissionLevel === "shadow" ? "text-indigo-400" : "text-emerald-400") : "text-white/40"} variant="hero" />
        <Stat label="Scheduler" value={d.scheduler.active ? "Active" : "Off"} tone={d.scheduler.active ? "text-emerald-400" : "text-white/40"} variant="hero" />
      </div>

      {/* ── Zone 3: Glowing Pipeline Visualizer ── */}
      <div className="shrink-0">
        <PipelineRail statuses={statuses} data={d} isTraining={trainingStream.isTraining || d.training.modelsInTraining > 0} />
      </div>

      {/* ── Zone 4: Complex Layout ── */}
      <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-12 gap-2.5 overflow-hidden">
        
        {/* Left Column: Operations & Diagnostics */}
        <div className="xl:col-span-8 flex flex-col gap-2.5 min-h-0 overflow-hidden">
           <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 min-h-0 shrink-0">
             <CompactPanel title="Training Engine" help="Progress to next model build.">
               <div className="mb-1.5 flex items-center justify-between text-[10px] font-bold uppercase">
                 <span className="text-white/50">{d.dataCollection.settledWithFeatures} / {d.dataCollection.coldStartThreshold}</span>
                 <span className={cn(coldDone ? "text-emerald-400" : "text-cyan-400")}>{d.dataCollection.coldStartProgress}%</span>
               </div>
               <div className="mb-2 h-1 rounded-full bg-white/10">
                 <div className={cn("h-full rounded-full transition-all", coldDone ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]" : "bg-cyan-500 shadow-[0_0_8px_rgba(34,211,238,0.8)]")} style={{ width: `${Math.min(d.dataCollection.coldStartProgress, 100)}%` }} />
               </div>
               <div className="space-y-0.5 mb-2">
                 <Kv label="Total Models" value={d.training.totalModels} />
                 <Kv label="In Training" value={d.training.modelsInTraining} tone={d.training.modelsInTraining > 0 ? "text-cyan-400 animate-pulse" : "text-white"} />
                 <Kv label="New Data" value={d.training.newDataSinceLastTrain} tone="text-cyan-300" />
               </div>
               {coldDone && (
                 <RetrainButton
                   size="sm"
                   hasExistingModel={d.training.totalModels > 0}
                   isTraining={trainingStream.isTraining || d.training.modelsInTraining > 0}
                   trainingVersion={trainingStream.currentTraining?.version ?? d.training.activeTraining?.version}
                 />
               )}
             </CompactPanel>
             
             <CompactPanel title="Inference Node" help="Real-time ONNX scoring module.">
               <div className="space-y-0.5">
                 <Kv label="Status" value={d.inference.modelLoaded ? `v${d.inference.modelVersion} loaded` : "No model"} tone={d.inference.modelLoaded ? "text-emerald-400" : "text-white/40"} />
                 <Kv label="Latency" value={`${d.inference.avgInferenceMs.toFixed(2)}ms`} tone="text-amber-300" />
                 <Kv label="Total Scored" value={d.inference.totalScored.toLocaleString()} />
                 <Kv label="Avg Score" value={dist.totalScored > 0 ? dist.avgScore.toFixed(3) : "—"} />
               </div>
               {d.inference.error && <p className="mt-2 rounded-md bg-rose-500/10 border border-rose-500/20 p-1.5 text-[10px] text-rose-400 leading-tight">{d.inference.error}</p>}
             </CompactPanel>
             
             <SchedulerConfigPanel data={d} />
           </div>

           <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 flex-1 min-h-0 overflow-y-auto">
              <CompactPanel title="Vector Contract" help="Tracks alignment between Typescript, Python, and DB schemas.">
                <div className="space-y-0.5">
                  <Kv label="Version" value={`v${d.featureContract.currentVersion}`} tone={d.featureContract.allVersionsMatch ? "text-emerald-400" : "text-rose-400"} />
                  <Kv label="Dimensions" value={d.featureContract.currentFeatureCount} tone={d.featureContract.allLengthsMatch ? "text-emerald-400" : "text-rose-400"} />
                  <Kv label="Hash" value={d.featureContract.currentNamesHash} tone={contractHealthy ? "text-white/40" : "text-rose-400"} />
                </div>
              </CompactPanel>

              <CompactPanel title="Data Enrichment" help="Background processing of competition market efficiency.">
                <div className="space-y-0.5">
                  <Kv label="Coverage" value={`${d.enrichmentCoverage.coveragePct}%`} tone={d.enrichmentCoverage.coveragePct >= 80 ? "text-emerald-400" : "text-amber-400"} />
                  <Kv label="Competitions" value={d.enrichmentCoverage.distinctCompetitions} />
                  <Kv label="Enriched" value={d.enrichmentCoverage.enrichedCompetitions} tone="text-cyan-400" />
                  <Kv label="High Conf." value={d.enrichmentCoverage.highConfidence} tone="text-emerald-400" />
                </div>
              </CompactPanel>

              <CompactPanel title="Training Corpus" help="Historical snapshot of isolated training data.">
                {d.trainingComposition.totalExamples > 0 ? (
                  <div className="space-y-0.5">
                    <Kv label="Total Samples" value={d.trainingComposition.totalExamples.toLocaleString()} />
                    {Object.entries(d.trainingComposition.byLabel).slice(0, 2).map(([label, cnt]) => (
                      <Kv key={label} label={label.charAt(0).toUpperCase() + label.slice(1)} value={cnt.toLocaleString()} tone={label === "positive" ? "text-emerald-400" : "text-rose-400"} />
                    ))}
                  </div>
                ) : <p className="text-[10px] text-white/40">No localized examples</p>}
                {d.rejectedModels.length > 0 && (
                  <p className="mt-2 rounded-md bg-amber-500/10 border border-amber-500/20 p-1.5 text-[10px] text-amber-400">{d.rejectedModels.length} models rejected</p>
                )}
              </CompactPanel>
           </div>
        </div>

        {/* Right Column: Score Analytics */}
        <div className="xl:col-span-4 flex flex-col gap-2.5 min-h-0">
           <CompactPanel title="Score Distribution" help="Model confidence spread." className="flex-1 min-h-0">
             {dist.totalScored > 0 ? (
               <div className="flex flex-col h-full justify-end">
                 <div className="flex flex-1 items-end gap-0.5 w-full">
                   {dist.buckets.map((bucket, i) => {
                     const bucketPct = (bucket.count / maxBucket) * 100;
                     return (
                       <Tooltip key={bucket.range}>
                         <TooltipTrigger asChild>
                           <div className="group/bar flex min-w-0 flex-1 flex-col items-center h-full">
                             <div className="relative w-full rounded-t-[2px] bg-white/[0.02] flex-1">
                               <div
                                 className={cn("absolute bottom-0 w-full rounded-t-[2px] transition-all duration-700", i < 4 ? "bg-gradient-to-t from-rose-500/80 to-amber-400" : "bg-gradient-to-t from-cyan-600 to-teal-400")}
                                 style={{ height: `${Math.max(bucketPct, 2)}%` }}
                               />
                             </div>
                             <span className="text-[7px] font-mono text-white/30 mt-0.5 leading-none">{bucket.range.split("–")[0]}</span>
                           </div>
                         </TooltipTrigger>
                         <TooltipContent side="top" className="text-[10px] p-1.5">{bucket.range}: {bucket.count}</TooltipContent>
                       </Tooltip>
                     );
                   })}
                 </div>
                 <div className="mt-1 flex justify-between text-[9px] font-bold uppercase tracking-wider">
                   <span className="text-amber-400">{dist.belowThreshold.toLocaleString()} Below</span>
                   <span className="text-teal-400">{dist.aboveThreshold.toLocaleString()} Above</span>
                 </div>
               </div>
             ) : <div className="text-[10px] text-white/30 font-mono text-center flex-1 flex items-center justify-center">Awaiting data...</div>}
           </CompactPanel>

           <CompactPanel title="Bucket Performance" help="Monotonicity check." className="flex-1 min-h-0">
             {d.scoreBucketROI.some((b) => b.count > 0) ? (
               <div className="flex flex-col h-full">
                 <div className="grid grid-cols-[1.2fr_1fr_1fr_1fr_1fr] gap-x-1 border-b border-white/[0.08] pb-1 text-[8px] font-bold uppercase tracking-widest text-white/40 shrink-0">
                   <span>Bucket</span><span className="text-right">N</span><span className="text-right">Win%</span><span className="text-right">PnL</span><span className="text-right">CLV</span>
                 </div>
                 <div className="flex-1 overflow-y-auto mt-1 space-y-px">
                   {d.scoreBucketROI.map((b) => (
                     <div key={b.bucket} className="grid grid-cols-[1.2fr_1fr_1fr_1fr_1fr] items-center gap-x-1 rounded px-1 py-1 hover:bg-white/[0.04]">
                       <span className="font-mono text-[9px] text-white/60 truncate">{b.bucket}</span>
                       <span className="text-right font-mono text-[9px] text-white/80">{b.count}</span>
                       <span className={cn("text-right font-mono text-[9px]", b.winRate > 50 ? "text-emerald-400" : b.winRate > 0 ? "text-amber-400" : "text-white/30")}>{b.count > 0 ? `${b.winRate}%` : "—"}</span>
                       <span className={cn("text-right font-mono text-[9px]", b.avgPnl > 0 ? "text-emerald-400" : b.avgPnl < 0 ? "text-rose-400" : "text-white/30")}>{b.count > 0 ? b.avgPnl.toFixed(0) : "—"}</span>
                       <span className={cn("text-right font-mono text-[9px]", b.avgClv > 0 ? "text-emerald-400" : b.avgClv < 0 ? "text-rose-400" : "text-white/30")}>{b.count > 0 ? `${b.avgClv.toFixed(1)}%` : "—"}</span>
                     </div>
                   ))}
                 </div>
               </div>
             ) : <div className="text-[10px] font-mono text-white/30 text-center pt-4">No data</div>}
           </CompactPanel>
        </div>
      </div>
    </div>
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
  const isTerminal = ["completed", "failed", "rejected"].includes(training.phase);

  // Elapsed timer: server provides base, local interval ticks for smoothness.
  const serverElapsedMs = training.elapsedMs ?? 0;
  const [tickMs, setTickMs] = useState(0);

  useEffect(() => {
    if (isTerminal) return;
    let first = true;
    const interval = setInterval(() => {
      setTickMs((prev) => {
        if (first) { first = false; return 0; }
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
  const estimatedRemaining = Math.max(0, TYPICAL_TRAINING_DURATION_MS - elapsed);

  // Determine banner color based on terminal state
  const bannerColor = training.phase === "completed"
    ? "border-emerald-500/40 bg-emerald-500/10"
    : training.phase === "failed"
      ? "border-red-500/40 bg-red-500/10"
      : training.phase === "rejected"
        ? "border-amber-500/40 bg-amber-500/10"
        : "border-cyan-500/40 bg-cyan-500/10";

  const glowColor = training.phase === "completed"
    ? "bg-emerald-500 shadow-[0_0_12px_rgba(16,185,129,0.8)]"
    : training.phase === "failed"
      ? "bg-red-500 shadow-[0_0_12px_rgba(239,68,68,0.8)]"
      : training.phase === "rejected"
        ? "bg-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.8)]"
        : "bg-cyan-500 shadow-[0_0_12px_rgba(34,211,238,0.8)]";

  const textColor = training.phase === "completed"
    ? "text-emerald-400"
    : training.phase === "failed"
      ? "text-red-400"
      : training.phase === "rejected"
        ? "text-amber-400"
        : "text-cyan-400";

  return (
    <div className={cn("rounded-xl border p-3 transition-all duration-500", bannerColor)}>
      {/* Header row */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className={cn("size-2 rounded-full", glowColor, !isTerminal && "animate-pulse")} />
          <span className={cn("text-[10px] font-extrabold uppercase tracking-widest", textColor)}>
            {isTerminal
              ? training.phase === "completed" ? "Training Complete" : training.phase === "rejected" ? "Model Rejected" : "Training Failed"
              : "Cloud Run Job Active"}
          </span>
          <span className="text-[10px] font-bold text-white/60">v{training.version}</span>
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
              <TooltipContent>Real-time updates via Server-Sent Events</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Metrics row — training-specific data (not pipeline phases) */}
      <div className="grid grid-cols-4 gap-2 mb-2.5">
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5">
          <div className="text-[8px] font-bold uppercase tracking-wider text-white/40">Training Data</div>
          <div className="text-sm font-bold tabular-nums text-white">{dataCount.toLocaleString()}</div>
          <div className="text-[8px] text-white/30">vectors</div>
        </div>
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5">
          <div className="text-[8px] font-bold uppercase tracking-wider text-white/40">Elapsed</div>
          <div className={cn("text-sm font-bold tabular-nums font-mono", textColor)}>{formatElapsed(elapsed)}</div>
          <div className="text-[8px] text-white/30">{isTerminal ? "total" : "running"}</div>
        </div>
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5">
          <div className="text-[8px] font-bold uppercase tracking-wider text-white/40">{isTerminal ? "Result" : "ETA"}</div>
          <div className="text-sm font-bold tabular-nums text-white">
            {isTerminal
              ? (training.phase === "completed" ? "Deployed" : training.phase === "rejected" ? "Rejected" : "Failed")
              : estimatedRemaining > 0 ? `~${formatElapsed(estimatedRemaining)}` : "Finalizing..."}
          </div>
          <div className="text-[8px] text-white/30">{isTerminal ? training.phase : "remaining"}</div>
        </div>
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5">
          <div className="text-[8px] font-bold uppercase tracking-wider text-white/40">Progress</div>
          <div className={cn("text-sm font-bold tabular-nums", textColor)}>{progressPct}%</div>
          <div className="text-[8px] text-white/30">estimated</div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="mb-2">
        <div className="h-2 overflow-hidden rounded-full bg-white/10">
          <div
            className={cn("h-full rounded-full transition-all duration-1000", glowColor)}
            style={{ width: `${progressPct}%` }}
          />
        </div>
        {!isTerminal && (
          <div className="flex justify-between mt-1 text-[8px] text-white/30 font-mono">
            <span>LightGBM CPCV · 25 features · {dataCount.toLocaleString()} samples</span>
            <span>{estimatedRemaining > 0 ? `~${formatElapsed(estimatedRemaining)} remaining` : `${formatElapsed(elapsed)} elapsed — finalizing`}</span>
          </div>
        )}
      </div>

      {/* Status Message */}
      <div className="flex items-center gap-2">
        {!isTerminal && <Activity className={cn("size-3 animate-pulse", textColor)} />}
        <p className="text-xs font-medium text-white/80">{training.message}</p>
      </div>

      {/* Metrics (for completed/rejected) */}
      {training.metrics && (
        <div className="mt-2 grid grid-cols-4 gap-2">
          {training.metrics.aucRoc != null && (
            <div className="rounded-md border border-white/5 bg-white/5 px-2 py-1">
              <div className="text-[8px] font-bold uppercase tracking-wider text-white/40">AUC-ROC</div>
              <div className={cn("text-xs font-bold tabular-nums", (training.metrics.aucRoc ?? 0) > 0.55 ? "text-emerald-400" : "text-amber-400")}>{training.metrics.aucRoc.toFixed(4)}</div>
            </div>
          )}
          {training.metrics.dsr != null && (
            <div className="rounded-md border border-white/5 bg-white/5 px-2 py-1">
              <div className="text-[8px] font-bold uppercase tracking-wider text-white/40">DSR</div>
              <div className={cn("text-xs font-bold tabular-nums", (training.metrics.dsr ?? 0) > 0.8 ? "text-emerald-400" : "text-amber-400")}>{training.metrics.dsr.toFixed(3)}</div>
            </div>
          )}
          {training.metrics.pbo != null && (
            <div className="rounded-md border border-white/5 bg-white/5 px-2 py-1">
              <div className="text-[8px] font-bold uppercase tracking-wider text-white/40">PBO</div>
              <div className={cn("text-xs font-bold tabular-nums", (training.metrics.pbo ?? 0) < 0.5 ? "text-emerald-400" : "text-rose-400")}>{training.metrics.pbo.toFixed(3)}</div>
            </div>
          )}
          {training.metrics.permissionLevel && (
            <div className="rounded-md border border-white/5 bg-white/5 px-2 py-1">
              <div className="text-[8px] font-bold uppercase tracking-wider text-white/40">Gate</div>
              <div className="text-[10px] font-bold text-white">{training.metrics.permissionLevel}</div>
            </div>
          )}
        </div>
      )}

      {/* Rejection reasons */}
      {training.metrics?.rejectionReasons && training.metrics.rejectionReasons.length > 0 && (
        <div className="mt-2 space-y-1">
          {training.metrics.rejectionReasons.slice(0, 3).map((r, i) => (
            <div key={i} className="flex items-start gap-1.5 text-[10px] text-amber-300/80">
              <AlertTriangle className="size-3 mt-px shrink-0" />
              <span>{r}</span>
            </div>
          ))}
        </div>
      )}

      {/* Recent Activity Log (last 3 entries) */}
      {log.length > 1 && (
        <div className="mt-2 border-t border-white/5 pt-2">
          <div className="text-[8px] font-bold uppercase tracking-widest text-white/30 mb-1">Activity Log</div>
          <div className="space-y-0.5">
            {log.slice(0, 3).map((entry, i) => (
              <div key={`${entry.modelId}-${entry.phase}-${i}`} className="flex items-center gap-2 text-[10px]">
                <span className="text-white/30 font-mono tabular-nums w-10 shrink-0">
                  {new Date(entry.updatedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
                <span className={cn(
                  "size-1 rounded-full shrink-0",
                  entry.phase === "completed" ? "bg-emerald-400" :
                  entry.phase === "failed" ? "bg-red-400" :
                  entry.phase === "rejected" ? "bg-amber-400" :
                  "bg-cyan-400",
                )} />
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
  const canAffectBets = d.deploymentGate.canGate || d.deploymentGate.canReduceStake;
  
  const title = !coldDone ? "Data Collection Phase" : !modelLoaded ? "First Training Required" : canAffectBets ? "Active Monitoring" : "Shadow Mode Active";
  const body = !coldDone ? `${Math.max(0, d.dataCollection.coldStartThreshold - d.dataCollection.settledWithFeatures).toLocaleString()} more settled bets needed.` : !modelLoaded ? "Dataset ready. Initiate training." : canAffectBets ? "Optimizer is live and adjusting stakes." : "Model logging scores safely in shadow mode.";

  return (
    <div className="relative flex items-center justify-between overflow-hidden rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
      <div className="absolute left-0 top-0 h-full w-1 bg-cyan-500/50" />
      <div className="absolute -inset-px bg-gradient-to-r from-foreground/5 to-transparent opacity-50 pointer-events-none" />
      
      <div className="relative z-10 flex flex-1 items-center gap-4 min-w-0">
         <OptimizerStatusPill data={d} />
         <div className="h-4 w-px bg-white/20 shrink-0" />
         <h2 className="text-sm font-bold tracking-tight text-white whitespace-nowrap shrink-0">{title}</h2>
         <p className="text-xs text-white/50 truncate min-w-0 hidden sm:block">{body}</p>
      </div>
      
      {coldDone && !modelLoaded && (
         <div className="shrink-0 relative ml-4">
           <RetrainButton size="sm" hasExistingModel={d.training.totalModels > 0} />
         </div>
      )}
    </div>
  );
}

function PipelineRail({ statuses, data: _data, isTraining }: { statuses: StageStatus[]; data: PipelineData; isTraining?: boolean }) {
  const current = firstIncompleteStep(statuses);
  const trainStageIdx = STAGES.findIndex((s) => s.key === "train");

  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-5 py-3 backdrop-blur-xl">
      <div className="flex items-center justify-between mb-2">
        <SectionTitle title="Execution Pipeline" />
        <div className="rounded-full bg-white/[0.05] border border-white/[0.1] px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-white/60">
          Stage <span className="text-cyan-400">{current + 1}</span> / {STAGES.length}
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
            <div key={stage.key} className={cn("flex items-start", i < STAGES.length - 1 ? "flex-1" : "shrink-0")}>
              <div className="flex flex-col items-center relative z-10">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className={cn(
                      "relative flex size-8 items-center justify-center rounded-lg border transition-all duration-300",
                      isComplete ? "border-emerald-500/50 bg-emerald-500/20 text-emerald-300" :
                      isCurrent ? "border-cyan-400 bg-cyan-500/20 text-cyan-300 scale-110 shadow-[0_0_15px_rgba(34,211,238,0.3)]" :
                      isWarning ? "border-amber-500/50 bg-amber-500/20 text-amber-300" :
                      "border-white/10 bg-white/5 text-white/30",
                    )}>
                      {isComplete ? <Check className="size-4" /> : isWarning ? <AlertTriangle className="size-4" /> : <Icon className={cn("size-4", (isCurrent || (i === trainStageIdx && isTraining)) && "animate-pulse")} />}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent className="text-[10px] p-1.5">{stage.desc}</TooltipContent>
                </Tooltip>
                <span className={cn("mt-1.5 text-[9px] font-bold uppercase tracking-widest", isComplete ? "text-emerald-400" : isCurrent ? "text-cyan-400" : "text-white/40")}>{stage.label}</span>
              </div>
              
              {i < STAGES.length - 1 && (
                <div className="flex-1 pt-3.5 px-2">
                  <div className="relative h-1 w-full rounded-full bg-white/5 overflow-hidden">
                    <div className={cn("absolute inset-0 rounded-full transition-all duration-1000", isComplete ? "bg-emerald-500" : "w-0")} />
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
      const res = await fetch("/api/ml/schedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !settings.enabled }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      toast.success(!settings.enabled ? "Autopilot Engaged" : "Autopilot Disengaged");
      void queryClient.invalidateQueries({ queryKey: ["ml", "pipeline"] });
    } catch (err) { toast.error(`System Update Failed: ${err instanceof Error ? err.message : String(err)}`); }
    finally { setSaving(false); }
  }, [settings, queryClient]);

  const updateCadence = useCallback(async (hours: number) => {
    setSaving(true);
    try {
      const res = await fetch("/api/ml/schedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cadenceHours: hours }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      toast.success(`Cycle set to ${hours < 24 ? `${hours}h` : `${hours / 24}d`}`);
      void queryClient.invalidateQueries({ queryKey: ["ml", "pipeline"] });
    } catch (err) { toast.error(`Calibration Failed: ${err instanceof Error ? err.message : String(err)}`); }
    finally { setSaving(false); }
  }, [queryClient]);

  return (
    <CompactPanel title="Auto-Retrain" help="Triggers Cloud Run jobs based on data growth.">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-bold uppercase tracking-widest text-white/50">Switch</span>
        <Button
          variant="outline"
          size="sm"
          onClick={toggleScheduler}
          disabled={saving || !settings}
          className={cn(
            "h-6 px-3 rounded-md border text-[10px] transition-all",
            settings?.enabled ? "border-cyan-500/50 bg-cyan-500/20 text-cyan-300" : "border-white/10 bg-white/5 text-white/40",
          )}
        >
          <Power className={cn("size-2.5 mr-1", settings?.enabled && "text-cyan-400")} /> {settings?.enabled ? "Online" : "Offline"}
        </Button>
      </div>

      <div className="space-y-0.5 mb-3">
        <Kv label="Engine" value={d.scheduler.active ? "Sync" : "Halt"} tone={d.scheduler.active ? "text-emerald-400" : "text-white/40"} />
        <Kv label="Cycles" value={d.scheduler.totalRetrainTriggers} />
        <Kv label="Pulse" value={d.scheduler.lastTickAt ? `${Math.round((Date.now() - d.scheduler.lastTickAt) / 1000)}s` : "—"} tone="text-white/40" />
        <Kv label="Gate" value={`${settings?.minGrowthPct ?? 20}%`} tone="text-cyan-300" />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-widest text-white/40">
          <Clock className="size-2.5" /> Frequency
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          {[12, 24, 72, 168].map((h) => (
            <button
              key={h}
              onClick={() => void updateCadence(h)}
              disabled={saving}
              className={cn(
                "h-5 rounded-[4px] border px-2 text-[9px] font-bold transition-all",
                h === (settings?.cadenceHours ?? 24) ? "border-cyan-500/50 bg-cyan-500/20 text-cyan-300" : "border-white/10 bg-white/5 text-white/50",
              )}
            >
              {h < 24 ? `${h}H` : `${h / 24}D`}
            </button>
          ))}
        </div>
      </div>
      {(d.scheduler.lastError || settings?.lastError) && <p className="mt-2 text-[9px] text-rose-400 truncate">{d.scheduler.lastError || settings?.lastError}</p>}
    </CompactPanel>
  );
}

// ── Setup Guide Tab ───────────────────────────────────────────────────

function SetupGuideTab({ data: d, statuses, trainingStream }: { data: PipelineData; statuses: StageStatus[]; trainingStream: MLTrainingState }) {
  const [activeStep, setActiveStep] = useState(() => firstIncompleteStep(statuses));

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
                  isActive ? "border-cyan-500/40 bg-cyan-500/10" : "border-transparent hover:bg-white/[0.05]",
                )}
              >
                <div className={cn("flex size-7 shrink-0 items-center justify-center rounded-md border", status === "healthy" ? "border-emerald-500/50 bg-emerald-500/20 text-emerald-300" : status === "progressing" ? "border-cyan-500/50 bg-cyan-500/20 text-cyan-300" : status === "warning" ? "border-amber-500/50 bg-amber-500/20 text-amber-300" : "border-white/10 bg-white/5 text-white/40")}>
                  {status === "healthy" ? <Check className="size-3.5" /> : <Icon className="size-3.5" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={cn("truncate text-xs font-bold", isActive ? "text-cyan-400" : "text-white/80")}>{stage.label}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>
      
      {/* Detail Panel */}
      <div className="flex-1 min-w-0 h-full">
        <StepDetailPanel step={activeStep} data={d} statuses={statuses} trainingStream={trainingStream} />
      </div>
    </div>
  );
}

function StepDetailPanel({ step, data: d, statuses, trainingStream }: { step: number; data: PipelineData; statuses: StageStatus[]; trainingStream: MLTrainingState }) {
  const stage = STAGES[step] ?? STAGES[0];
  const status = statuses[step] ?? "waiting";
  const Icon = stage.icon;
  const coldDone = d.dataCollection.coldStartProgress >= 100;
  const remainingSettled = Math.max(0, d.dataCollection.coldStartThreshold - d.dataCollection.settledWithFeatures);

  const content = (() => {
    switch (step) {
      case 0: return {
          summary: "Each detected value bet must be enriched with a comprehensive feature vector before qualifying as training data. This process happens asynchronously as market data streams in.",
          rows: [["Total bets", d.dataCollection.totalBets.toLocaleString()], ["With features", d.dataCollection.betsWithFeatures.toLocaleString()], ["Recent feature rate", `${d.dataCollection.recentFeatureRate}%`], ["Feature dimensions", FEATURE_CATALOG.length.toLocaleString()]],
          action: d.dataCollection.betsWithFeatures > 0 ? "Data capture is active. Monitor recent feature rate; historical bets may skew the all-time average." : "Engage the main engine to allow live value-bet detection to begin writing feature vectors.",
        };
      case 1: return {
          summary: "Machine learning models require ground truth. Settlement volume dictates when the cold-start threshold is met, making the system ready for its initial training cycle.",
          rows: [["Settled + features", d.dataCollection.settledWithFeatures.toLocaleString()], ["Cold-start target", d.dataCollection.coldStartThreshold.toLocaleString()], ["Progress", `${d.dataCollection.coldStartProgress}%`], ["Remaining", remainingSettled.toLocaleString()]],
          action: coldDone ? "Threshold achieved. The dataset is fully primed for the inaugural training phase." : `${remainingSettled.toLocaleString()} additional settled, feature-rich bets are required to ensure statistical significance before training.`,
        };
      case 2: return {
          summary: "Initiating a Cloud Run job to process the dataset through LightGBM. The output is a candidate model bundled with cross-validated performance metrics.",
          rows: [["Models trained", d.training.totalModels.toLocaleString()], ["Currently training", d.training.modelsInTraining.toLocaleString()], ["New data", d.training.newDataSinceLastTrain.toLocaleString()], ["Growth Rate", `${d.training.growthPct}%`]],
          action: (trainingStream.isTraining || d.training.modelsInTraining > 0)
            ? `Training v${trainingStream.currentTraining?.version ?? d.training.activeTraining?.version ?? "?"} is in progress on ${d.dataCollection.settledWithFeatures.toLocaleString()} vectors. The Cloud Run Job typically takes 5–10 minutes.`
            : coldDone ? (d.training.totalModels > 0 ? "Retrain manually or let the scheduler manage cycles based on data growth." : "Commence the first training job. A candidate model will be generated and passed to validation.") : "Awaiting completion of the settlement cold-start phase.",
        };
      case 3: return {
          summary: "An automated quality control gate. Only models demonstrating strict monotonic performance, high AUC, and zero deflation are promoted. Overfit models are instantly rejected.",
          rows: [["Deployed model", d.training.deployedModel ? "Active" : "None"], ["Rejected models", d.rejectedModels.length.toLocaleString()], ["Current Permission", d.deploymentGate.permissionLevel], ["Gate refreshed", d.deploymentGate.lastRefreshedAt ? new Date(d.deploymentGate.lastRefreshedAt).toLocaleString() : "—"]],
          action: d.training.deployedModel ? "A verified model has passed all safety gates and is available to the inference engine." : d.rejectedModels.length > 0 ? "Review rejection diagnostics to understand model failures before adjusting thresholds." : "Awaiting a completed training run for validation.",
        };
      case 4: return {
          summary: "The engine caches the deployed ONNX model in memory, enabling ultra-low-latency runtime scoring of detected value bets before placement.",
          rows: [["Model Version", d.inference.modelLoaded ? `v${d.inference.modelVersion}` : "None"], ["Total scored", d.inference.totalScored.toLocaleString()], ["Avg latency", `${d.inference.avgInferenceMs.toFixed(2)}ms`], ["Avg score", d.scoreDistribution.totalScored > 0 ? d.scoreDistribution.avgScore.toFixed(3) : "—"]],
          action: d.inference.modelLoaded ? "Real-time inference is online. Analyze bucket performance matrices before elevating permission levels." : "Awaiting deployment of a validated model. The engine will auto-load it upon availability.",
        };
      default: return {
          summary: "Determines the model's operational authority. Shadow mode observes and logs passively. Active modes can selectively gate low-confidence bets or aggressively optimize stake sizing.",
          rows: [["System Permission", d.deploymentGate.permissionLevel], ["Can gate", d.deploymentGate.canGate ? "Authorized" : "Blocked"], ["Can reduce stake", d.deploymentGate.canReduceStake ? "Authorized" : "Blocked"], ["Can increase stake", d.deploymentGate.canIncreaseStake ? "Authorized" : "Blocked"]],
          action: d.deploymentGate.canGate || d.deploymentGate.canReduceStake ? "Placement logic is currently AI-driven. Closely monitor ROI metrics." : d.inference.modelLoaded ? "Shadow analysis is active. Review logged discrepancies between deterministic rules and AI suggestions before granting active permissions." : "Complete the inference stage to unlock ML-driven actions.",
        };
    }
  })();
  
  return (
    <div className="flex flex-col h-full rounded-xl border border-white/[0.08] bg-white/[0.02] backdrop-blur-xl overflow-hidden relative">
      <div className="flex-none p-4 pb-2 border-b border-white/[0.05]">
        <div className="flex items-center justify-between mb-2">
           <div className="flex items-center gap-3">
             <Icon className="size-6 text-cyan-400" />
             <h2 className="text-xl font-bold text-white tracking-tight">{stage.label}</h2>
             <span className={cn("rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest", statusTone(status))}>{statusLabel(status)}</span>
           </div>
           {step === 2 && coldDone && (
             <RetrainButton
               size="sm"
               hasExistingModel={d.training.totalModels > 0}
               isTraining={trainingStream.isTraining || d.training.modelsInTraining > 0}
               trainingVersion={trainingStream.currentTraining?.version ?? d.training.activeTraining?.version}
             />
           )}
        </div>
        <p className="text-xs text-white/60 mb-2 leading-relaxed">{content.summary}</p>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-4">
         <div className="grid grid-cols-2 gap-2">
           {content.rows.map(([label, value]) => (
              <Stat key={label} label={label} value={value} />
           ))}
         </div>

         <div className="rounded-lg border border-white/[0.05] bg-background/40 p-3">
            <div className="flex items-center gap-2 mb-3">
               <GitBranch className="size-3.5 text-indigo-400" />
               <h3 className="text-[10px] font-bold uppercase tracking-widest text-white/80">Diagnostic Evidence</h3>
            </div>
            
            {step === 0 ? (
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                {Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
                  <span key={cat} className="flex items-center gap-1.5 text-[10px] font-medium text-white/60">
                    <span className={cn("size-1.5 rounded-full", color)} />
                    {cat}: <span className="text-white">{FEATURE_CATALOG.filter((f) => f.cat === cat).length}</span>
                  </span>
                ))}
              </div>
            ) : step === 1 || (step === 2 && !(trainingStream.isTraining || d.training.modelsInTraining > 0)) ? (
              <div>
                <div className="mb-1.5 flex justify-between text-[9px] font-bold uppercase tracking-widest text-white/50">
                  <span>{d.dataCollection.settledWithFeatures} Vectors</span>
                  <span className={cn(coldDone ? "text-emerald-400" : "text-cyan-400")}>{d.dataCollection.coldStartProgress}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-white/10">
                  <div className={cn("h-full rounded-full transition-all duration-1000", coldDone ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]" : "bg-cyan-500 shadow-[0_0_8px_rgba(34,211,238,0.8)]")} style={{ width: `${Math.min(d.dataCollection.coldStartProgress, 100)}%` }} />
                </div>
              </div>
            ) : step === 2 && (trainingStream.isTraining || d.training.modelsInTraining > 0) ? (
              trainingStream.currentTraining ? (
                <LiveTrainingPanel
                  training={trainingStream.currentTraining}
                  log={trainingStream.trainingLog}
                  isConnected={trainingStream.isConnected}
                  dataCount={d.dataCollection.settledWithFeatures}
                />
              ) : (
                <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <Cpu className="size-3.5 text-cyan-400 animate-spin" />
                    <span className="text-[10px] font-bold uppercase tracking-widest text-cyan-400">Training in Progress</span>
                  </div>
                  <p className="text-[10px] text-white/60">Cloud Run Job is processing {d.dataCollection.settledWithFeatures.toLocaleString()} vectors...</p>
                </div>
              )
            ) : step === 3 && d.rejectedModels.length > 0 ? (
              <div className="grid grid-cols-2 gap-2">
                {d.rejectedModels.slice(0, 4).map((model) => (
                  <div key={model.version} className="rounded-md border border-rose-500/20 bg-rose-500/5 px-2 py-1.5 flex flex-col gap-0.5">
                    <div className="font-bold text-rose-300 text-[10px]">v{model.version}</div>
                    <div className="truncate text-[9px] font-medium text-white/50">{model.reasons[0] ?? model.status}</div>
                  </div>
                ))}
              </div>
            ) : step === 4 || step === 5 ? (
              <div className="grid grid-cols-2 gap-3">
                <Kv label="Sub-Threshold" value={d.scoreDistribution.belowThreshold.toLocaleString()} tone="text-amber-400" />
                <Kv label="Super-Threshold" value={d.scoreDistribution.aboveThreshold.toLocaleString()} tone="text-emerald-400" />
                <Kv label="Gating Engine" value={d.deploymentGate.canGate ? "Authorized" : "Blocked"} tone={d.deploymentGate.canGate ? "text-emerald-400" : "text-white/40"} />
                <Kv label="Stake Optimizer" value={d.deploymentGate.canReduceStake ? "Authorized" : "Blocked"} tone={d.deploymentGate.canReduceStake ? "text-emerald-400" : "text-white/40"} />
              </div>
            ) : (
              <p className="text-[10px] font-mono text-white/30">Awaiting telemetry data...</p>
            )}
         </div>

         <div className="rounded-xl border border-cyan-500/30 bg-cyan-500/10 p-4 mt-auto">
            <div className="flex items-center gap-2 mb-2">
               <Zap className="size-4 text-cyan-400 drop-shadow-[0_0_5px_rgba(34,211,238,0.8)] animate-pulse" />
               <h3 className="text-[10px] font-extrabold uppercase tracking-widest text-cyan-400">Required Operation</h3>
            </div>
            <p className="text-white/90 leading-relaxed text-xs font-medium">{content.action}</p>
         </div>
      </div>
    </div>
  );
}
