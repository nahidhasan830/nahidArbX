"use client";

/**
 * Bet Optimizer Dashboard — Two-tab layout: Overview + Setup Guide.
 *
 * Overview: full pipeline dashboard with all metrics in a single scroll.
 * Setup Guide: horizontal stepper with clickable steps and detail panels.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Database, Cpu, TrendingUp, FlaskConical, Zap,
  AlertTriangle, Check,
  LayoutDashboard, Route,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { HistorySection, RetrainButton } from "./MLModelStatus";

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
  scoreDistribution: {
    buckets: { range: string; count: number }[];
    avgScore: number;
    belowThreshold: number;
    aboveThreshold: number;
    totalScored: number;
  };
}

type StageStatus = "healthy" | "progressing" | "waiting" | "warning";

// ── Query ─────────────────────────────────────────────────────────────

export function usePipeline() {
  return useQuery<PipelineData>({
    queryKey: ["ml", "pipeline"],
    queryFn: async () => {
      const res = await fetch("/api/ml/pipeline", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 15_000,
  });
}

// ── Stage helpers ─────────────────────────────────────────────────────

const STAGES = [
  { key: "collect", label: "Data Collection", icon: Database, desc: "Feature extraction from live odds" },
  { key: "coldstart", label: "Cold Start", icon: FlaskConical, desc: "Accumulate settled training data" },
  { key: "training", label: "Train Model", icon: Cpu, desc: "LightGBM model via CPCV" },
  { key: "scoring", label: "Live Scoring", icon: Zap, desc: "Real-time ONNX inference" },
  { key: "staking", label: "Auto-Staking", icon: TrendingUp, desc: "Kelly-adjusted position sizing" },
] as const;

function getStageStatuses(d: PipelineData): StageStatus[] {
  // Data collection: healthy if any bets have features (pipeline is working)
  const s1: StageStatus = d.dataCollection.betsWithFeatures > 0 ? "healthy" : "progressing";
  const coldDone = d.dataCollection.settledWithFeatures >= d.dataCollection.coldStartThreshold;
  const s2: StageStatus = coldDone ? "healthy" : "progressing";
  const s3: StageStatus = d.training.modelsInTraining > 0
    ? "progressing" : d.training.totalModels > 0 ? "healthy" : (s2 === "healthy" ? "progressing" : "waiting");
  const s4: StageStatus = d.inference.modelLoaded ? "healthy" : (s3 === "healthy" ? "progressing" : "waiting");
  const s5: StageStatus = d.inference.modelLoaded ? "healthy" : "waiting";
  return [s1, s2, s3, s4, s5];
}

function firstIncompleteStep(statuses: StageStatus[]): number {
  const idx = statuses.findIndex((s) => s !== "healthy");
  return idx === -1 ? 0 : idx;
}

const STATUS_STYLES: Record<StageStatus, { dot: string; text: string; bg: string; border: string }> = {
  healthy:     { dot: "bg-emerald-400", text: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/30" },
  progressing: { dot: "bg-cyan-400 animate-pulse", text: "text-cyan-400", bg: "bg-cyan-500/10", border: "border-cyan-500/30" },
  waiting:     { dot: "bg-zinc-500", text: "text-muted-foreground/50", bg: "bg-muted/10", border: "border-border/40" },
  warning:     { dot: "bg-amber-400", text: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/30" },
};

// ── Stat chip ─────────────────────────────────────────────────────────

export function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="rounded-lg border border-border/40 bg-muted/20 px-3 py-2">
      <div className="text-[11px] text-muted-foreground mb-0.5">{label}</div>
      <div className={cn("text-base font-semibold tabular-nums", tone ?? "text-foreground")}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
    </div>
  );
}




// ── Main Dashboard ────────────────────────────────────────────────────

export function MLPipelineDashboard() {
  const { data, isLoading } = usePipeline();

  if (isLoading || !data) {
    return (
      <div className="py-16 flex-1">
        <div className="space-y-3 px-6">
          <div className="h-9 bg-muted/20 rounded-lg animate-pulse w-64" />
          <div className="flex gap-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex-1 h-16 bg-muted/15 rounded-xl animate-pulse" style={{ animationDelay: `${i * 100}ms` }} />
            ))}
          </div>
          <div className="h-48 bg-muted/10 rounded-xl animate-pulse" style={{ animationDelay: "200ms" }} />
        </div>
      </div>
    );
  }

  const statuses = getStageStatuses(data);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex flex-col flex-1 min-h-0">
        {/* Two-tab layout */}
        <Tabs defaultValue="overview" className="flex flex-col flex-1 min-h-0">
          <div className="px-6 pt-3 pb-2">
            <TabsList className="bg-muted/20 h-9 p-0.5 gap-0.5 rounded-lg">
              <TabsTrigger value="overview" className="gap-1.5 data-[state=active]:bg-background data-[state=active]:shadow-sm rounded-md px-3.5 py-1.5 text-sm transition-all">
                <LayoutDashboard className="size-3.5" />
                Overview
              </TabsTrigger>
              <TabsTrigger value="guide" className="gap-1.5 data-[state=active]:bg-background data-[state=active]:shadow-sm rounded-md px-3.5 py-1.5 text-sm transition-all">
                <Route className="size-3.5" />
                Pipeline Steps
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="overview" className="flex-1 min-h-0 mt-0 overflow-y-auto">
            <OverviewTab data={data} />
          </TabsContent>
          <TabsContent value="guide" className="flex-1 min-h-0 mt-0 overflow-y-auto">
            <SetupGuideTab data={data} statuses={statuses} />
          </TabsContent>
        </Tabs>
      </div>
    </TooltipProvider>
  );
}

// ── Overview Tab (dense single-screen dashboard) ──────────────────────

function OverviewTab({ data: d }: { data: PipelineData }) {
  const pct = d.dataCollection.coldStartProgress;
  const coldDone = pct >= 100;
  const dist = d.scoreDistribution;
  const maxBucket = dist ? Math.max(...dist.buckets.map((b) => b.count), 1) : 1;

  return (
    <div className="p-4 space-y-4">
      {/* Row 1: Key metrics strip */}
      <div className="grid grid-cols-3 lg:grid-cols-6 gap-2">
        <Stat label="Total Bets" value={d.dataCollection.totalBets} />
        <Stat label="With Features" value={d.dataCollection.betsWithFeatures} />
        <Stat label="Settled + Features" value={d.dataCollection.settledWithFeatures} tone="text-cyan-400" />
        <Stat label="Feature Rate" value={`${d.dataCollection.recentFeatureRate}%`}
          tone={d.dataCollection.recentFeatureRate > 80 ? "text-emerald-400" : d.dataCollection.recentFeatureRate > 0 ? "text-foreground" : "text-muted-foreground"} />
        <Stat label="Scorer" value={d.inference.modelLoaded ? `v${d.inference.modelVersion}` : "No model"}
          tone={d.inference.modelLoaded ? "text-emerald-400" : "text-muted-foreground"} />
        <Stat label="Scheduler" value={d.scheduler.active ? "Active" : "Off"}
          tone={d.scheduler.active ? "text-emerald-400" : "text-muted-foreground"} />
      </div>

      {d.dataCollection.recentFeatureRate < 50 && d.dataCollection.betsWithFeatures > 0 && (
        <p className="text-xs text-muted-foreground">
          Feature rate is low because older bets predate the ML pipeline. New bets are extracted automatically — rate improves over time.
        </p>
      )}

      {/* Row 2: Training progress + Scorer + Score distribution — 3 columns */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Training Readiness */}
        <div className="rounded-lg border border-border/40 bg-muted/10 p-3">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold text-foreground">Training Readiness</h4>
            {coldDone && <RetrainButton />}
          </div>
          <div className="mb-2">
            <div className="flex items-center justify-between text-[11px] mb-1">
              <span className="text-muted-foreground">{d.dataCollection.settledWithFeatures} / {d.dataCollection.coldStartThreshold}</span>
              <span className={cn("font-semibold tabular-nums", coldDone ? "text-emerald-400" : "text-cyan-400")}>{pct}%</span>
            </div>
            <div className="h-1.5 bg-muted/30 rounded-full overflow-hidden">
              <div className={cn("h-full rounded-full transition-all duration-700",
                coldDone ? "bg-gradient-to-r from-emerald-500 to-emerald-400" : "bg-gradient-to-r from-cyan-500 to-blue-400")}
                style={{ width: `${Math.min(pct, 100)}%` }} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <div className="flex justify-between"><span className="text-muted-foreground">Models trained</span><span className="tabular-nums font-medium">{d.training.totalModels}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">In training</span><span className="tabular-nums font-medium">{d.training.modelsInTraining}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">New since train</span><span className="tabular-nums font-medium">{d.training.newDataSinceLastTrain}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Growth</span><span className="tabular-nums font-medium">{d.training.growthPct}%</span></div>
          </div>
        </div>

        {/* Scorer Engine */}
        <div className="rounded-lg border border-border/40 bg-muted/10 p-3">
          <h4 className="text-xs font-semibold text-foreground mb-2">Scorer Engine</h4>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <div className="flex justify-between"><span className="text-muted-foreground">Status</span>
              <span className={cn("font-medium", d.inference.modelLoaded ? "text-emerald-400" : "text-muted-foreground")}>
                {d.inference.modelLoaded ? `v${d.inference.modelVersion} loaded` : "No model"}
              </span>
            </div>
            <div className="flex justify-between"><span className="text-muted-foreground">Total scored</span><span className="tabular-nums font-medium">{d.inference.totalScored.toLocaleString()}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Avg latency</span><span className="tabular-nums font-medium">{d.inference.avgInferenceMs.toFixed(2)}ms</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Avg score</span><span className="tabular-nums font-medium">{dist.totalScored > 0 ? dist.avgScore.toFixed(3) : "—"}</span></div>
          </div>
          {d.inference.error && (
            <p className="text-[11px] text-amber-400 mt-2">⚠ {d.inference.error}</p>
          )}
        </div>

        {/* Score Distribution */}
        <div className="rounded-lg border border-border/40 bg-muted/10 p-3">
          <h4 className="text-xs font-semibold text-foreground mb-2">Score Distribution</h4>
          {dist.totalScored > 0 ? (
            <>
              <div className="flex items-end gap-[2px] h-14 mb-1">
                {dist.buckets.map((bucket, i) => {
                  const bucketPct = (bucket.count / maxBucket) * 100;
                  return (
                    <Tooltip key={bucket.range}>
                      <TooltipTrigger asChild>
                        <div className={cn("flex-1 rounded-t min-w-[4px] cursor-help transition-all",
                          i < 4 ? "bg-amber-500/50 hover:bg-amber-500/70" : "bg-cyan-500/50 hover:bg-cyan-500/70")}
                          style={{ height: `${Math.max(bucketPct, 4)}%` }} />
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">{bucket.range}: {bucket.count}</TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>0.0</span><span>threshold</span><span>1.0</span>
              </div>
              <div className="flex gap-3 mt-1.5 text-[11px]">
                <span className="text-amber-400 tabular-nums">▼ {dist.belowThreshold} below</span>
                <span className="text-emerald-400 tabular-nums">▲ {dist.aboveThreshold} above</span>
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground py-4 text-center">No scores yet</p>
          )}
        </div>
      </div>

      {/* Row 3: Training History (compact) */}
      {d.training.totalModels > 0 && <HistorySection />}
    </div>
  );
}

// ── Setup Guide Tab (Horizontal Stepper) ──────────────────────────────

function SetupGuideTab({ data, statuses }: { data: PipelineData; statuses: StageStatus[] }) {
  const [activeStep, setActiveStep] = useState(() => firstIncompleteStep(statuses));

  return (
    <div className="p-6">
      {/* Horizontal stepper */}
      <div className="flex items-center gap-0 mb-8">
        {STAGES.map((stage, i) => {
          const status = statuses[i];
          const isActive = i === activeStep;
          const Icon = stage.icon;
          return (
            <div key={stage.key} className="flex items-center flex-1 last:flex-none">
              <button
                type="button"
                onClick={() => setActiveStep(i)}
                className={cn(
                  "flex items-center gap-3 rounded-xl px-4 py-3 flex-1 min-w-0 transition-all border cursor-pointer",
                  isActive
                    ? "bg-foreground/5 border-foreground/20 shadow-sm"
                    : "bg-transparent border-transparent hover:bg-muted/20",
                )}
              >
                <div className={cn(
                  "size-9 rounded-full flex items-center justify-center shrink-0 text-sm font-bold transition-all",
                  status === "healthy"
                    ? "bg-emerald-500/20 text-emerald-400"
                    : status === "progressing"
                      ? "bg-cyan-500/20 text-cyan-400"
                      : status === "warning"
                        ? "bg-amber-500/20 text-amber-400"
                        : "bg-muted/30 text-muted-foreground/40",
                )}>
                  {status === "healthy" ? (
                    <Check className="size-4" strokeWidth={2.5} />
                  ) : status === "progressing" ? (
                    <Icon className="size-4 animate-pulse" />
                  ) : status === "warning" ? (
                    <AlertTriangle className="size-4" />
                  ) : (
                    <Icon className="size-4" />
                  )}
                </div>
                <div className="min-w-0 text-left">
                  <div className={cn("text-sm font-medium truncate", isActive ? "text-foreground" : "text-muted-foreground")}>
                    {stage.label}
                  </div>
                  <div className="text-[10px] text-muted-foreground truncate">{stage.desc}</div>
                </div>
              </button>
              {i < STAGES.length - 1 && (
                <div className={cn("h-0.5 w-6 rounded-full shrink-0 mx-1",
                  statuses[i] === "healthy" ? "bg-emerald-500/40" : "bg-border/30")} />
              )}
            </div>
          );
        })}
      </div>

      {/* Step detail panel */}
      <div className="rounded-xl border border-border/40 bg-muted/5 p-6">
        {activeStep === 0 && <StepDataCollection data={data} />}
        {activeStep === 1 && <StepColdStart data={data} />}
        {activeStep === 2 && <StepTraining data={data} />}
        {activeStep === 3 && <StepScoring data={data} />}
        {activeStep === 4 && <StepStaking data={data} />}
      </div>
    </div>
  );
}
// ── Feature catalog (shared) ─────────────────────────────────────────

import { FEATURE_CATALOG, CATEGORY_COLORS } from "@/lib/ml/feature-catalog";


// ── Step panels ───────────────────────────────────────────────────────

function StepDataCollection({ data: d }: { data: PipelineData }) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-foreground mb-1">Step 1 — Data Collection</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Every time the engine detects a value bet, it extracts a 23-dimension feature vector. These features are stored alongside each bet for model training.
        </p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Total Bets" value={d.dataCollection.totalBets} />
        <Stat label="With Features" value={d.dataCollection.betsWithFeatures} />
        <Stat label="Feature Rate" value={`${d.dataCollection.recentFeatureRate}%`}
          tone={d.dataCollection.recentFeatureRate > 80 ? "text-emerald-400" : d.dataCollection.recentFeatureRate > 50 ? "text-amber-400" : "text-red-400"} />
        <Stat label="Settled + Features" value={d.dataCollection.settledWithFeatures} tone="text-cyan-400" />
      </div>
      <div className="rounded-lg border border-border/30 bg-muted/10 px-4 py-3 text-sm text-muted-foreground">
        <strong className="text-foreground">What&apos;s needed:</strong> Feature extraction runs automatically. Just make sure the engine is running and detecting value bets.
      </div>
      {d.dataCollection.recentFeatureRate < 50 && d.dataCollection.betsWithFeatures > 0 && (
        <p className="text-xs text-muted-foreground leading-relaxed">
          Feature rate is low because older bets predate the ML pipeline. New bets are being extracted — rate will improve over time.
        </p>
      )}

      {/* Feature Reference */}
      <div>
        <h4 className="text-sm font-semibold text-foreground mb-2">Feature Vector ({FEATURE_CATALOG.length} dimensions)</h4>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-1">
          {FEATURE_CATALOG.map((f) => (
            <Tooltip key={f.name}>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-2 py-1 cursor-help group">
                  <span className={cn("size-1.5 rounded-full shrink-0", CATEGORY_COLORS[f.cat])} />
                  <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors truncate">{f.label}</span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[280px] text-sm leading-relaxed">
                <div className="font-semibold mb-0.5">{f.label}</div>
                <div className="text-muted-foreground text-xs">{f.desc}</div>
                <div className="text-[10px] text-muted-foreground/60 mt-1 font-mono">{f.name}</div>
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
        <div className="flex gap-4 mt-2 text-[10px] text-muted-foreground">
          {Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
            <span key={cat} className="flex items-center gap-1">
              <span className={cn("size-1.5 rounded-full", color)} />{cat}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function StepColdStart({ data: d }: { data: PipelineData }) {
  const pct = d.dataCollection.coldStartProgress;
  const coldDone = pct >= 100;
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-foreground mb-1">Step 2 — Cold Start</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          The model needs settled bets (won/lost/void) with features to learn real outcomes. We need at least {d.dataCollection.coldStartThreshold} before training. You can always retrain later when you have more data — model quality improves with volume.
        </p>
      </div>
      <div className="mb-2">
        <div className="flex items-center justify-between text-sm mb-1.5">
          <span className="text-muted-foreground">{d.dataCollection.settledWithFeatures} / {d.dataCollection.coldStartThreshold} settled bets</span>
          <span className={cn("font-semibold tabular-nums", coldDone ? "text-emerald-400" : "text-cyan-400")}>{pct}%</span>
        </div>
        <div className="h-3 bg-muted/30 rounded-full overflow-hidden">
          <div className={cn("h-full rounded-full transition-all duration-700",
            coldDone ? "bg-gradient-to-r from-emerald-500 to-emerald-400" : "bg-gradient-to-r from-cyan-500 to-blue-400")}
            style={{ width: `${Math.min(pct, 100)}%` }} />
        </div>
      </div>
      <div className="rounded-lg border border-border/30 bg-muted/10 px-4 py-3 text-sm text-muted-foreground">
        <strong className="text-foreground">What&apos;s needed:</strong> {coldDone
          ? "Threshold reached! You can proceed to train a model."
          : `${d.dataCollection.coldStartThreshold - d.dataCollection.settledWithFeatures} more settled bets with features. Bets settle ~2h15m after kickoff.`}
      </div>
    </div>
  );
}

function StepTraining({ data: d }: { data: PipelineData }) {
  const coldDone = d.dataCollection.coldStartProgress >= 100;
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-foreground mb-1">Step 3 — Train Model</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Triggers a Cloud Run job that trains a LightGBM model using Combinatorial Purged Cross-Validation (CPCV). Takes 5-15 minutes. If the model passes quality gates (DSR &gt; 0.8, PBO &lt; 0.5), it&apos;s automatically deployed to the scorer.
        </p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Stat label="Models Trained" value={d.training.totalModels} />
        <Stat label="Currently Training" value={d.training.modelsInTraining} tone={d.training.modelsInTraining > 0 ? "text-cyan-400" : undefined} />
        <Stat label="New Data Available" value={d.training.newDataSinceLastTrain > 0 ? `+${d.training.newDataSinceLastTrain}` : "0"} />
      </div>
      {coldDone ? (
        <div className="flex items-center gap-3">
          <RetrainButton size="default" />
          <span className="text-sm text-muted-foreground">Ready to train — click to start a Cloud Run job.</span>
        </div>
      ) : (
        <div className="text-sm text-muted-foreground rounded-lg border border-border/40 bg-muted/10 px-4 py-3">
          Complete Step 2 (Cold Start) first — not enough settled data yet.
        </div>
      )}
    </div>
  );
}

function StepScoring({ data: d }: { data: PipelineData }) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-foreground mb-1">Step 4 — Live Scoring</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Once deployed, the ONNX model runs inside the engine process, scoring every detected value bet in real-time. Bets scoring below the 0.4 confidence threshold are filtered out from auto-placement.
        </p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Model" value={d.inference.modelLoaded ? `v${d.inference.modelVersion} loaded` : "No model"} tone={d.inference.modelLoaded ? "text-emerald-400" : "text-muted-foreground"} />
        <Stat label="Total Scored" value={d.inference.totalScored} />
        <Stat label="Avg Latency" value={`${d.inference.avgInferenceMs.toFixed(2)}ms`} />
        <Stat label="Avg Score" value={d.scoreDistribution.totalScored > 0 ? d.scoreDistribution.avgScore.toFixed(3) : "—"} />
      </div>
      {d.inference.error && (
        <div className="text-sm text-amber-400 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
          ⚠ {d.inference.error}
        </div>
      )}
      <div className="rounded-lg border border-border/30 bg-muted/10 px-4 py-3 text-sm text-muted-foreground">
        <strong className="text-foreground">What&apos;s needed:</strong> {d.inference.modelLoaded
          ? "Scoring is active! The model evaluates every value bet in real-time."
          : "Deploy a trained model first (Step 3). The scorer auto-loads it."}
      </div>
    </div>
  );
}

function StepStaking({ data: d }: { data: PipelineData }) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-foreground mb-1">Step 5 — Auto-Staking</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          The auto-placer uses the ML confidence score to apply Kelly-adjusted stake sizing. Higher confidence = larger position. Bets below the confidence threshold are skipped entirely.
        </p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Stat label="ML Gate" value={d.inference.modelLoaded ? "Active" : "Inactive"} tone={d.inference.modelLoaded ? "text-emerald-400" : "text-muted-foreground"} />
        <Stat label="Above Threshold" value={d.scoreDistribution.aboveThreshold} tone="text-emerald-400" />
        <Stat label="Below Threshold" value={d.scoreDistribution.belowThreshold} tone="text-amber-400" />
      </div>
      <div className="rounded-lg border border-border/30 bg-muted/10 px-4 py-3 text-sm text-muted-foreground">
        <strong className="text-foreground">What&apos;s needed:</strong> {d.inference.modelLoaded
          ? "Auto-staking is active. Check the Auto-Placer logs page for placement details."
          : "Complete Steps 3 and 4 first — the scorer needs a deployed model."}
      </div>
    </div>
  );
}
