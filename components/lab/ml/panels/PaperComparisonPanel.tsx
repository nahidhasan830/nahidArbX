"use client";

/**
 * PaperComparisonPanel — Compact 4-cohort paper evidence with inline verdict.
 * Dense horizontal layout: cohort stats in a table-like grid, verdict as a pill.
 */

import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TermTooltip } from "@/components/ui/TermTooltip";
import type { TermId } from "@/lib/lab/glossary";
import { BarChart3 } from "lucide-react";
import type { PipelineData } from "../types";

const COHORT_TERM_BY_LABEL: Record<string, TermId> = {
  "Detection Baseline": "detection_baseline",
  "Simple EV Rule": "simple_ev_rule",
  "Model Scored": "model_scored",
  "Model Gate": "model_gate",
};

export function PaperComparisonPanel({ data }: { data: PipelineData }) {
  const { metrics, verdict } = data.paperEvaluation;
  const cohorts = [
    metrics.detectedBaseline,
    metrics.simpleEvCore,
    metrics.mlScored,
    metrics.mlGate,
  ];

  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 backdrop-blur-sm">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5">
          <BarChart3 className="size-3.5 text-cyan-400" />
          <h2 className="text-xs font-semibold text-white/80">Paper evidence</h2>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex size-3.5 cursor-help items-center justify-center rounded-full border border-white/10 bg-white/5 text-[8px] text-white/40">?</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-sm">Settled, clean examples only. Target: Model Gate beats Simple EV Rule.</TooltipContent>
          </Tooltip>
        </div>
        {/* Verdict pill inline (Model Lift) */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={cn(
              "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-bold tabular-nums shrink-0",
              (verdict.mlMinusSimpleRoiPct ?? 0) > 0
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                : (verdict.mlMinusSimpleRoiPct ?? 0) < 0
                  ? "border-rose-500/30 bg-rose-500/10 text-rose-400"
                  : "border-white/[0.08] bg-white/[0.03] text-white/40",
            )}>
              {verdict.mlMinusSimpleRoiPct != null
                ? `${verdict.mlMinusSimpleRoiPct > 0 ? "+" : ""}${verdict.mlMinusSimpleRoiPct.toFixed(2)} pts`
                : "—"}
              <span className="text-[10px] font-normal text-white/30">lift</span>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-sm">
            {verdict.enoughMlGateSamples
              ? verdict.mlBeatsSimpleRule
                ? "Model Gate is ahead on clean paper results."
                : "Simple EV Rule still ahead. Keep model permissions disabled."
              : "More settled Model Gate samples needed."}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Cohort grid — dense table-like layout */}
      <div className="grid grid-cols-4 gap-1.5">
        {cohorts.map((m) => {
          const term = COHORT_TERM_BY_LABEL[m.label];
          return (
            <div
              key={m.label}
              className="rounded-md border border-white/[0.05] bg-white/[0.02] px-2 py-1.5"
            >
              <div className="flex items-center gap-1">
                <p className="text-[9px] font-bold uppercase tracking-wider text-white/35 truncate">
                  {m.label}
                </p>
                {term && <TermTooltip term={term} iconOnly />}
              </div>
              <p
                className={cn(
                  "text-base font-bold tabular-nums mt-0.5",
                  roiColor(m.roiPct),
                )}
              >
                {m.roiPct != null ? `${m.roiPct.toFixed(1)}%` : "—"}
              </p>
              <div className="flex items-center gap-2 mt-1 text-[10px] text-white/40">
                <span className="tabular-nums">N {m.sampleSize}</span>
                <span className="tabular-nums">
                  W {m.winRatePct?.toFixed(0)}%
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function roiColor(v: number | null): string {
  if (v == null) return "text-white/30";
  if (v > 0) return "text-emerald-400";
  if (v < 0) return "text-rose-400";
  return "text-white/40";
}
