"use client";

/**
 * Shared algorithm picker + option list used by both `SubmitRunSheet`
 * ("New run") and `CreateScheduleSheet` ("New schedule").
 *
 * Compact 5-column layout: each card is label + radio + optional
 * Recommended pill + info tooltip. Tagline/help lives inside the
 * `TermTooltip` rather than on the card itself so the Basics step fits
 * in the available height without a scrollbar.
 */

import * as React from "react";
import { cn } from "@/lib/utils";
import { TermTooltip } from "@/components/ui/TermTooltip";
import type { TermId } from "@/lib/lab/glossary";
import type { SearchAlgorithm } from "@/lib/optimizer/types";

export interface AlgoOpt {
  value: SearchAlgorithm;
  label: string;
  tagline: string;
  term: TermId;
  recommended?: boolean;
}

export const ALGOS: AlgoOpt[] = [
  {
    value: "ensemble",
    label: "Ensemble",
    tagline: "Broad search + focused refinement",
    term: "ensemble",
    recommended: true,
  },
  {
    value: "tpe",
    label: "TPE · Bayesian",
    tagline: "Learns from early trials",
    term: "tpe",
  },
  {
    value: "random",
    label: "Random",
    tagline: "Tries everything evenly",
    term: "random_search",
  },
  {
    value: "nsga2",
    label: "NSGA-II",
    tagline: "Maps the trade-off line",
    term: "nsga2",
  },
  {
    value: "ml-xgboost",
    label: "ML · XGBoost",
    tagline: "Lets a model find the edges",
    term: "ml_xgboost",
  },
];

export function AlgorithmPicker({
  value,
  onChange,
}: {
  value: SearchAlgorithm;
  onChange: (v: SearchAlgorithm) => void;
}) {
  return (
    <div className="grid grid-cols-5 gap-1.5">
      {ALGOS.map((a) => (
        <CompactAlgoCard
          key={a.value}
          selected={value === a.value}
          onSelect={() => onChange(a.value)}
          label={a.label}
          term={a.term}
          recommended={a.recommended}
        />
      ))}
    </div>
  );
}

/**
 * One card in the 5-col algorithm grid. Compact: label + radio dot +
 * optional "Recommended" pill + info tooltip. Context (tagline + help)
 * lives in the tooltip so the card stays ~40px tall and the whole row
 * fits in one line.
 */
function CompactAlgoCard({
  selected,
  onSelect,
  label,
  term,
  recommended,
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
  term: TermId;
  recommended?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "relative text-left rounded-lg border transition-all px-2 py-2 flex flex-col gap-1 group min-h-[44px]",
        selected
          ? "border-primary bg-primary/5 shadow-sm"
          : "border-border bg-card hover:border-foreground/30 hover:bg-muted/30",
      )}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="font-semibold text-[12px] leading-tight truncate">
          {label}
        </span>
        <span
          aria-hidden
          className={cn(
            "shrink-0 size-3.5 rounded-full border-2 flex items-center justify-center transition-colors",
            selected
              ? "border-primary bg-primary"
              : "border-muted-foreground/40 group-hover:border-foreground/60",
          )}
        >
          {selected && (
            <span className="size-1 rounded-full bg-primary-foreground" />
          )}
        </span>
      </div>
      <div className="flex items-center justify-between gap-1 -mb-0.5">
        {recommended ? (
          <span className="inline-flex items-center rounded-full px-1 py-[1px] text-[9px] font-medium uppercase tracking-wide bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
            Recommended
          </span>
        ) : (
          <span aria-hidden />
        )}
        <TermTooltip term={term} iconOnly />
      </div>
    </button>
  );
}
