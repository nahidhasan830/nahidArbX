"use client";

/**
 * ScoreBucketPanel — Compact model edge buckets as inline horizontal bars.
 */

import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TrendingUp } from "lucide-react";
import type { PipelineData } from "../types";

export function ScoreBucketPanel({ data }: { data: PipelineData }) {
  const maxCount = Math.max(1, ...data.scoreBucketROI.map((b) => b.count));

  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 backdrop-blur-sm">
      <div className="flex items-center gap-1.5 mb-2">
        <TrendingUp className="size-3.5 text-cyan-400" />
        <h2 className="text-xs font-semibold text-white/80">Score buckets</h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex size-3.5 cursor-help items-center justify-center rounded-full border border-white/10 bg-white/5 text-[8px] text-white/40">?</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-sm">Grouped by model EV at offered odds.</TooltipContent>
        </Tooltip>
      </div>
      <div className="space-y-0.5">
        {data.scoreBucketROI.map((b) => (
          <Tooltip key={b.bucket}>
            <TooltipTrigger asChild>
              <div className="grid cursor-default grid-cols-[56px_1fr_48px] items-center gap-2 rounded px-1 py-0.5 hover:bg-white/[0.02]">
                <span className="font-mono text-[10px] text-white/40 truncate">{b.bucket}</span>
                <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      b.avgPnl > 0 ? "bg-emerald-500" : "bg-rose-500",
                    )}
                    style={{ width: `${Math.max(3, (b.count / maxCount) * 100)}%` }}
                  />
                </div>
                <span className={cn(
                  "text-right font-mono text-[10px] tabular-nums",
                  b.avgPnl > 0 ? "text-emerald-400" : b.avgPnl < 0 ? "text-rose-400" : "text-white/30",
                )}>
                  {b.count > 0 ? `${b.avgPnl.toFixed(1)}%` : "—"}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent className="text-xs">
              N {b.count} · W {b.winRate.toFixed(1)}% · CLV {b.avgClv.toFixed(2)}%
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
