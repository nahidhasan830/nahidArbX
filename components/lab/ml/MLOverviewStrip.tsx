"use client";

import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Brain,
  CheckCircle2,
  Database,
  Loader2,
  Minus,
  ShieldCheck,
} from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Sparkline } from "@/components/ui/sparkline";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { EvaluatedRung } from "@/lib/lab/ml/rungs";
import type { PipelineData } from "./types";

interface Props {
  data: PipelineData;
  rungs: EvaluatedRung[];
}

type Tone = "good" | "warn" | "bad" | "info" | "neutral";

const TONE_BORDER: Record<Tone, string> = {
  good: "border-emerald-500/25",
  warn: "border-amber-500/30",
  bad: "border-rose-500/30",
  info: "border-cyan-500/25",
  neutral: "border-border/60",
};

const TONE_ICON: Record<Tone, string> = {
  good: "text-emerald-500 bg-emerald-500/10",
  warn: "text-amber-500 bg-amber-500/10",
  bad: "text-rose-500 bg-rose-500/10",
  info: "text-cyan-500 bg-cyan-500/10",
  neutral: "text-muted-foreground bg-muted/40",
};

const TONE_PRIMARY: Record<Tone, string> = {
  good: "text-foreground",
  warn: "text-amber-200",
  bad: "text-rose-200",
  info: "text-cyan-200",
  neutral: "text-foreground",
};

const TONE_BADGE: Record<Tone, string> = {
  good: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  warn: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  bad: "bg-rose-500/15 text-rose-400 border-rose-500/30",
  info: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
  neutral: "bg-muted/60 text-muted-foreground border-border/60",
};

const SPARKLINE_COLOR: Record<Tone, string> = {
  good: "hsl(160, 84%, 50%)",
  warn: "hsl(38, 92%, 60%)",
  bad: "hsl(346, 84%, 60%)",
  info: "hsl(190, 90%, 55%)",
  neutral: "hsl(220, 9%, 60%)",
};

/**
 * Top-of-page summary strip. Four scannable KPI cards with sparklines,
 * explicit status text, and trend deltas — the at-a-glance row that
 * answers the operator's first questions before they scan further.
 */
export function MLOverviewStrip({ data, rungs }: Props) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <DeployedModelCard data={data} />
      <CorpusCard data={data} />
      <PipelineHealthCard rungs={rungs} />
      <ModelQualityCard data={data} />
    </div>
  );
}

function DeployedModelCard({ data }: { data: PipelineData }) {
  const deployed = data.training.deployedModel as
    | {
        version: number;
        trainingSamples: number;
        permissionLevel: string | null;
      }
    | null;
  const inTraining = data.training.modelsInTraining > 0;
  const totalModels = data.training.totalModels;

  // Build mini sparkline of historical training sample counts per model
  // so operators can see the corpus has been growing across versions.
  const history = (data.modelHistory ?? [])
    .filter((m) => m.version > 0 && m.trainingSamples > 0)
    .slice(0, 12)
    .reverse();
  const spark = history.map<[number, number]>((m, i) => [
    i,
    m.trainingSamples,
  ]);

  if (deployed) {
    return (
      <KpiCard
        icon={<Brain className="size-4" />}
        label="Deployed Model"
        statusText="Deployed"
        primary={`v${deployed.version}`}
        secondary={`${deployed.permissionLevel ?? "observe"} permission · ${deployed.trainingSamples.toLocaleString()} samples`}
        tone="good"
        sparkline={spark.length >= 2 ? spark : undefined}
        sparklineLabel={`Training samples across ${spark.length} models`}
        meta={totalModels > 1 ? `${totalModels} total trained` : undefined}
      />
    );
  }

  return (
    <KpiCard
      icon={<Brain className="size-4" />}
      label="Deployed Model"
      statusText={inTraining ? "Training" : "None"}
      primary="—"
      secondary={
        inTraining
          ? "A candidate is being trained. First deploy is pending."
          : "No model has cleared the deployment gate yet."
      }
      tone={inTraining ? "info" : "neutral"}
    />
  );
}

function CorpusCard({ data }: { data: PipelineData }) {
  const corpus = data.dataCollection.qualifiedForTraining;
  const coldStart = data.dataCollection.coldStartThreshold;
  const newSinceTrain = data.training.newDataSinceLastTrain;
  const retrainStep = data.training.retrainStep;
  const deployed = data.training.deployedModel != null;

  // Sparkline from daily history (cumulative current-contract features over time).
  const daily =
    data.dataCollection.currentCorpus?.dailyHistory ??
    data.dataCollection.currentCorpus?.dailyTrend ??
    [];
  const spark: [number, number][] = daily
    .slice(-30)
    .map((d, i) => [i, d.currentContractFeatures]);

  // Compute a simple delta from first to last point for trend chip.
  const delta =
    spark.length >= 2 ? spark[spark.length - 1][1] - spark[0][1] : 0;
  const trendDirection = delta > 0 ? "up" : delta < 0 ? "down" : "flat";

  if (!deployed) {
    const pct = coldStart > 0 ? (corpus / coldStart) * 100 : 0;
    const hit = corpus >= coldStart;
    return (
      <KpiCard
        icon={<Database className="size-4" />}
        label="Training Corpus"
        statusText={hit ? "Cold-start ready" : "Pre cold-start"}
        primary={corpus.toLocaleString()}
        secondary={
          hit
            ? `${(corpus / coldStart).toFixed(1)}× past cold-start (${coldStart.toLocaleString()}).`
            : `Need ${(coldStart - corpus).toLocaleString()} more for cold-start.`
        }
        tone={hit ? "good" : "warn"}
        progress={{
          value: Math.min(100, pct),
          label: `${Math.min(100, Math.round(pct))}% to cold-start`,
        }}
        sparkline={spark.length >= 2 ? spark : undefined}
        sparklineLabel={`Corpus growth, last ${spark.length} days`}
        trend={
          spark.length >= 2
            ? {
                direction: trendDirection,
                label: `+${delta.toLocaleString()} examples`,
              }
            : undefined
        }
      />
    );
  }

  const pct = retrainStep > 0 ? (newSinceTrain / retrainStep) * 100 : 0;
  const ready = newSinceTrain >= retrainStep;
  return (
    <KpiCard
      icon={<Database className="size-4" />}
      label="Training Corpus"
      statusText={ready ? "Retrain ready" : "Growing"}
      primary={corpus.toLocaleString()}
      secondary={
        ready
          ? `${newSinceTrain.toLocaleString()} new since deploy — auto-retrain queued.`
          : `${newSinceTrain.toLocaleString()} new · auto-retrains at +${retrainStep.toLocaleString()}.`
      }
      tone={ready ? "info" : "good"}
      progress={{
        value: Math.min(100, pct),
        label: ready
          ? "ready"
          : `${Math.min(100, Math.round(pct))}% to next retrain`,
      }}
      sparkline={spark.length >= 2 ? spark : undefined}
      sparklineLabel={`Corpus growth, last ${spark.length} days`}
      trend={
        spark.length >= 2
          ? {
              direction: trendDirection,
              label: `+${delta.toLocaleString()} examples`,
            }
          : undefined
      }
    />
  );
}

function PipelineHealthCard({ rungs }: { rungs: EvaluatedRung[] }) {
  const passing = rungs.filter((r) => r.verdict.status === "pass").length;
  const failing = rungs.filter((r) => r.verdict.status === "fail").length;
  const warn = rungs.filter((r) => r.verdict.status === "warn").length;
  const blocked = rungs.filter((r) => r.verdict.status === "blocked").length;
  const total = rungs.length;
  const pct = total > 0 ? (passing / total) * 100 : 0;

  let tone: Tone = "good";
  let secondary = "All non-blocked gates are passing.";
  let statusText = "All clear";
  if (failing > 0) {
    tone = "bad";
    statusText = `${failing} failing`;
    secondary = `${failing} gate${failing !== 1 ? "s" : ""} failing — see ladder below.`;
  } else if (warn > 0) {
    tone = "warn";
    statusText = `${warn} warning${warn !== 1 ? "s" : ""}`;
    secondary = `${warn} gate${warn !== 1 ? "s" : ""} need attention.`;
  } else if (blocked > 0 && passing < total - blocked) {
    tone = "warn";
    statusText = "Partially blocked";
    secondary = `${blocked} gate${blocked !== 1 ? "s" : ""} blocked by upstream issues.`;
  }

  return (
    <KpiCard
      icon={
        failing > 0 ? (
          <AlertTriangle className="size-4" />
        ) : (
          <ShieldCheck className="size-4" />
        )
      }
      label="Pipeline Health"
      statusText={statusText}
      primary={`${passing} / ${total}`}
      secondary={secondary}
      tone={tone}
      progress={{
        value: pct,
        label: `${Math.round(pct)}% passing`,
      }}
      meta={blocked > 0 ? `${blocked} blocked` : undefined}
    />
  );
}

function ModelQualityCard({ data }: { data: PipelineData }) {
  const inTraining = data.training.modelsInTraining > 0;
  const deployed = (data.modelHistory ?? []).find(
    (m) => m.status === "deployed",
  );

  // Sparkline of AUC across model versions (most-recent last)
  const aucHistory = (data.modelHistory ?? [])
    .filter((m) => m.oosAucRoc != null && m.version > 0)
    .slice(0, 10)
    .reverse();
  const spark = aucHistory.map<[number, number]>((m, i) => [
    i,
    m.oosAucRoc as number,
  ]);

  if (inTraining && !deployed) {
    return (
      <KpiCard
        icon={<Loader2 className="size-4 animate-spin" />}
        label="Model Quality"
        statusText="Training"
        primary="—"
        secondary="A candidate model is being trained right now."
        tone="info"
      />
    );
  }

  if (!deployed) {
    return (
      <KpiCard
        icon={<Activity className="size-4" />}
        label="Model Quality"
        statusText="No deployment"
        primary="—"
        secondary="No deployed model — quality is not yet measurable."
        tone="neutral"
      />
    );
  }

  const auc = deployed.oosAucRoc;
  const dsr = deployed.deflatedSharpe;
  const aucStr = auc != null ? auc.toFixed(3) : "—";
  const dsrStr = dsr != null ? dsr.toFixed(2) : "—";

  // AUC > 0.55 is healthy; 0.5-0.55 is marginal; <0.5 means inverted.
  const tone: Tone =
    auc != null && auc >= 0.55 ? "good" : auc != null && auc >= 0.5 ? "warn" : "bad";
  const statusText =
    auc != null && auc >= 0.55
      ? "Healthy"
      : auc != null && auc >= 0.5
        ? "Marginal"
        : "Below baseline";

  // Trend across the last few model versions
  const delta = spark.length >= 2 ? spark[spark.length - 1][1] - spark[0][1] : 0;
  const trendDirection = delta > 0.001 ? "up" : delta < -0.001 ? "down" : "flat";

  return (
    <KpiCard
      icon={<Activity className="size-4" />}
      label="Model Quality"
      statusText={statusText}
      primary={aucStr}
      secondary={
        <span>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-help underline decoration-dotted underline-offset-2">
                AUC
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px] text-xs">
              Out-of-sample AUC. &gt; 0.5 means the model separates winners from losers.
            </TooltipContent>
          </Tooltip>
          {" · "}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-help underline decoration-dotted underline-offset-2">
                DSR
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px] text-xs">
              Deflated Sharpe Ratio. Confidence the out-of-sample edge is real, not noise.
            </TooltipContent>
          </Tooltip>
          {` ${dsrStr}`}
        </span>
      }
      tone={tone}
      sparkline={spark.length >= 2 ? spark : undefined}
      sparklineLabel={`AUC across ${spark.length} model versions`}
      trend={
        spark.length >= 2
          ? {
              direction: trendDirection,
              label: `${delta >= 0 ? "+" : ""}${delta.toFixed(3)}`,
            }
          : undefined
      }
    />
  );
}

interface KpiCardProps {
  icon: React.ReactNode;
  label: string;
  statusText: string;
  primary: string;
  secondary: React.ReactNode;
  tone: Tone;
  progress?: { value: number; label: string };
  sparkline?: [number, number][];
  sparklineLabel?: string;
  trend?: { direction: "up" | "down" | "flat"; label: string };
  meta?: string;
}

function KpiCard({
  icon,
  label,
  statusText,
  primary,
  secondary,
  tone,
  progress,
  sparkline,
  sparklineLabel,
  trend,
  meta,
}: KpiCardProps) {
  const TrendIcon =
    trend?.direction === "up"
      ? ArrowUpRight
      : trend?.direction === "down"
        ? ArrowDownRight
        : Minus;

  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border bg-card/60 p-4 backdrop-blur-sm transition-all hover:bg-card/80 hover:shadow-md",
        TONE_BORDER[tone],
      )}
    >
      {/* Header row */}
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "flex size-7 items-center justify-center rounded-lg",
            TONE_ICON[tone],
          )}
        >
          {icon}
        </div>
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span
          className={cn(
            "ml-auto rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
            TONE_BADGE[tone],
          )}
        >
          {statusText}
        </span>
      </div>

      {/* Primary value + sparkline */}
      <div className="mt-3 flex items-end justify-between gap-2">
        <p
          className={cn(
            "font-mono text-2xl font-semibold tabular-nums leading-none",
            TONE_PRIMARY[tone],
          )}
        >
          {primary}
        </p>
        {sparkline && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0 cursor-help" aria-label={sparklineLabel}>
                <Sparkline
                  data={sparkline}
                  width={68}
                  height={22}
                  color={SPARKLINE_COLOR[tone]}
                />
              </span>
            </TooltipTrigger>
            {sparklineLabel && (
              <TooltipContent className="text-xs">{sparklineLabel}</TooltipContent>
            )}
          </Tooltip>
        )}
      </div>

      {/* Trend chip */}
      {trend && (
        <div className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
          <TrendIcon className="size-3" />
          <span className="font-mono tabular-nums">{trend.label}</span>
          {meta && <span className="ml-auto text-muted-foreground/80">{meta}</span>}
        </div>
      )}
      {!trend && meta && (
        <p className="mt-1.5 text-[11px] text-muted-foreground/80">{meta}</p>
      )}

      {/* Secondary description */}
      <div className="mt-2 text-[12px] leading-relaxed text-muted-foreground line-clamp-2 min-h-[2.6em]">
        {secondary}
      </div>

      {/* Progress (if any) */}
      {progress && (
        <div className="mt-3 space-y-1">
          <Progress value={progress.value} className="h-1.5" />
          <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            {progress.label}
          </p>
        </div>
      )}

      {/* Trailing checkmark for clean cards */}
      {tone === "good" && !progress && !trend && (
        <div className="mt-auto pt-3">
          <CheckCircle2 className="size-4 text-emerald-500/70" aria-hidden />
        </div>
      )}
    </div>
  );
}
