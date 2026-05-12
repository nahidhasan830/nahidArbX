"use client";

/**
 * ML Dashboard — shared UI primitives used across tabs.
 *
 * Extracted from the monolithic MLPipelineDashboard.tsx so each tab
 * file can import the pieces it needs without circular deps.
 */

import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// ── Stat Card ──────────────────────────────────────────────────────────

export function Stat({
  label,
  value,
  tone,
  variant = "default",
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
  variant?: "default" | "hero";
}) {
  const isHero = variant === "hero";
  return (
    <div
      className={cn(
        "group relative flex flex-col justify-center overflow-hidden rounded-xl border transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_4px_15px_-5px_rgba(0,0,0,0.6)]",
        isHero
          ? "bg-white/[0.04] border-white/[0.08]"
          : "bg-white/[0.02] border-white/[0.04]",
        isHero ? "p-2.5" : "p-2",
      )}
    >
      {isHero && (
        <div
          className={cn(
            "absolute -inset-px bg-gradient-to-b opacity-0 transition-opacity duration-300 group-hover:opacity-100",
            tone
              ? tone.replace("text-", "from-").replace("-400", "-500/20") +
                  " to-transparent"
              : "from-white/10 to-transparent",
          )}
        />
      )}
      <div className="relative z-10">
        <p className="text-[9px] font-bold uppercase tracking-widest text-white/50 mb-0.5 whitespace-nowrap overflow-hidden text-ellipsis">
          {label}
        </p>
        <div
          className={cn(
            "font-semibold tracking-tight",
            isHero ? "text-lg" : "text-sm",
            tone ?? "text-white",
          )}
        >
          {typeof value === "number" ? value.toLocaleString() : value}
        </div>
      </div>
    </div>
  );
}

// ── Help Tip ──────────────────────────────────────────────────────────

export function HelpTip({ children }: { children: React.ReactNode }) {
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

// ── Section Title ─────────────────────────────────────────────────────

export function SectionTitle({
  title,
  help,
}: {
  title: string;
  help?: React.ReactNode;
}) {
  return (
    <div className="mb-2.5 flex items-center gap-1.5 shrink-0">
      <h4 className="text-[10px] font-bold tracking-widest text-white/80 uppercase">
        {title}
      </h4>
      {help && <HelpTip>{help}</HelpTip>}
    </div>
  );
}

// ── Compact Panel ─────────────────────────────────────────────────────

export function CompactPanel({
  title,
  help,
  children,
  className,
}: {
  title: string;
  help?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border border-white/[0.05] bg-white/[0.02] p-3 backdrop-blur-xl transition-all duration-300 hover:bg-white/[0.03] hover:border-white/[0.08] flex flex-col",
        className,
      )}
    >
      <div className="absolute -inset-px bg-gradient-to-br from-white/[0.03] to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      <div className="relative z-10 flex flex-col h-full">
        <SectionTitle title={title} help={help} />
        <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

// ── Key-Value Row ─────────────────────────────────────────────────────

export function Kv({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
}) {
  return (
    <div className="flex items-center justify-between py-0.5 text-[11px]">
      <span className="text-white/50">{label}</span>
      <span
        className={cn(
          "font-medium tracking-tight tabular-nums",
          tone ?? "text-white",
        )}
      >
        {value}
      </span>
    </div>
  );
}

// ── Stage definitions ─────────────────────────────────────────────────

import {
  Database,
  CircleDot,
  Cpu,
  ShieldCheck,
  Gauge,
  TrendingUp,
} from "lucide-react";
import type { PipelineData, StageStatus } from "./types";

export const STAGES = [
  {
    key: "capture",
    label: "Capture",
    plainTitle: "Capture betting signals",
    icon: Database,
    desc: "Save signals",
    operatorMeaning:
      "Every detected value bet is saved with the price, timing, and market signals the model can learn from.",
    goodState:
      "Recent bets are getting a complete, current set of learning signals.",
    blockedReason:
      "Usually blocked when the engine is not detecting value bets or feature extraction is failing.",
    nextAction:
      "Keep the engine running and watch the recent feature rate before judging training readiness.",
    example:
      "If NineWickets shows Liverpool at 2.10 while Pinnacle implies 1.95, this step stores the odds gap, market movement, time to kickoff, provider count, Kelly fraction, and other signals beside that bet.",
  },
  {
    key: "settle",
    label: "Settle",
    plainTitle: "Learn what happened",
    icon: CircleDot,
    desc: "Mark wins/losses",
    operatorMeaning:
      "Settled outcomes turn captured bets into examples the model can learn from.",
    goodState:
      "Enough current-version, settled examples exist to train without cold-start noise.",
    blockedReason:
      "Usually blocked when too few detected bets have settled or outcomes are still pending.",
    nextAction:
      "Wait for more bets to settle, then check whether the qualified training count reached the target.",
    example:
      "A detected Over 2.5 bet at NineWickets becomes useful only after the match finishes. A win becomes a positive example; a loss becomes a negative example.",
  },
  {
    key: "train",
    label: "Train",
    plainTitle: "Build a candidate model",
    icon: Cpu,
    desc: "Build safely",
    operatorMeaning:
      "A background job builds a candidate model from historical examples and tests it on bets it has never seen.",
    goodState:
      "Training completes with a candidate model and validation metrics instead of failing early.",
    blockedReason:
      "Usually blocked when there are not enough qualified examples or another job is already running.",
    nextAction:
      "Trigger training when the dataset is ready, or let automatic retraining wait for enough new examples.",
    example:
      "The trainer may learn that high EV near kickoff is strong only when Pinnacle is also moving toward the same side.",
  },
  {
    key: "validate",
    label: "Validate",
    plainTitle: "Check model quality",
    icon: ShieldCheck,
    desc: "Safety checks",
    operatorMeaning:
      "The safety checks reject models that look lucky, unstable, badly ranked, or weak in high-score groups.",
    goodState:
      "A model passes quality checks and receives limited authority, starting with observe-only mode.",
    blockedReason:
      "Usually blocked when the latest model failed a quality gate or no training run has completed yet.",
    nextAction:
      "Review the rejection reason, collect more data if needed, then retrain.",
    example:
      "If 0.8-score bets lose more often than 0.5-score bets, validation rejects the model even if headline ROI looks good.",
  },
  {
    key: "score",
    label: "Score",
    plainTitle: "Score new bets live",
    icon: Gauge,
    desc: "Live scoring",
    operatorMeaning:
      "The engine loads the deployed model and gives each new value bet a probability-like score before placement.",
    goodState:
      "A deployed model is loaded, response time is low, and recent bets have model scores.",
    blockedReason:
      "Usually blocked when there is no deployed model or the engine has not loaded it yet.",
    nextAction:
      "Confirm the scorer is loaded, then review score distribution and bucket performance.",
    example:
      "A bet scoring 0.78 looks similar to past winners; a bet scoring 0.25 looks similar to past losers and may be gated later.",
  },
  {
    key: "evaluate",
    label: "Evaluate",
    plainTitle: "Measure paper edge",
    icon: TrendingUp,
    desc: "Paper return",
    operatorMeaning:
      "Paper results compare the model against a simple betting rule on settled detected bets.",
    goodState:
      "The model beats the simple rule on enough settled paper bets with clean learning signals.",
    blockedReason:
      "Usually blocked when high-score groups are weak, sample size is too small, or the stored signals are inconsistent.",
    nextAction:
      "Use paper return, high-score group performance, and data-format health before trusting the model.",
    example:
      "If a simple 3%+ edge rule beats the model, simplify the model objective before retraining.",
  },
] as const;

export function getStageStatuses(d: PipelineData): StageStatus[] {
  const s1: StageStatus =
    d.dataCollection.betsWithFeatures > 0 ? "healthy" : "progressing";
  const coldDone =
    d.dataCollection.qualifiedForTraining >=
    d.dataCollection.coldStartThreshold;
  const s2: StageStatus = coldDone ? "healthy" : "progressing";
  const s3: StageStatus =
    d.training.modelsInTraining > 0
      ? "progressing"
      : d.training.totalModels > 0
        ? "healthy"
        : s2 === "healthy"
          ? "action"
          : "waiting";
  const hasRejected = d.rejectedModels.length > 0;
  const s4: StageStatus = d.training.deployedModel
    ? "healthy"
    : hasRejected && d.training.totalModels > 0
      ? "warning"
      : s3 === "healthy"
        ? "progressing"
        : "waiting";
  const s5: StageStatus = d.inference.modelLoaded
    ? "healthy"
    : s4 === "healthy"
      ? "progressing"
      : "waiting";
  const paper = d.paperEvaluation;
  const s6: StageStatus = !d.featureContract.allSemanticChecksPass
    ? "warning"
    : !d.inference.modelLoaded
      ? "waiting"
      : !paper.verdict.enoughMlGateSamples
        ? "progressing"
        : paper.verdict.mlBeatsSimpleRule
          ? "healthy"
          : "warning";
  return [s1, s2, s3, s4, s5, s6];
}

export function firstIncompleteStep(statuses: StageStatus[]): number {
  const idx = statuses.findIndex((s) => s !== "healthy");
  return idx === -1 ? 0 : idx;
}

export function statusTone(status: StageStatus): string {
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

export function statusLabel(status: StageStatus): string {
  return status === "healthy"
    ? "Ready"
    : status === "action"
      ? "Action"
      : status === "progressing"
        ? "Working"
        : status === "warning"
          ? "Review"
          : "Waiting";
}

export function scoringModeHelp(permissionLevel: string, modelLoaded: boolean) {
  if (!modelLoaded) return "Pass-through: existing rules apply.";
  if (permissionLevel === "gate_only")
    return "Skip weak bets: block low-confidence picks.";
  if (permissionLevel === "stake_reduce")
    return "Reduce weak stakes: lower bet size when confidence is weak.";
  if (permissionLevel === "stake_increase")
    return "Full stake sizing: adjust bet size up or down.";
  return "Observe only: record advice without changing real bets.";
}

// ── Optimizer Status Pill ─────────────────────────────────────────────

export function OptimizerStatusPill({ data: d }: { data: PipelineData }) {
  const ready = d.dataCollection.coldStartProgress >= 100;
  const modelLoaded = d.inference.modelLoaded;
  const canAffectBets =
    d.deploymentGate.canGate || d.deploymentGate.canReduceStake;
  const label = !ready
    ? "Collecting"
    : !modelLoaded
      ? "Ready to train"
      : canAffectBets
        ? "Affecting Bets"
        : "Observe Only";

  const tone = !ready
    ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-400"
    : !modelLoaded
      ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
      : canAffectBets
        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
        : "border-indigo-500/40 bg-indigo-500/10 text-indigo-400";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-bold tracking-widest uppercase",
        tone,
      )}
    >
      <ShieldCheck className="size-3" />
      {label}
    </span>
  );
}
