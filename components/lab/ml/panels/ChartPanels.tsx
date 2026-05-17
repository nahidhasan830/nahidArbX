"use client";

/**
 * LearningCurvePanel — Compact daily ROI mini-bar chart.
 */

import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LineChart } from "lucide-react";
import type { PipelineData } from "../types";

// ── Learning Curve ────────────────────────────────────────────────────

export function LearningCurvePanel({ data }: { data: PipelineData }) {
  const trend = data.paperEvaluation.trend.slice(-14);
  const values = trend
    .flatMap((row) => [row.simpleRoiPct, row.mlGateRoiPct])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const maxAbs = Math.max(5, ...values.map((v) => Math.abs(v)));

  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 backdrop-blur-sm">
      <div className="flex items-center gap-1.5 mb-1.5">
        <LineChart className="size-3.5 text-cyan-400" />
        <h2 className="text-xs font-semibold text-white/80">Paper curve</h2>
      </div>
      {trend.length === 0 ? (
        <p className="text-[11px] text-white/30 py-3 text-center">No trend yet.</p>
      ) : (
        <div className="flex gap-0.5">
          {trend.map((row) => (
            <Tooltip key={row.day}>
              <TooltipTrigger asChild>
                <div className="flex cursor-default flex-col items-center gap-0.5 w-8 shrink-0">
                  <div className="relative h-12 w-full rounded border border-white/[0.04] bg-white/[0.02]">
                    <span className="absolute left-0 right-0 top-1/2 h-px bg-white/[0.06]" />
                    <RoiBar value={row.simpleRoiPct} maxAbs={maxAbs} className="left-[25%] bg-cyan-400" />
                    <RoiBar value={row.mlGateRoiPct} maxAbs={maxAbs} className="left-[60%] bg-emerald-400" />
                  </div>
                  <span className="font-mono text-[7px] text-white/20">{row.day.slice(8)}</span>
                </div>
              </TooltipTrigger>
              <TooltipContent className="text-xs space-y-0.5">
                <p className="font-medium">{row.day}</p>
                <p className="text-cyan-400">Rule {fmtPct(row.simpleRoiPct)} · N{row.simpleN}</p>
                <p className="text-emerald-400">ML {fmtPct(row.mlGateRoiPct)} · N{row.mlGateN}</p>
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      )}
    </div>
  );
}

function RoiBar({ value, maxAbs, className }: { value: number | null; maxAbs: number; className: string }) {
  if (value == null) return null;
  const height = Math.max(3, Math.min(46, (Math.abs(value) / maxAbs) * 46));
  return (
    <span
      className={cn("absolute w-1 rounded-full", className, value < 0 && "bg-rose-400", value >= 0 ? "bottom-1/2" : "top-1/2")}
      style={{ height: `${height}%` }}
    />
  );
}

function fmtPct(v: number | null): string { return v == null ? "—" : `${v.toFixed(1)}%`; }
