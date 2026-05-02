"use client";

/**
 * Bet Optimizer — Section components for Model, Scoring, and History.
 *
 * Exports individual section components that are composed by the
 * main BetOptimizerDashboard in both the Overview and Setup Guide tabs.
 */

import { useCallback, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  BarChart3,
  RefreshCw,
  Clock,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Info,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { DataTable } from "@/components/ui/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import type { MlModelRow } from "@/lib/db/schema";
import { toast } from "sonner";
import { Stat } from "./MLPipelineDashboard";
import type { PipelineData } from "./MLPipelineDashboard";

// ── Types ─────────────────────────────────────────────────────────────

interface ScorerStatus {
  modelLoaded: boolean;
  modelVersion: number | null;
  modelPath: string | null;
  featureCount: number;
  totalScored: number;
  avgInferenceMs: number;
  lastInferenceMs: number;
  error?: string;
}

// ── Queries ───────────────────────────────────────────────────────────

export function useModels() {
  return useQuery<{ models: MlModelRow[] }>({
    queryKey: ["ml", "models"],
    queryFn: async () => {
      const res = await fetch("/api/ml/models", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
  });
}

function useScorer() {
  return useQuery<ScorerStatus>({
    queryKey: ["ml", "status"],
    queryFn: async () => {
      const res = await fetch("/api/ml/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 10_000,
  });
}

// ── Metric tooltips ───────────────────────────────────────────────────

const TIPS: Record<string, string> = {
  aucRoc: "Area Under the ROC Curve — 1.0 = perfect, 0.5 = random. Above 0.55 is useful.",
  dsr: "Deflated Sharpe Ratio — adjusts for trial count. Above 1.0 is strong.",
  pbo: "Probability of Backtest Overfitting — lower is better. Below 0.5 = likely real.",
  cal: "Calibration Error — predicted vs actual probabilities. Below 0.05 is good.",
  log: "Log Loss — penalises confident wrong predictions. Lower is better.",
  roi: "Out-of-Sample ROI — return on unseen data. Positive = profitable in backtest.",
};

// ── Helpers ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const cfg = {
    deployed: { icon: CheckCircle2, color: "text-emerald-400 bg-emerald-500/15 border-emerald-500/30", label: "Deployed" },
    validated: { icon: Activity, color: "text-blue-400 bg-blue-500/15 border-blue-500/30", label: "Validated" },
    training: { icon: Loader2, color: "text-amber-400 bg-amber-500/15 border-amber-500/30", label: "Training" },
    failed: { icon: XCircle, color: "text-red-400 bg-red-500/15 border-red-500/30", label: "Failed" },
    retired: { icon: Clock, color: "text-zinc-400 bg-zinc-500/15 border-zinc-500/30", label: "Retired" },
  }[status] ?? { icon: AlertTriangle, color: "text-zinc-400 bg-zinc-500/15 border-zinc-500/30", label: status };
  const Icon = cfg.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium", cfg.color)}>
      <Icon className={cn("size-3", status === "training" && "animate-pulse")} />
      {cfg.label}
    </span>
  );
}

function Metric({ label, value, tip, good }: { label: string; value: string; tip: string; good: boolean | null }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 mb-1">
        <span className="text-xs text-muted-foreground">{label}</span>
        <Tooltip><TooltipTrigger asChild>
          <button className="text-muted-foreground/50 hover:text-foreground transition-colors"><Info className="size-3" /></button>
        </TooltipTrigger><TooltipContent side="top" className="max-w-[280px] text-sm leading-relaxed">{tip}</TooltipContent></Tooltip>
      </div>
      <div className={cn("text-base font-semibold tabular-nums", good === true && "text-emerald-400", good === false && "text-amber-400", good === null && "text-foreground")}>
        {value}
      </div>
    </div>
  );
}

// ── Columns ───────────────────────────────────────────────────────────

const columns: ColumnDef<MlModelRow>[] = [
  { accessorKey: "version", header: "Ver",
    cell: ({ row }) => <span className="font-medium tabular-nums">v{row.original.version}</span>,
    meta: { hint: "Model version number", initialSize: 60 } },
  { accessorKey: "status", header: "Status",
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
    meta: { hint: "Model lifecycle: training → validated → deployed → retired", initialSize: 110 } },
  { accessorKey: "trainingSamples", header: "Samples",
    cell: ({ row }) => <span className="tabular-nums">{row.original.trainingSamples.toLocaleString()}</span>,
    meta: { hint: "Number of settled bets used for training", align: "right" as const, initialSize: 90 } },
  { accessorKey: "oosAucRoc", header: "AUC",
    cell: ({ row }) => row.original.oosAucRoc != null ? Number(row.original.oosAucRoc).toFixed(4) : "—",
    meta: { hint: TIPS.aucRoc, align: "right" as const, initialSize: 80 } },
  { accessorKey: "deflatedSharpe", header: "DSR",
    cell: ({ row }) => row.original.deflatedSharpe != null ? Number(row.original.deflatedSharpe).toFixed(3) : "—",
    meta: { hint: TIPS.dsr, align: "right" as const, initialSize: 80 } },
  { accessorKey: "pbo", header: "PBO",
    cell: ({ row }) => row.original.pbo != null ? Number(row.original.pbo).toFixed(3) : "—",
    meta: { hint: TIPS.pbo, align: "right" as const, initialSize: 80 } },
  { accessorKey: "createdAt", header: "Created",
    cell: ({ row }) => row.original.createdAt ? new Date(row.original.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—",
    meta: { hint: "When this model was trained", initialSize: 140 } },
];

// ── Retrain Button (shared) ───────────────────────────────────────────

export function RetrainButton({ size = "sm" }: { size?: "sm" | "default" }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const retrain = useMutation({
    mutationFn: async () => { const r = await fetch("/api/ml/retrain", { method: "POST" }); if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error ?? `HTTP ${r.status}`); } return r.json(); },
    onSuccess: () => { toast.success("Retraining job triggered"); void qc.invalidateQueries({ queryKey: ["ml"] }); },
    onError: (e) => toast.error(`Retrain failed: ${e.message}`),
  });
  const doRetrain = useCallback(() => { setOpen(false); retrain.mutate(); }, [retrain]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Tooltip><TooltipTrigger asChild>
          <Button variant="outline" size={size} className={cn("px-3 text-xs", size === "sm" && "h-8")} disabled={retrain.isPending}>
            {retrain.isPending ? <Loader2 className="size-3 animate-spin mr-1.5" /> : <RefreshCw className="size-3 mr-1.5" />}
            Retrain Model
          </Button>
        </TooltipTrigger><TooltipContent>Trigger a Cloud Run training job (5-15 min)</TooltipContent></Tooltip>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Trigger Retraining?</DialogTitle>
        <DialogDescription>Trains a new LightGBM model using CPCV. Takes 5-15 minutes. Auto-deploys if it passes quality gates.</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={doRetrain}>Start Training</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Model Section ─────────────────────────────────────────────────────

export function ModelSection() {
  const { data: md, isLoading: ml } = useModels();
  const { data: sc, isLoading: sl } = useScorer();

  const models = md?.models ?? [];
  const deployed = models.find((m) => m.status === "deployed");

  const fi = useMemo(() => {
    if (!deployed?.featureImportance) return [];
    const m = deployed.featureImportance as Record<string, number>;
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 15);
  }, [deployed]);
  const maxFi = fi[0]?.[1] ?? 0;
  const [fiOpen, setFiOpen] = useState(false);

  return (
    <div className="space-y-6">
      {/* Scorer */}
      <section>
        <h3 className="text-base font-semibold text-foreground mb-1">Scorer Engine</h3>
        <p className="text-sm text-muted-foreground mb-3 leading-relaxed">
          Real-time ONNX inference engine running inside the backend process. Scores every detected value bet.
        </p>
        {sl ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-border/40 bg-muted/20 px-3 py-2">
                <div className="h-3 w-16 bg-muted/30 rounded animate-pulse mb-1.5" />
                <div className="h-5 w-20 bg-muted/20 rounded animate-pulse" style={{ animationDelay: `${i * 80}ms` }} />
              </div>
            ))}
          </div>
        ) : sc ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Status" value={sc.modelLoaded ? `v${sc.modelVersion} loaded` : "No model"} tone={sc.modelLoaded ? "text-emerald-400" : "text-muted-foreground"} />
            <Stat label="Total Scored" value={sc.totalScored} />
            <Stat label="Avg Latency" value={`${sc.avgInferenceMs.toFixed(2)}ms`} />
            <Stat label="Features" value={sc.featureCount} />
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">Engine unreachable</div>
        )}
      </section>

      {/* Deployed Model */}
      <section>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-base font-semibold text-foreground">Deployed Model</h3>
          <RetrainButton />
        </div>
        <p className="text-sm text-muted-foreground mb-3 leading-relaxed">
          The currently active model used for live scoring. Models passing quality gates (DSR &gt; 0.8, PBO &lt; 0.5) are auto-deployed.
        </p>
        {ml ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-border/40 bg-muted/20 px-3 py-2">
                <div className="h-3 w-16 bg-muted/30 rounded animate-pulse mb-1.5" />
                <div className="h-5 w-20 bg-muted/20 rounded animate-pulse" style={{ animationDelay: `${i * 80}ms` }} />
              </div>
            ))}
          </div>
        ) : deployed ? (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <Stat label="Version" value={`v${deployed.version}`} />
              <Stat label="Type" value={deployed.modelType} />
              <Stat label="Samples" value={deployed.trainingSamples} />
              <Stat label="Deployed" value={deployed.deployedAt ? new Date(deployed.deployedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—"} />
            </div>
            {/* Metrics */}
            <h4 className="text-sm font-semibold text-foreground mb-3">Model Quality (Out-of-Sample)</h4>
            <div className="flex items-center gap-8 flex-wrap mb-4">
              <Metric label="AUC-ROC" value={deployed.oosAucRoc != null ? Number(deployed.oosAucRoc).toFixed(4) : "—"} tip={TIPS.aucRoc} good={deployed.oosAucRoc != null ? Number(deployed.oosAucRoc) > 0.55 : null} />
              <Metric label="DSR" value={deployed.deflatedSharpe != null ? Number(deployed.deflatedSharpe).toFixed(4) : "—"} tip={TIPS.dsr} good={deployed.deflatedSharpe != null ? Number(deployed.deflatedSharpe) > 1.0 : null} />
              <Metric label="PBO" value={deployed.pbo != null ? Number(deployed.pbo).toFixed(4) : "—"} tip={TIPS.pbo} good={deployed.pbo != null ? Number(deployed.pbo) < 0.5 : null} />
              <Metric label="Calibration" value={deployed.calibrationError != null ? Number(deployed.calibrationError).toFixed(6) : "—"} tip={TIPS.cal} good={deployed.calibrationError != null ? Number(deployed.calibrationError) < 0.05 : null} />
              <Metric label="Log Loss" value={deployed.oosLogLoss != null ? Number(deployed.oosLogLoss).toFixed(6) : "—"} tip={TIPS.log} good={null} />
              <Metric label="OOS ROI" value={deployed.oosRoiMean != null ? `${Number(deployed.oosRoiMean).toFixed(4)}%` : "—"} tip={TIPS.roi} good={deployed.oosRoiMean != null ? Number(deployed.oosRoiMean) > 0 : null} />
            </div>
          </>
        ) : (
          <div className="text-sm text-muted-foreground rounded-lg border border-border/40 bg-muted/10 px-4 py-3">
            No model deployed yet. Collect enough data, then click <strong>Retrain Model</strong>.
          </div>
        )}
      </section>

      {/* Feature Importance */}
      {fi.length > 0 && (
        <section>
          <button type="button" onClick={() => setFiOpen(!fiOpen)}
            className="flex items-center gap-2 text-base font-semibold text-foreground hover:text-foreground/80 transition-colors mb-3">
            <BarChart3 className="size-4 text-cyan-400" />
            Feature Importance
            {fiOpen ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
            <span className="text-xs font-normal text-muted-foreground">Top {fi.length} by SHAP</span>
          </button>
          {fiOpen && (
            <div className="space-y-1">
              {fi.map(([name, imp]) => (
                <div key={name} className="flex items-center gap-3 py-1">
                  <span className="text-xs text-muted-foreground w-36 truncate shrink-0">{name}</span>
                  <div className="flex-1 h-3.5 bg-muted/30 rounded-sm overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-cyan-500/60 to-cyan-400/40 rounded-sm transition-all duration-500"
                      style={{ width: `${maxFi > 0 ? (imp / maxFi) * 100 : 0}%` }} />
                  </div>
                  <span className="text-[10px] text-muted-foreground tabular-nums w-14 text-right">{imp.toFixed(4)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// ── Scoring Section ───────────────────────────────────────────────────

export function ScoringSection({ pipelineData }: { pipelineData?: PipelineData }) {
  const dist = pipelineData?.scoreDistribution;
  const maxCount = dist ? Math.max(...dist.buckets.map((b) => b.count), 1) : 1;

  return (
    <section>
      <h3 className="text-base font-semibold text-foreground mb-1">Score Distribution</h3>
      <p className="text-sm text-muted-foreground mb-4 leading-relaxed">
        Distribution of ML confidence scores across all scored bets. Bets scoring below the 0.4 threshold are automatically skipped by the auto-placer.
      </p>
      {dist && dist.totalScored > 0 ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <Stat label="Total Scored" value={dist.totalScored} />
            <Stat label="Avg Score" value={dist.avgScore.toFixed(3)} />
            <Stat label="Above Threshold" value={dist.aboveThreshold} tone="text-emerald-400" />
            <Stat label="Below Threshold" value={dist.belowThreshold} tone="text-amber-400" />
          </div>
          {/* Histogram */}
          <div className="rounded-lg border border-border/40 bg-muted/10 p-4">
            <div className="flex items-end gap-1 h-28">
              {dist.buckets.map((bucket, i) => {
                const pct = (bucket.count / maxCount) * 100;
                const isBelow = i < 4;
                return (
                  <Tooltip key={bucket.range}>
                    <TooltipTrigger asChild>
                      <div className={cn("flex-1 rounded-t transition-all duration-500 min-w-[6px] cursor-help",
                        isBelow ? "bg-amber-500/50 hover:bg-amber-500/70" : "bg-cyan-500/50 hover:bg-cyan-500/70")}
                        style={{ height: `${Math.max(pct, 4)}%` }} />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs">{bucket.range}: {bucket.count} bets</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground mt-2 px-1">
              <span>0.0</span>
              <span className="text-amber-400">← below threshold | above threshold →</span>
              <span>1.0</span>
            </div>
          </div>
        </>
      ) : (
        <div className="text-sm text-muted-foreground rounded-lg border border-border/40 bg-muted/10 px-4 py-3">
          No scores yet. Deploy a model and wait for bets to be scored.
        </div>
      )}
    </section>
  );
}

// ── History Section ───────────────────────────────────────────────────

export function HistorySection() {
  const { data: md, isLoading } = useModels();
  const models = md?.models ?? [];

  return (
    <section>
      <div className="mb-3">
        <h3 className="text-base font-semibold text-foreground">Training History</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          {models.length} model{models.length !== 1 ? "s" : ""} total. Models passing quality gates (DSR &gt; 0.8, PBO &lt; 0.5) are auto-deployed.
        </p>
      </div>
      {isLoading ? (
        <div className="space-y-2 py-6">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-10 bg-muted/15 rounded-lg animate-pulse" style={{ animationDelay: `${i * 80}ms` }} />
          ))}
        </div>
      ) : models.length === 0 ? (
        <div className="text-sm text-muted-foreground rounded-lg border border-border/40 bg-muted/10 px-4 py-3">
          No training runs yet. Collect enough data, then click <strong>Retrain Model</strong>.
        </div>
      ) : (
        <DataTable columns={columns} data={models} getRowId={(r) => r.id} enableSorting enableColumnResizing density="compact" persistenceKey="ml-training-history" />
      )}
    </section>
  );
}
