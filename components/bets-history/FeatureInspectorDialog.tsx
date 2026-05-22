"use client";

/**
 * FeatureInspectorDialog — wide, compact modal that visualises the ML feature
 * vector attached to a bet.
 *
 * Layout: header row with event context + ML scores + feature version info,
 * then a flat 3-column grid of all features. Each cell shows category dot,
 * label, and formatted value. Hover for full description.
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
  FEATURE_CATEGORIES,
  CATEGORY_COLORS,
  formatFeatureValue,
} from "@/lib/ml/feature-catalog";

interface FeatureInspectorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The stored ML feature vector, or null if not available. */
  features: number[] | null | undefined;
  /** ML confidence score (0–1), if available. */
  mlScore?: number | null;
  /** Adjusted stake fraction the model would have used (baseline × multiplier, capped). */
  mlStakeFraction?: number | null;
  /** Event label for context (e.g. "Arsenal vs Chelsea"). */
  eventLabel?: string;
  /** Market label for context (e.g. "[FT] Match Result · Home"). */
  marketLabel?: string;
  /** Feature contract version at extraction time. */
  featureVersion?: number | null;
  /** Feature vector length at extraction time. */
  featureCount?: number | null;
  /** Whether the ML score affected placement (gate_only+ permission). */
  scoreAffectedPlacement?: boolean;
  /** Current permission level of the deployed model. */
  permissionLevel?: string | null;
}

export function FeatureInspectorDialog({
  open,
  onOpenChange,
  features,
  mlScore,
  mlStakeFraction,
  eventLabel,
  marketLabel,
  featureVersion,
  featureCount,
  scoreAffectedPlacement,
  permissionLevel,
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
                  <span className="text-xs font-medium text-foreground mr-2">
                    {eventLabel}
                  </span>
                )}
                {marketLabel && (
                  <span className="text-[11px] text-muted-foreground">
                    {marketLabel}
                  </span>
                )}
              </DialogDescription>
            </div>
            {/* Inline ML scores + version info */}
            <div className="flex items-center gap-3 shrink-0 pr-6">
              {mlScore != null && (
                <div className="text-right">
                  <div className="text-[10px] text-muted-foreground">
                    ML Score
                  </div>
                  <div
                    className={cn(
                      "text-sm font-semibold tabular-nums",
                      mlScore >= 0.4 ? "text-emerald-400" : "text-amber-400",
                    )}
                  >
                    {mlScore.toFixed(3)}
                  </div>
                </div>
              )}
              {mlStakeFraction != null && (
                <div className="text-right">
                  <div className="text-[10px] text-muted-foreground">
                    Model Stake
                  </div>
                  <div className="text-sm font-semibold tabular-nums text-foreground">
                    {(mlStakeFraction * 100).toFixed(2)}%
                  </div>
                </div>
              )}
              {featureVersion != null && (
                <div className="text-right">
                  <div className="text-[10px] text-muted-foreground">
                    Version
                  </div>
                  <div className="text-sm font-semibold tabular-nums text-foreground">
                    v{featureVersion}
                  </div>
                </div>
              )}
            </div>
          </div>
        </DialogHeader>

        {/* Phase 10: Score impact + permission info */}
        <div className="flex items-center gap-3 flex-wrap">
          {/* Category legend — compact inline */}
          <div className="flex gap-3 text-[10px] text-muted-foreground">
            {FEATURE_CATEGORIES.map((cat) => (
              <span key={cat} className="flex items-center gap-1">
                <span
                  className={cn("size-1.5 rounded-full", CATEGORY_COLORS[cat])}
                />
                {cat}
              </span>
            ))}
          </div>
          <div className="flex-1" />
          {/* Score placement effect badge */}
          {mlScore != null && (
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
                scoreAffectedPlacement
                  ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-400"
                  : permissionLevel === "observe"
                    ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                    : "border-border/40 bg-muted/20 text-muted-foreground",
              )}
            >
              {scoreAffectedPlacement
                ? "Score affected placement"
                : permissionLevel === "observe"
                  ? "Observe mode (log only)"
                  : "Score did not affect placement"}
            </span>
          )}
          {featureCount != null && featureCount !== features.length && (
            <span className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400">
              ⚠ Length mismatch: stored {featureCount} vs actual{" "}
              {features.length}
            </span>
          )}
        </div>

        {/* Flat 3-column feature grid */}
        <div className="grid grid-cols-3 gap-x-3 gap-y-0 rounded-lg border border-border/30 bg-muted/5 overflow-hidden">
          {FEATURE_CATALOG.map((meta, i) => {
            const value = features[i] ?? 0;
            return (
              <Tooltip key={meta.name}>
                <TooltipTrigger asChild>
                  <div
                    className={cn(
                      "flex items-center justify-between px-2.5 py-[5px] cursor-help group transition-colors hover:bg-muted/20",
                      // Subtle separator between rows — every 3rd cell is followed by a border
                      i < FEATURE_CATALOG.length - 3 &&
                        "border-b border-border/10",
                    )}
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className={cn(
                          "size-1.5 rounded-full shrink-0",
                          CATEGORY_COLORS[meta.cat],
                        )}
                      />
                      <span className="text-[11px] text-muted-foreground group-hover:text-foreground transition-colors truncate">
                        {meta.label}
                      </span>
                    </div>
                    <span className="text-xs font-medium tabular-nums text-foreground shrink-0 ml-2">
                      {formatFeatureValue(value, meta.fmt)}
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  className="max-w-[280px] text-xs leading-relaxed"
                >
                  <div className="font-semibold mb-0.5">{meta.label}</div>
                  <div className="text-muted-foreground">{meta.desc}</div>
                  <div className="text-[10px] text-muted-foreground/50 mt-1 font-mono">
                    {meta.name} = {value}
                  </div>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
