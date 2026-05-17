"use client";

/**
 * PipelineRibbon — Horizontal 6-stage pipeline status with connecting lines.
 */

import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Database,
  Table2,
  BrainCircuit,
  ShieldCheck,
  CircleGauge,
  LineChart,
} from "lucide-react";
import type { StageStatus } from "../types";

type Tone = "good" | "warn" | "bad" | "info" | "neutral";

const TONE = {
  good: {
    text: "text-emerald-400",
    border: "border-emerald-500/30",
    bg: "bg-emerald-500/10",
    dot: "bg-emerald-400",
  },
  warn: {
    text: "text-amber-400",
    border: "border-amber-500/30",
    bg: "bg-amber-500/10",
    dot: "bg-amber-400",
  },
  bad: {
    text: "text-rose-400",
    border: "border-rose-500/30",
    bg: "bg-rose-500/10",
    dot: "bg-rose-400",
  },
  info: {
    text: "text-cyan-400",
    border: "border-cyan-500/30",
    bg: "bg-cyan-500/10",
    dot: "bg-cyan-400",
  },
  neutral: {
    text: "text-white/30",
    border: "border-white/[0.06]",
    bg: "bg-white/[0.03]",
    dot: "bg-white/30",
  },
} satisfies Record<Tone, Record<string, string>>;

const PIPELINE_STAGES = [
  {
    key: "capture",
    label: "Capture",
    icon: Database,
    help: "Live value bets are persisted with the feature vector used for ML.",
  },
  {
    key: "corpus",
    label: "Corpus",
    icon: Table2,
    help: "Settled examples are canonicalized to one strongest row per selection.",
  },
  {
    key: "train",
    label: "Train",
    icon: BrainCircuit,
    help: "The Cloud Run sidecar fits a candidate LightGBM model.",
  },
  {
    key: "gate",
    label: "Gate",
    icon: ShieldCheck,
    help: "Deployment gates reject weak, unstable, or poorly calibrated models.",
  },
  {
    key: "score",
    label: "Score",
    icon: CircleGauge,
    help: "The engine loads the approved ONNX model and scores fresh bets.",
  },
  {
    key: "paper",
    label: "Paper",
    icon: LineChart,
    help: "Paper evaluation compares model-gated bets with the simple EV rule.",
  },
] as const;

function toneForStage(status: StageStatus): Tone {
  if (status === "healthy") return "good";
  if (status === "warning") return "warn";
  if (status === "action") return "info";
  if (status === "progressing") return "info";
  return "neutral";
}

function stageStatusLabel(status: StageStatus): string {
  if (status === "healthy") return "ready";
  if (status === "warning") return "review";
  if (status === "action") return "action";
  if (status === "progressing") return "working";
  return "waiting";
}

export function PipelineRibbon({ statuses }: { statuses: StageStatus[] }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 backdrop-blur-sm">
      <div className="flex items-center gap-1 md:gap-0">
        {PIPELINE_STAGES.map((stage, index) => {
          const status = statuses[index] ?? "waiting";
          const tone = toneForStage(status);
          const Icon = stage.icon;
          const isLast = index === PIPELINE_STAGES.length - 1;
          return (
            <div
              key={stage.key}
              className={cn(
                "flex items-center",
                !isLast && "flex-1",
              )}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="group flex cursor-default items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 transition-all duration-300 hover:border-white/[0.12] hover:bg-white/[0.04]">
                    <span
                      className={cn(
                        "flex size-7 shrink-0 items-center justify-center rounded-md border transition-all duration-300",
                        TONE[tone].border,
                        TONE[tone].bg,
                        TONE[tone].text,
                      )}
                    >
                      <Icon className="size-4" />
                    </span>
                    <div className="hidden min-w-0 md:block">
                      <p className="truncate text-xs font-semibold text-white/90">
                        {stage.label}
                      </p>
                      <p
                        className={cn(
                          "truncate text-[10px] font-medium",
                          TONE[tone].text,
                        )}
                      >
                        {stageStatusLabel(status)}
                      </p>
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs text-sm">
                  {stage.help}
                </TooltipContent>
              </Tooltip>
              {!isLast && (
                <div
                  className={cn(
                    "hidden h-px flex-1 md:block",
                    status === "healthy"
                      ? "bg-gradient-to-r from-emerald-500/30 to-emerald-500/10"
                      : "bg-white/[0.06]",
                  )}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
