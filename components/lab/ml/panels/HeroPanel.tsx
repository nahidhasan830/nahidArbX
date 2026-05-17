"use client";

/**
 * HeroPanel — Compact single-line operating-state bar with inline metrics.
 * No large heading — just a status pill, short message, and 4 metric chips.
 */

import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { MLTrainingState } from "@/components/hooks/useMLTrainingStream";
import type { PipelineData } from "../types";

type Tone = "good" | "warn" | "bad" | "info" | "neutral";

const TONE = {
  good: { text: "text-emerald-400", border: "border-emerald-500/30", bg: "bg-emerald-500/10", dot: "bg-emerald-400" },
  warn: { text: "text-amber-400", border: "border-amber-500/30", bg: "bg-amber-500/10", dot: "bg-amber-400" },
  bad: { text: "text-rose-400", border: "border-rose-500/30", bg: "bg-rose-500/10", dot: "bg-rose-400" },
  info: { text: "text-cyan-400", border: "border-cyan-500/30", bg: "bg-cyan-500/10", dot: "bg-cyan-400" },
  neutral: { text: "text-muted-foreground", border: "border-border", bg: "bg-muted/30", dot: "bg-muted-foreground" },
} satisfies Record<Tone, Record<string, string>>;

export function HeroPanel({
  data,
  trainingStream,
}: {
  data: PipelineData;
  trainingStream: MLTrainingState;
}) {
  const operating = getOperatingState(data, trainingStream);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
      {/* Status pill */}
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold shrink-0",
          TONE[operating.tone].border,
          TONE[operating.tone].bg,
          TONE[operating.tone].text,
        )}
      >
        <span className={cn("size-1.5 rounded-full", TONE[operating.tone].dot, operating.pulse && "animate-pulse")} />
        {operating.label}
      </span>

      {/* Compact message */}
      <span className="text-xs text-white/60 min-w-0 truncate">
        {operating.title}
      </span>

      <span className="text-[11px] text-white/30 shrink-0">
        v{data.inference.modelVersion ?? "—"} · {data.scoringMode}
      </span>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Inline metric chips */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <Chip
          label="Actionable"
          value={data.dataCollection.qualifiedForTraining.toLocaleString()}
          help="Canonical examples that pass the trainer's feature contract."
          tone={data.dataCollection.qualifiedForTraining >= data.dataCollection.coldStartThreshold ? "good" : "warn"}
        />
        {data.training.readyToRetrain && (
          <Chip
            label="Δ"
            value={`+${data.training.newDataSinceLastTrain.toLocaleString()}`}
            help={`Auto-retrains when the corpus grows ≥${data.scheduler.growthThresholdPct}% since the last deployed model — threshold met.`}
            tone="good"
          />
        )}
        {!data.training.readyToRetrain && data.inference.modelLoaded && (
          <Chip
            label="Δ"
            value={`${data.training.growthPct}%`}
            help={`Auto-retrains at ≥${data.scheduler.growthThresholdPct}% corpus growth since the last deployed model. Manual retrain stays available.`}
            tone="warn"
          />
        )}
        <Chip
          label="Auto-retrain"
          value={`≥${data.scheduler.growthThresholdPct}% growth`}
          help={`Auto-retraining fires whenever the canonical training corpus has grown by ≥${data.scheduler.growthThresholdPct}% since the last deployed model. There is no cadence or schedule — manual retrain is always available via the button on the right.`}
          tone="info"
        />
        <Chip
          label="Model Lift"
          value={formatSignedPts(data.paperEvaluation.verdict.mlMinusSimpleRoiPct)}
          help="Model Lift = Model Gate ROI − Simple EV Rule ROI on the same period (percentage points). Consistently positive ⇒ escalate the model's permission."
          tone={deltaTone(data.paperEvaluation.verdict.mlMinusSimpleRoiPct)}
        />
        <Chip
          label="Excluded"
          value={(data.featureContract.semanticChecks.badLabeledNonPositiveEv ?? 0).toLocaleString()}
          help="Labeled rows with non-positive stored EV. Excluded from trainer."
          tone={data.featureContract.semanticChecks.badLabeledNonPositiveEv > 0 ? "warn" : "good"}
        />
        <Chip
          label="Scored"
          value={data.inference.totalScored.toLocaleString()}
          help="Bets scored by the engine-side ONNX scorer since load."
          tone={data.inference.modelLoaded ? "info" : "neutral"}
        />
      </div>
    </div>
  );
}

function Chip({ label, value, help, tone = "neutral" }: { label: string; value: string; help: string; tone?: Tone }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn(
          "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] cursor-help shrink-0",
          TONE[tone].border, TONE[tone].bg,
        )}>
          <span className="text-white/40 font-medium">{label}</span>
          <span className={cn("font-bold tabular-nums", TONE[tone].text)}>{value}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-sm">{help}</TooltipContent>
    </Tooltip>
  );
}

// ── Operating state derivation ────────────────────────────────────────

export function getOperatingState(data: PipelineData, trainingStream: MLTrainingState) {
  const isTraining = trainingStream.isTraining || data.training.modelsInTraining > 0;
  const coldReady = data.dataCollection.qualifiedForTraining >= data.dataCollection.coldStartThreshold;
  const staleExcluded = data.featureContract.semanticChecks.badLabeledNonPositiveEv > 0;
  const paper = data.paperEvaluation;

  if (isTraining) {
    return { label: "Training", title: "Candidate model building", detail: `Training on ${data.dataCollection.qualifiedForTraining.toLocaleString()} clean examples.`, tone: "info" as Tone, pulse: true };
  }
  if (!coldReady) {
    return { label: "Collecting", title: "Below cold start threshold", detail: `${data.dataCollection.qualifiedForTraining.toLocaleString()} of ${data.dataCollection.coldStartThreshold.toLocaleString()} needed.`, tone: "warn" as Tone, pulse: false };
  }
  if (!data.inference.modelLoaded) {
    return { label: "Ready", title: "Corpus ready for training", detail: staleExcluded ? `${(data.featureContract.semanticChecks.badLabeledNonPositiveEv ?? 0).toLocaleString()} stale rows excluded.` : "Start a fresh build.", tone: "info" as Tone, pulse: false };
  }
  if (data.training.readyToRetrain && data.training.newDataSinceLastTrain < 0) {
    return { label: "Retrain", title: "Live model trained on stale rows", detail: `${Math.abs(data.training.newDataSinceLastTrain).toLocaleString()} stale examples removed.`, tone: "warn" as Tone, pulse: false };
  }
  if (!paper.verdict.enoughMlGateSamples) {
    return { label: "Observe", title: "Paper evidence still thin", detail: `${paper.metrics.mlGate.sampleSize.toLocaleString()} model-gate samples.`, tone: "info" as Tone, pulse: false };
  }
  if (paper.verdict.mlBeatsSimpleRule) {
    return { label: "Ahead", title: "Model ahead on paper evidence", detail: `+${(paper.verdict.mlMinusSimpleRoiPct ?? 0).toFixed(2)} pts vs simple rule.`, tone: "good" as Tone, pulse: false };
  }
  return { label: "Review", title: "Simple rule still ahead", detail: `Model trails by ${Math.abs(paper.verdict.mlMinusSimpleRoiPct ?? 0).toFixed(2)} pts.`, tone: "warn" as Tone, pulse: false };
}

function deltaTone(value: number | null): Tone {
  if (value == null) return "neutral";
  if (value > 0) return "good";
  if (value < 0) return "bad";
  return "neutral";
}

function formatSignedPts(value: number | null): string {
  if (value == null) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
}
