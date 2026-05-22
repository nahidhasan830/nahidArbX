"use client";

import { CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RungCategory, EvaluatedRung } from "@/lib/lab/ml/rungs";
import type { PipelineData } from "./types";
import { Rung } from "./Rung";

const GROUP_TITLES: Record<RungCategory, string> = {
  data: "Data",
  training: "Training",
  inference: "Inference",
  quality: "Quality",
};

const GROUP_HINTS: Record<RungCategory, string> = {
  data: "Where the training corpus comes from.",
  training: "How a candidate model gets built and accepted.",
  inference: "How the deployed model reaches a live bet.",
  quality: "Whether the model is good enough to influence placement.",
};

interface Props {
  category: RungCategory;
  rungs: EvaluatedRung[];
  data: PipelineData;
}

/**
 * One section of the pipeline ladder. Header shows category name, a
 * one-line hint, and a passing/total counter chip that turns green
 * when the entire group is passing.
 */
export function RungGroup({ category, rungs, data }: Props) {
  if (rungs.length === 0) return null;

  const passing = rungs.filter((r) => r.verdict.status === "pass").length;
  const failing = rungs.filter((r) => r.verdict.status === "fail").length;
  const blocked = rungs.filter((r) => r.verdict.status === "blocked").length;
  const total = rungs.length;
  const allPassing = passing === total;

  return (
    <section className="border-t border-border/60 first:border-t-0">
      <header className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold tracking-tight text-foreground">
              {GROUP_TITLES[category]}
            </h2>
            {allPassing && (
              <CheckCircle2
                className="size-3.5 text-emerald-500"
                aria-label="all passing"
              />
            )}
          </div>
          <p className="mt-0.5 text-[12px] text-muted-foreground/80">
            {GROUP_HINTS[category]}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span
            className={cn(
              "rounded-full px-2 py-0.5 font-mono text-[11px] font-medium tabular-nums",
              failing > 0
                ? "bg-rose-500/15 text-rose-400"
                : allPassing
                  ? "bg-emerald-500/15 text-emerald-400"
                  : "bg-muted text-muted-foreground",
            )}
          >
            {passing}/{total}
          </span>
          {blocked > 0 && (
            <span className="rounded-full bg-zinc-500/15 px-2 py-0.5 font-mono text-[11px] font-medium tabular-nums text-zinc-400">
              {blocked} blocked
            </span>
          )}
        </div>
      </header>
      <div className="divide-y divide-border/40">
        {rungs.map((r) => (
          <Rung
            key={r.definition.id}
            definition={r.definition}
            verdict={r.verdict}
            data={data}
          />
        ))}
      </div>
    </section>
  );
}
