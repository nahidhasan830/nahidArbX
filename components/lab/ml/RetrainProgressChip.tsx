"use client";

/**
 * RetrainProgressChip — minimal status dot for auto-retrain.
 */

import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type Tone = "info" | "warn" | "good";

const TONE: Record<Tone, { border: string; bg: string; text: string; fill: string }> = {
  info: {
    border: "border-cyan-500/30",
    bg: "bg-cyan-500/10",
    text: "text-cyan-300",
    fill: "bg-cyan-400",
  },
  warn: {
    border: "border-amber-500/30",
    bg: "bg-amber-500/10",
    text: "text-amber-300",
    fill: "bg-amber-400",
  },
  good: {
    border: "border-emerald-500/30",
    bg: "bg-emerald-500/10",
    text: "text-emerald-300",
    fill: "bg-emerald-400",
  },
};

interface Props {
  examplesSince: number;
  retrainStep: number;
  isTraining: boolean;
  hasDeployedModel: boolean;
  size?: "compact" | "header";
}

export function RetrainProgressChip({
  examplesSince,
  retrainStep,
  isTraining,
  hasDeployedModel,
  size = "compact",
}: Props) {
  const safeStep = Math.max(1, retrainStep);
  const clampedSince = Math.max(0, Math.min(examplesSince, safeStep));
  const progressPct = Math.min(100, Math.round((clampedSince / safeStep) * 100));
  const ready = examplesSince >= safeStep;

  const state: "accumulating" | "queued" | "training" = isTraining
    ? "training"
    : ready
      ? "queued"
      : "accumulating";

  const tone: Tone =
    state === "training"
      ? "info"
      : state === "queued"
        ? "good"
        : progressPct >= 80
          ? "warn"
          : "info";

  const label = state === "training" ? "Building" : state === "queued" ? "Queued" : "";
  const help =
    state === "training"
      ? `A training run is in progress.`
      : state === "queued"
        ? `Auto-retrain queued — manual retrain stays available.`
        : `Auto-retrain fires after +${safeStep.toLocaleString()} new examples.`;

  const isHeader = size === "header";
  const pulse = state === "training" || state === "queued";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex rounded-full cursor-help",
            isHeader ? "p-1.5" : "p-1",
            TONE[tone].bg,
          )}
          aria-label={label || help}
        >
          <span
            className={cn(
              "block size-1.5 rounded-full",
              TONE[tone].fill,
              pulse && "animate-pulse",
            )}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-sm leading-relaxed">
        {help}
      </TooltipContent>
    </Tooltip>
  );
}