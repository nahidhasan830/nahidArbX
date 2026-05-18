"use client";

/**
 * OverviewTab — consolidated ML optimizer operating surface.
 */

import {
  AlertTriangle,
  BarChart3,
  BrainCircuit,
  CircleGauge,
  Database,
  LineChart,
  ShieldCheck,
  SlidersHorizontal,
  TrendingUp,
} from "lucide-react";
import type { MLTrainingState } from "@/components/hooks/useMLTrainingStream";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RetrainButton } from "../MLModelStatus";
import { ModelHistoryTable } from "../ModelHistoryTable";
import { RetrainProgressChip } from "../RetrainProgressChip";
import { TrainingDataTable } from "../TrainingDataTable";
import { LiveTrainingPanel } from "../panels/LiveTrainingPanel";
import type { PipelineData } from "../types";
import { cn } from "@/lib/utils";

type Tone = "good" | "warn" | "bad" | "info" | "neutral";

const TONE = {
  good: {
    border: "border-emerald-500/30",
    bg: "bg-emerald-500/10",
    text: "text-emerald-300",
    dot: "bg-emerald-400",
  },
  warn: {
    border: "border-amber-500/30",
    bg: "bg-amber-500/10",
    text: "text-amber-300",
    dot: "bg-amber-400",
  },
  bad: {
    border: "border-rose-500/30",
    bg: "bg-rose-500/10",
    text: "text-rose-300",
    dot: "bg-rose-400",
  },
  info: {
    border: "border-cyan-500/30",
    bg: "bg-cyan-500/10",
    text: "text-cyan-300",
    dot: "bg-cyan-400",
  },
  neutral: {
    border: "border-white/[0.08]",
    bg: "bg-white/[0.025]",
    text: "text-white/45",
    dot: "bg-white/35",
  },
} satisfies Record<Tone, Record<string, string>>;

const COHORT_TERM_BY_LABEL: Record<string, string> = {
  "Detection Baseline": "Detected",
  "Simple EV Rule": "Rule",
  "Model Scored": "Scored",
  "Model Gate": "Gate",
};

export function OverviewTab({
  data,
  trainingStream,
}: {
  data: PipelineData;
  trainingStream: MLTrainingState;
}) {
  const isTraining =
    trainingStream.isTraining || data.training.modelsInTraining > 0;
  const coldReady =
    data.dataCollection.qualifiedForTraining >=
    data.dataCollection.coldStartThreshold;
  const trainingDisabledReason = !coldReady
    ? `${Math.max(
        0,
        data.dataCollection.coldStartThreshold -
          data.dataCollection.qualifiedForTraining,
      )} more settled examples needed before training can start.`
    : undefined;

  return (
    <div className="min-h-full bg-[oklch(0.06_0.012_245)]">
      <div className="mx-auto flex max-w-[1800px] flex-col gap-3 p-3 md:p-4">
        <ReadinessWorkspace
          data={data}
          trainingStream={trainingStream}
          isTraining={isTraining}
          trainingDisabledReason={trainingDisabledReason}
        />

        {trainingStream.currentTraining && (
          <LiveTrainingPanel
            training={trainingStream.currentTraining}
            log={trainingStream.trainingLog}
            isConnected={trainingStream.isConnected}
            dataCount={data.dataCollection.qualifiedForTraining}
          />
        )}

        <EvidenceWorkspace data={data} />

        <section className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2">
          <ModelHistoryTable models={data.modelHistory ?? []} />
        </section>

        <section className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2">
          <TrainingDataTable />
        </section>
      </div>
    </div>
  );
}

function ReadinessWorkspace({
  data,
  trainingStream,
  isTraining,
  trainingDisabledReason,
}: {
  data: PipelineData;
  trainingStream: MLTrainingState;
  isTraining: boolean;
  trainingDisabledReason: string | undefined;
}) {
  const operating = getOperatingState(data, trainingStream);
  const s = data.featureContract.semanticChecks;
  const featureHealthy =
    data.featureContract.allVersionsMatch &&
    data.featureContract.allLengthsMatch &&
    data.featureContract.allSemanticChecksPass;
  const hasModel = data.inference.modelLoaded;
  const permission = data.deploymentGate.permissionLevel.replaceAll("_", " ");

  const statusRows = [
    {
      label: "Training corpus",
      value: data.dataCollection.qualifiedForTraining.toLocaleString(),
      detail: `${data.dataCollection.coldStartThreshold.toLocaleString()} cold start target`,
      tone:
        data.dataCollection.qualifiedForTraining >=
        data.dataCollection.coldStartThreshold
          ? "good"
          : "warn",
      icon: Database,
    },
    {
      label: "Feature contract",
      value: featureHealthy ? "OK" : "Review",
      detail: `v${data.featureContract.currentVersion} · ${data.featureContract.currentFeatureCount} signals`,
      tone: featureHealthy ? "good" : "warn",
      icon: SlidersHorizontal,
    },
    {
      label: "Live scorer",
      value: hasModel ? `v${data.inference.modelVersion}` : "Not loaded",
      detail: hasModel
        ? `${data.inference.avgInferenceMs.toFixed(1)}ms avg · ${permission}`
        : "Existing rules pass through",
      tone: hasModel ? "good" : "neutral",
      icon: CircleGauge,
    },
    {
      label: "Deployment gate",
      value: data.deploymentGate.canGate ? "Can gate" : "Observe",
      detail: data.scoringMode,
      tone: data.deploymentGate.canGate ? "good" : "info",
      icon: ShieldCheck,
    },
  ] as const;

  return (
    <section className="rounded-lg border border-white/[0.07] bg-white/[0.025] p-3 shadow-[0_18px_80px_-60px_rgba(0,0,0,0.9)]">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.55fr)]">
        <div className="min-w-0">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill
                  label={operating.label}
                  tone={operating.tone}
                  pulse={operating.pulse}
                />
                <span className="text-[11px] text-white/35">
                  {data.scheduler.active ? "scheduler active" : "scheduler idle"}
                </span>
                {data.scheduler.lastError && (
                  <StatusPill label="Scheduler error" tone="bad" />
                )}
              </div>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-white md:text-2xl">
                {operating.title}
              </h2>
              <p className="mt-1 max-w-2xl text-sm leading-5 text-white/55">
                {operating.detail}
              </p>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <RetrainButton
                size="sm"
                hasExistingModel={data.training.totalModels > 0}
                disabledReason={trainingDisabledReason}
                isTraining={isTraining}
                trainingVersion={
                  trainingStream.currentTraining?.version ??
                  data.training.activeTraining?.version
                }
              />
            </div>
          </div>

          <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
            {statusRows.map((row) => (
              <StatusMetric key={row.label} {...row} />
            ))}
          </div>

          <div className="mt-3 grid gap-2 md:grid-cols-3">
            <CompactMetric
              label="Clean labels"
              value={s.cleanLabeledExamples.toLocaleString()}
              help="Labeled rows with current feature shape and allowed competition tiers."
              tone="good"
            />
            <CompactMetric
              label="Stale EV rows"
              value={s.badLabeledNonPositiveEv.toLocaleString()}
              help="Labeled rows with non-positive stored EV. They are excluded from training."
              tone={s.badLabeledNonPositiveEv > 0 ? "warn" : "good"}
            />
            <CompactMetric
              label="Rejected runs"
              value={data.rejectedModels.length.toLocaleString()}
              help="Recent models rejected or failed by validation gates."
              tone={data.rejectedModels.length > 0 ? "warn" : "neutral"}
            />
          </div>
        </div>

        <RetrainPanel data={data} isTraining={isTraining} />
      </div>

      {data.rejectedModels.length > 0 && (
        <div className="mt-3 border-t border-white/[0.06] pt-3">
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="size-3.5 text-amber-300" />
            <h3 className="text-xs font-semibold text-white/75">
              Recent validation blocks
            </h3>
          </div>
          <div className="mt-2 grid gap-2 lg:grid-cols-3">
            {data.rejectedModels.slice(0, 3).map((m) => (
              <div
                key={`${m.version}-${m.createdAt ?? ""}`}
                className="min-w-0 rounded-md border border-white/[0.06] bg-black/15 px-2.5 py-2"
              >
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="font-mono font-semibold text-white/70">
                    v{m.version}
                  </span>
                  <span className="text-white/30">{m.status}</span>
                </div>
                <p className="mt-1 truncate text-[11px] text-white/45">
                  {m.reasons[0] ?? m.progressMessage ?? "No reason stored"}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function RetrainPanel({
  data,
  isTraining,
}: {
  data: PipelineData;
  isTraining: boolean;
}) {
  const step = Math.max(1, data.training.retrainStep);
  const since = Math.max(0, data.training.newDataSinceLastTrain);
  const progress = Math.min(100, Math.round((Math.min(since, step) / step) * 100));
  const remaining = Math.max(0, data.training.examplesUntilRetrain);
  const hasModel = Boolean(data.training.deployedModel);

  return (
    <aside className="rounded-lg border border-white/[0.06] bg-black/15 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5">
            <BrainCircuit className="size-3.5 text-cyan-300" />
            <h3 className="text-xs font-semibold text-white/75">
              Auto retraining
            </h3>
          </div>
          <p className="mt-1 text-[11px] leading-4 text-white/42">
            Fires after +{step.toLocaleString()} new qualified examples.
          </p>
        </div>
        <RetrainProgressChip
          examplesSince={data.training.newDataSinceLastTrain}
          retrainStep={data.training.retrainStep}
          isTraining={isTraining}
          hasDeployedModel={hasModel}
        />
      </div>

      <div className="mt-5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-3xl font-semibold tabular-nums tracking-tight text-white">
            {isTraining
              ? "Building"
              : remaining === 0
                ? "Ready"
                : remaining.toLocaleString()}
          </span>
          {!isTraining && remaining > 0 && (
            <span className="text-[11px] text-white/35">examples left</span>
          )}
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-500",
              isTraining
                ? "bg-cyan-400"
                : remaining === 0
                  ? "bg-emerald-400"
                  : progress >= 80
                    ? "bg-amber-400"
                    : "bg-cyan-400",
            )}
            style={{ width: `${isTraining ? 100 : progress}%` }}
          />
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px] text-white/35">
          <span>{Math.min(since, step).toLocaleString()} accumulated</span>
          <span>{step.toLocaleString()} trigger</span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <MiniReadout
          label="Triggers"
          value={data.scheduler.totalRetrainTriggers.toLocaleString()}
        />
        <MiniReadout
          label="Last tick"
          value={
            data.scheduler.lastTickAt
              ? new Date(data.scheduler.lastTickAt).toLocaleTimeString()
              : "—"
          }
        />
      </div>
    </aside>
  );
}

function EvidenceWorkspace({ data }: { data: PipelineData }) {
  return (
    <section className="rounded-lg border border-white/[0.07] bg-white/[0.02] p-3">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.65fr)]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <BarChart3 className="size-3.5 text-cyan-300" />
              <h2 className="text-xs font-semibold text-white/75">
                Paper evidence
              </h2>
            </div>
            <LiftPill value={data.paperEvaluation.verdict.mlMinusSimpleRoiPct} />
          </div>
          <PaperCohorts data={data} />
          <PaperTrend data={data} />
        </div>

        <ScoreBuckets data={data} />
      </div>
    </section>
  );
}

function PaperCohorts({ data }: { data: PipelineData }) {
  const { metrics } = data.paperEvaluation;
  const cohorts = [
    metrics.detectedBaseline,
    metrics.simpleEvCore,
    metrics.mlScored,
    metrics.mlGate,
  ];

  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {cohorts.map((m) => (
        <Tooltip key={m.label}>
          <TooltipTrigger asChild>
            <div className="rounded-md border border-white/[0.055] bg-black/10 px-2.5 py-2 transition-colors duration-200 hover:border-white/[0.1] hover:bg-white/[0.025]">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-[10px] font-semibold uppercase tracking-wide text-white/35">
                  {COHORT_TERM_BY_LABEL[m.label] ?? m.label}
                </p>
                <span className="text-[10px] tabular-nums text-white/30">
                  N {m.sampleSize.toLocaleString()}
                </span>
              </div>
              <p
                className={cn(
                  "mt-1 text-xl font-semibold tabular-nums",
                  roiColor(m.roiPct),
                )}
              >
                {fmtPct(m.roiPct)}
              </p>
              <p className="mt-0.5 text-[11px] text-white/35">
                Win {m.winRatePct != null ? `${m.winRatePct.toFixed(0)}%` : "—"}
              </p>
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-sm">
            {m.label}: ROI on settled, clean examples. Avg EV{" "}
            {fmtPct(m.avgEvPct)} · odds {m.avgOdds?.toFixed(2) ?? "—"}.
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

function PaperTrend({ data }: { data: PipelineData }) {
  const trend = data.paperEvaluation.trend.slice(-14);
  const values = trend
    .flatMap((row) => [row.simpleRoiPct, row.mlGateRoiPct])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const maxAbs = Math.max(5, ...values.map((v) => Math.abs(v)));

  return (
    <div className="mt-4 border-t border-white/[0.06] pt-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <LineChart className="size-3.5 text-cyan-300" />
          <h3 className="text-xs font-semibold text-white/70">14-day curve</h3>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-white/35">
          <Legend color="bg-cyan-400" label="Rule" />
          <Legend color="bg-emerald-400" label="ML gate" />
        </div>
      </div>
      {trend.length === 0 ? (
        <p className="py-6 text-center text-sm text-white/35">No trend yet.</p>
      ) : (
        <div className="flex min-w-0 gap-1 overflow-x-auto pb-1">
          {trend.map((row) => (
            <Tooltip key={row.day}>
              <TooltipTrigger asChild>
                <div className="flex w-9 shrink-0 cursor-default flex-col items-center gap-1">
                  <div className="relative h-16 w-full rounded border border-white/[0.045] bg-white/[0.018]">
                    <span className="absolute left-0 right-0 top-1/2 h-px bg-white/[0.06]" />
                    <RoiBar
                      value={row.simpleRoiPct}
                      maxAbs={maxAbs}
                      className="left-[29%] bg-cyan-400"
                    />
                    <RoiBar
                      value={row.mlGateRoiPct}
                      maxAbs={maxAbs}
                      className="left-[58%] bg-emerald-400"
                    />
                  </div>
                  <span className="font-mono text-[9px] text-white/25">
                    {row.day.slice(8)}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent className="space-y-0.5 text-xs">
                <p className="font-medium">{row.day}</p>
                <p className="text-cyan-300">
                  Rule {fmtPct(row.simpleRoiPct)} · N {row.simpleN}
                </p>
                <p className="text-emerald-300">
                  ML {fmtPct(row.mlGateRoiPct)} · N {row.mlGateN}
                </p>
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      )}
    </div>
  );
}

function ScoreBuckets({ data }: { data: PipelineData }) {
  const maxCount = Math.max(1, ...data.scoreBucketROI.map((b) => b.count));

  return (
    <aside className="min-w-0 rounded-lg border border-white/[0.06] bg-black/15 p-3">
      <div className="flex items-center gap-1.5">
        <TrendingUp className="size-3.5 text-cyan-300" />
        <h3 className="text-xs font-semibold text-white/75">
          Score buckets
        </h3>
      </div>
      <div className="mt-3 space-y-1">
        {data.scoreBucketROI.map((b) => (
          <Tooltip key={b.bucket}>
            <TooltipTrigger asChild>
              <div className="grid cursor-default grid-cols-[54px_minmax(0,1fr)_56px] items-center gap-2 rounded px-1 py-1 transition-colors duration-200 hover:bg-white/[0.03]">
                <span className="truncate font-mono text-[11px] text-white/40">
                  {b.bucket}
                </span>
                <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      b.avgPnl > 0 ? "bg-emerald-400" : "bg-rose-400",
                    )}
                    style={{
                      width: `${Math.max(3, (b.count / maxCount) * 100)}%`,
                    }}
                  />
                </div>
                <span
                  className={cn(
                    "text-right font-mono text-[11px] tabular-nums",
                    roiColor(b.avgPnl),
                  )}
                >
                  {b.count > 0 ? fmtPct(b.avgPnl) : "—"}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent className="text-xs">
              N {b.count} · Win {b.winRate.toFixed(1)}% · CLV{" "}
              {b.avgClv.toFixed(2)}%
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </aside>
  );
}

function StatusMetric({
  label,
  value,
  detail,
  tone,
  icon: Icon,
}: {
  label: string;
  value: string;
  detail: string;
  tone: Tone;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="min-w-0 rounded-md border border-white/[0.055] bg-black/10 px-2.5 py-2 transition-colors duration-200 hover:border-white/[0.1] hover:bg-white/[0.025]">
      <div className="flex items-center gap-1.5">
        <Icon className={cn("size-3.5", TONE[tone].text)} />
        <span className="truncate text-[10px] font-semibold uppercase tracking-wide text-white/35">
          {label}
        </span>
      </div>
      <p className={cn("mt-1 text-base font-semibold", TONE[tone].text)}>
        {value}
      </p>
      <p className="mt-0.5 truncate text-[11px] text-white/35">{detail}</p>
    </div>
  );
}

function CompactMetric({
  label,
  value,
  help,
  tone,
}: {
  label: string;
  value: string;
  help: string;
  tone: Tone;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex cursor-help items-center justify-between gap-2 rounded-md border border-white/[0.045] bg-white/[0.015] px-2.5 py-2 transition-colors duration-200 hover:border-white/[0.09]">
          <span className="truncate text-[11px] text-white/42">{label}</span>
          <span className={cn("font-mono text-sm font-semibold", TONE[tone].text)}>
            {value}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-sm">{help}</TooltipContent>
    </Tooltip>
  );
}

function MiniReadout({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-white/[0.045] bg-white/[0.018] px-2 py-1.5">
      <p className="text-[10px] text-white/30">{label}</p>
      <p className="truncate font-mono text-[11px] text-white/65">{value}</p>
    </div>
  );
}

function LiftPill({ value }: { value: number | null }) {
  const tone: Tone = value == null ? "neutral" : value > 0 ? "good" : value < 0 ? "bad" : "neutral";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex cursor-help items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold tabular-nums",
            TONE[tone].border,
            TONE[tone].bg,
            TONE[tone].text,
          )}
        >
          {value != null ? `${value > 0 ? "+" : ""}${value.toFixed(2)} pts` : "—"}
          <span className="font-normal text-white/35">lift</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-sm">
        Model Gate ROI minus Simple EV Rule ROI on the same clean paper set.
      </TooltipContent>
    </Tooltip>
  );
}

function StatusPill({
  label,
  tone,
  pulse = false,
}: {
  label: string;
  tone: Tone;
  pulse?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        TONE[tone].border,
        TONE[tone].bg,
        TONE[tone].text,
      )}
    >
      <span
        className={cn("size-1.5 rounded-full", TONE[tone].dot, pulse && "animate-pulse")}
      />
      {label}
    </span>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-1.5 rounded-full", color)} />
      {label}
    </span>
  );
}

function RoiBar({
  value,
  maxAbs,
  className,
}: {
  value: number | null;
  maxAbs: number;
  className: string;
}) {
  if (value == null) return null;
  const height = Math.max(3, Math.min(46, (Math.abs(value) / maxAbs) * 46));
  return (
    <span
      className={cn(
        "absolute w-1 rounded-full",
        className,
        value < 0 && "bg-rose-400",
        value >= 0 ? "bottom-1/2" : "top-1/2",
      )}
      style={{ height: `${height}%` }}
    />
  );
}

function getOperatingState(data: PipelineData, trainingStream: MLTrainingState) {
  const isTraining = trainingStream.isTraining || data.training.modelsInTraining > 0;
  const coldReady =
    data.dataCollection.qualifiedForTraining >=
    data.dataCollection.coldStartThreshold;
  const staleExcluded = data.featureContract.semanticChecks.badLabeledNonPositiveEv > 0;
  const paper = data.paperEvaluation;

  if (isTraining) {
    return {
      label: "Training",
      title: "Candidate model building",
      detail: `Training on ${data.dataCollection.qualifiedForTraining.toLocaleString()} clean examples.`,
      tone: "info" as Tone,
      pulse: true,
    };
  }
  if (!coldReady) {
    return {
      label: "Collecting",
      title: "Below cold start threshold",
      detail: `${data.dataCollection.qualifiedForTraining.toLocaleString()} of ${data.dataCollection.coldStartThreshold.toLocaleString()} settled examples are ready.`,
      tone: "warn" as Tone,
      pulse: false,
    };
  }
  if (!data.inference.modelLoaded) {
    return {
      label: "Ready",
      title: "Corpus ready for training",
      detail: staleExcluded
        ? `${data.featureContract.semanticChecks.badLabeledNonPositiveEv.toLocaleString()} stale rows are excluded from the trainer.`
        : "Start a build when the current corpus is representative.",
      tone: "info" as Tone,
      pulse: false,
    };
  }
  if (data.training.readyToRetrain && data.training.newDataSinceLastTrain < 0) {
    return {
      label: "Retrain",
      title: "Live model trained on stale rows",
      detail: `${Math.abs(data.training.newDataSinceLastTrain).toLocaleString()} stale examples were removed after the deployed build.`,
      tone: "warn" as Tone,
      pulse: false,
    };
  }
  if (!paper.verdict.enoughMlGateSamples) {
    return {
      label: "Observe",
      title: "Paper evidence still thin",
      detail: `${paper.metrics.mlGate.sampleSize.toLocaleString()} model-gate samples. Keep permissions conservative.`,
      tone: "info" as Tone,
      pulse: false,
    };
  }
  if (paper.verdict.mlBeatsSimpleRule) {
    return {
      label: "Ahead",
      title: "Model ahead on paper evidence",
      detail: `Model Gate is ${paper.verdict.mlMinusSimpleRoiPct?.toFixed(2) ?? "0.00"} points ahead of the simple EV rule.`,
      tone: "good" as Tone,
      pulse: false,
    };
  }
  return {
    label: "Review",
    title: "Simple rule still ahead",
    detail: `Model trails by ${Math.abs(paper.verdict.mlMinusSimpleRoiPct ?? 0).toFixed(2)} points. Keep model authority limited.`,
    tone: "warn" as Tone,
    pulse: false,
  };
}

function roiColor(value: number | null): string {
  if (value == null) return "text-white/30";
  if (value > 0) return "text-emerald-300";
  if (value < 0) return "text-rose-300";
  return "text-white/45";
}

function fmtPct(value: number | null): string {
  return value == null ? "—" : `${value.toFixed(1)}%`;
}
