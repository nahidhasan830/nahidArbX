"use client";

import {
  evaluateRungs,
  type EvaluatedRung,
  type RungCategory,
} from "@/lib/lab/ml/rungs";
import { cn } from "@/lib/utils";
import type { PipelineData } from "./types";
import { RungGroup } from "./RungGroup";

const CATEGORY_ORDER: RungCategory[] = [
  "data",
  "training",
  "inference",
  "quality",
];

interface Props {
  data: PipelineData;
  /**
   * Pre-evaluated rungs. If omitted, evaluates from `data` directly —
   * useful for standalone usage, but in the dashboard the parent
   * already evaluates once and passes them down.
   */
  rungs?: EvaluatedRung[];
}

/**
 * Top-level pipeline-checklist component. Shows a summary header
 * (n/N gates passing) and the four category groups. Pure rendering —
 * the parent owns the data fetch.
 */
export function PipelineLadder({ data, rungs }: Props) {
  const evaluated = rungs ?? evaluateRungs(data);

  const byCategory = new Map<RungCategory, EvaluatedRung[]>();
  for (const cat of CATEGORY_ORDER) byCategory.set(cat, []);
  for (const r of evaluated) {
    byCategory.get(r.definition.category)?.push(r);
  }

  const passing = evaluated.filter((r) => r.verdict.status === "pass").length;
  const failing = evaluated.filter((r) => r.verdict.status === "fail").length;
  const total = evaluated.length;

  return (
    <div className="rounded-xl border border-border/60 bg-card/60 backdrop-blur-sm">
      <header className="flex items-center justify-between border-b border-border/40 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            Pipeline Ladder
          </h2>
          <p className="mt-0.5 text-[12px] text-muted-foreground/80">
            Click any row to see why it&rsquo;s passing or failing.
          </p>
        </div>
        <span
          className={cn(
            "rounded-full px-2.5 py-1 font-mono text-[11px] font-medium tabular-nums",
            failing > 0
              ? "bg-rose-500/15 text-rose-400"
              : passing === total
                ? "bg-emerald-500/15 text-emerald-400"
                : "bg-muted text-muted-foreground",
          )}
        >
          {passing} / {total} gates passing
        </span>
      </header>
      {CATEGORY_ORDER.map((cat) => (
        <RungGroup
          key={cat}
          category={cat}
          rungs={byCategory.get(cat) ?? []}
          data={data}
        />
      ))}
    </div>
  );
}
