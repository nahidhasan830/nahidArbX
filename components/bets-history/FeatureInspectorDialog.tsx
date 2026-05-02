"use client";

/**
 * FeatureInspectorDialog — wide, compact modal that visualises the 23-dimension
 * ML feature vector attached to a bet.
 *
 * Layout: header row with event context + ML scores, then a flat 3-column grid
 * of all 23 features. Each cell shows category dot, label, and formatted value.
 * Hover for full description. Fits on screen without scrolling.
 */

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  FEATURE_CATALOG,
  CATEGORY_COLORS,
  formatFeatureValue,
} from "@/lib/ml/feature-catalog";

interface FeatureInspectorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The 23-element feature vector, or null if not available. */
  features: number[] | null | undefined;
  /** ML confidence score (0–1), if available. */
  mlScore?: number | null;
  /** Adjusted Kelly multiplier, if available. */
  mlKellyAdjusted?: number | null;
  /** Event label for context (e.g. "Arsenal vs Chelsea"). */
  eventLabel?: string;
  /** Market label for context (e.g. "[FT] Match Result · Home"). */
  marketLabel?: string;
}

export function FeatureInspectorDialog({
  open,
  onOpenChange,
  features,
  mlScore,
  mlKellyAdjusted,
  eventLabel,
  marketLabel,
}: FeatureInspectorDialogProps) {
  if (!features || features.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[920px] p-5 gap-3">
        {/* Header: title + context + ML scores in one row */}
        <DialogHeader className="pb-0">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <DialogTitle className="flex items-center gap-2 text-sm">
                <span className="size-2 rounded-full bg-violet-400 shrink-0" />
                Feature Inspector
              </DialogTitle>
              <DialogDescription className="mt-0.5 truncate">
                {eventLabel && (
                  <span className="text-xs font-medium text-foreground mr-2">{eventLabel}</span>
                )}
                {marketLabel && (
                  <span className="text-[11px] text-muted-foreground">{marketLabel}</span>
                )}
              </DialogDescription>
            </div>
            {/* Inline ML scores */}
            {(mlScore != null || mlKellyAdjusted != null) && (
              <div className="flex items-center gap-3 shrink-0 pr-6">
                {mlScore != null && (
                  <div className="text-right">
                    <div className="text-[10px] text-muted-foreground">ML Score</div>
                    <div className={cn(
                      "text-sm font-semibold tabular-nums",
                      mlScore >= 0.4 ? "text-emerald-400" : "text-amber-400",
                    )}>
                      {mlScore.toFixed(3)}
                    </div>
                  </div>
                )}
                {mlKellyAdjusted != null && (
                  <div className="text-right">
                    <div className="text-[10px] text-muted-foreground">Kelly (adj.)</div>
                    <div className="text-sm font-semibold tabular-nums text-foreground">
                      {(mlKellyAdjusted * 100).toFixed(2)}%
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </DialogHeader>

        {/* Category legend — compact inline */}
        <div className="flex gap-3 text-[10px] text-muted-foreground">
          {(["Value", "Odds", "Movement", "Market", "Staking"] as const).map((cat) => (
            <span key={cat} className="flex items-center gap-1">
              <span className={cn("size-1.5 rounded-full", CATEGORY_COLORS[cat])} />
              {cat}
            </span>
          ))}
        </div>

        {/* Flat 3-column feature grid */}
        <div className="grid grid-cols-3 gap-x-3 gap-y-0 rounded-lg border border-border/30 bg-muted/5 overflow-hidden">
          {FEATURE_CATALOG.map((meta, i) => {
            const value = features[i] ?? 0;
            return (
              <Tooltip key={meta.name}>
                <TooltipTrigger asChild>
                  <div className={cn(
                    "flex items-center justify-between px-2.5 py-[5px] cursor-help group transition-colors hover:bg-muted/20",
                    // Subtle separator between rows — every 3rd cell is followed by a border
                    i < FEATURE_CATALOG.length - 3 && "border-b border-border/10",
                  )}>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className={cn("size-1.5 rounded-full shrink-0", CATEGORY_COLORS[meta.cat])} />
                      <span className="text-[11px] text-muted-foreground group-hover:text-foreground transition-colors truncate">
                        {meta.label}
                      </span>
                    </div>
                    <span className="text-xs font-medium tabular-nums text-foreground shrink-0 ml-2">
                      {formatFeatureValue(value, meta.fmt)}
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[280px] text-xs leading-relaxed">
                  <div className="font-semibold mb-0.5">{meta.label}</div>
                  <div className="text-muted-foreground">{meta.desc}</div>
                  <div className="text-[10px] text-muted-foreground/50 mt-1 font-mono">{meta.name} = {value}</div>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
