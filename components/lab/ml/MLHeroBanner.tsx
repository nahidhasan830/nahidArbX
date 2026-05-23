"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { buildStateSummary } from "@/lib/lab/ml/state-summary";
import type { EvaluatedRung } from "@/lib/lab/ml/rungs";
import type { PipelineData } from "./types";

interface Props {
  data: PipelineData;
  rungs: EvaluatedRung[];
  /** Optional callback — when provided, shows a "Jump to ladder" CTA. */
  onJumpToFailingGate?: () => void;
}

const MOOD_STYLES: Record<
  "good" | "warn" | "bad",
  {
    container: string;
    iconBg: string;
    iconText: string;
    label: string;
    labelText: string;
    glow: string;
  }
> = {
  good: {
    container: "border-emerald-500/25 bg-emerald-500/[0.03]",
    iconBg: "bg-emerald-500/15",
    iconText: "text-emerald-400",
    label: "bg-emerald-500/15 text-emerald-300",
    labelText: "Healthy",
    glow: "shadow-[0_0_40px_-12px_rgba(16,185,129,0.25)]",
  },
  warn: {
    container: "border-amber-500/30 bg-amber-500/[0.04]",
    iconBg: "bg-amber-500/15",
    iconText: "text-amber-400",
    label: "bg-amber-500/15 text-amber-300",
    labelText: "Attention",
    glow: "shadow-[0_0_40px_-12px_rgba(245,158,11,0.25)]",
  },
  bad: {
    container: "border-rose-500/35 bg-rose-500/[0.05]",
    iconBg: "bg-rose-500/15",
    iconText: "text-rose-400",
    label: "bg-rose-500/15 text-rose-300",
    labelText: "Action required",
    glow: "shadow-[0_0_40px_-12px_rgba(244,63,94,0.30)]",
  },
};

/**
 * Top-of-page hero status banner. Single source of truth for "what's
 * happening right now". Bigger, more scannable, and surfaces the
 * primary CTA when something needs attention. The 5-second test target.
 */
export function MLHeroBanner({ data, rungs, onJumpToFailingGate }: Props) {
  const { headline, mood } = buildStateSummary(data, rungs);
  const styles = MOOD_STYLES[mood];

  const inTraining = data.training.modelsInTraining > 0;
  const firstFailing = rungs.find((r) => r.verdict.status === "fail");

  // Pick the best icon for the situation.
  const Icon =
    inTraining && mood !== "bad"
      ? Loader2
      : mood === "good"
        ? CheckCircle2
        : mood === "warn"
          ? Sparkles
          : AlertTriangle;

  const iconAnimate = inTraining && mood !== "bad" ? "animate-spin" : "";

  return (
    <section
      role="status"
      aria-live="polite"
      className={cn(
        "rounded-lg border backdrop-blur-sm transition-shadow",
        styles.container,
        styles.glow,
      )}
    >
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-4">
        {/* Icon */}
        <div
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-lg",
            styles.iconBg,
          )}
        >
          <Icon className={cn("size-5", styles.iconText, iconAnimate)} aria-hidden />
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-mono font-medium uppercase tracking-[0.16em]",
                styles.label,
              )}
            >
              {styles.labelText}
            </span>
            {inTraining && (
              <span className="inline-flex items-center gap-1 rounded-full bg-cyan-500/15 px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-cyan-300">
                Training in progress
              </span>
            )}
          </div>
          <p className="text-sm font-medium leading-snug text-foreground sm:text-[15px]">
            {headline}
          </p>
        </div>

        {/* CTA */}
        {firstFailing && onJumpToFailingGate && (
          <Button
            variant="outline"
            size="sm"
            onClick={onJumpToFailingGate}
            className={cn(
              "shrink-0 self-start sm:self-auto",
              "border-current/30 hover:bg-current/5",
            )}
          >
            Jump to gate {firstFailing.definition.number}
          </Button>
        )}
      </div>
    </section>
  );
}
