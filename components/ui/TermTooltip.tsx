"use client";

/**
 * TermTooltip — wrap any technical word/phrase with an info icon that opens
 * a hover/click tooltip explaining the term. Content lives in
 * `lib/lab/glossary.ts` so every page renders the same definition.
 *
 *   <TermTooltip term="drawdown">Max DD</TermTooltip>
 *
 * Pass `value` to get a dynamic "Your value: X — verdict" block:
 *
 *   <TermTooltip term="drawdown" value={trial.maxDrawdown ?? undefined}>
 *     Max DD
 *   </TermTooltip>
 *
 * Without `value`, a static guidance note is shown instead
 * (e.g. "Lower is better · under 10% = excellent…") — useful for
 * column headers where no specific value is in scope.
 *
 * The tooltip shows, in order:
 *   - short      (bold one-line headline)
 *   - example    (plain-English explanation with concrete betting numbers)
 *   - verdict    (dynamic "Your value: X" when value is provided)
 *   - guidance   (static range note when no value, and ranges are defined)
 *   - objective  (italic one-liner ONLY on choice-type entries)
 */

import * as React from "react";
import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  getTerm,
  type GlossaryRanges,
  type RangeValueFormat,
  type TermId,
} from "@/lib/lab/glossary";
import { cn } from "@/lib/utils";

export interface TermTooltipProps {
  term: TermId;
  children?: React.ReactNode;
  /** Hide the info icon (useful when the term is the icon itself). */
  iconOnly?: boolean;
  className?: string;
  /**
   * The actual numeric value for this metric (e.g. `trial.maxDrawdown`).
   * When provided, renders a coloured "Your value: X — verdict" block that
   * judges whether this specific number is good, borderline, or bad.
   * When omitted, a static guidance note is shown instead.
   */
  value?: number;
}

function evaluateValue(
  ranges: GlossaryRanges,
  value: number,
): { tone: "positive" | "warning" | "danger"; verdict: string } {
  for (const t of ranges.thresholds) {
    if (ranges.direction === "lower_is_better" && value <= t.bound) {
      return { tone: t.tone, verdict: t.verdict };
    }
    if (ranges.direction === "higher_is_better" && value >= t.bound) {
      return { tone: t.tone, verdict: t.verdict };
    }
  }
  return { tone: ranges.fallback.tone, verdict: ranges.fallback.verdict };
}

function formatValue(value: number, format: RangeValueFormat): string {
  switch (format) {
    case "pct_decimal":
      return `${(value * 100).toFixed(1)}%`;
    case "pct":
      return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
    case "decimal":
      return value.toFixed(2);
    case "integer":
      return Math.round(value).toLocaleString();
  }
}

export function TermTooltip({
  term,
  children,
  iconOnly = false,
  className,
  value,
}: TermTooltipProps) {
  const entry = getTerm(term);
  const hasValue = value != null && Number.isFinite(value);
  const evaluation =
    hasValue && entry.ranges ? evaluateValue(entry.ranges, value!) : null;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`inline-flex items-center gap-1 cursor-help underline decoration-dotted decoration-muted-foreground/60 underline-offset-2 ${className ?? ""}`}
          >
            {!iconOnly && children}
            <Info className="size-3.5 text-muted-foreground" aria-hidden />
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="start"
          className="max-w-md space-y-2.5 leading-relaxed px-3.5 py-3"
        >
          <p className="text-sm font-semibold text-foreground">{entry.short}</p>

          {entry.example && (
            <p className="text-[13px] text-muted-foreground">{entry.example}</p>
          )}

          {/* Dynamic verdict when a specific value is passed */}
          {evaluation && entry.ranges && (
            <div className="pt-1.5 border-t border-border/40 text-[13px] leading-snug">
              <span className="text-muted-foreground">Your value: </span>
              <span
                className={cn(
                  "font-semibold tabular-nums",
                  evaluation.tone === "positive" &&
                    "text-emerald-600 dark:text-emerald-400",
                  evaluation.tone === "warning" &&
                    "text-amber-600 dark:text-amber-400",
                  evaluation.tone === "danger" &&
                    "text-red-600 dark:text-red-400",
                )}
              >
                {formatValue(value!, entry.ranges.valueFormat)}
              </span>
              <span className="text-muted-foreground">
                {" "}
                — {evaluation.verdict}
              </span>
            </div>
          )}

          {/* Static guidance note when no value (e.g. column headers) */}
          {!evaluation && entry.ranges?.guidanceNote && (
            <p className="pt-1.5 border-t border-border/40 text-[11px] italic text-muted-foreground/80">
              {entry.ranges.guidanceNote}
            </p>
          )}

          {entry.objective && (
            <p className="text-[13px] italic text-muted-foreground">
              {entry.objective}
            </p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
