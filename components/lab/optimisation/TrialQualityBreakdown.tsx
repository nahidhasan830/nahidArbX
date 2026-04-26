"use client";

/**
 * TrialQualityBreakdown — sits next to the Pareto scatter and answers
 * "of all the trials we ran, how many are actually trustworthy?".
 *
 * Three count rows (good / borderline / unreliable) with thin progress
 * bars + a "Pareto vs dominated" stat. Consumes pre-classified trials so
 * we don't run `classifyTrial` twice on the same data.
 */

import * as React from "react";
import { cn } from "@/lib/utils";
import { TermTooltip } from "@/components/ui/TermTooltip";
import {
  classifyTrial,
  type TrialQuality,
} from "@/lib/optimizer/trial-quality";
import type { OptimizationTrialRow } from "@/lib/optimizer/repository";

interface Bucket {
  label: string;
  count: number;
  tone: "good" | "warning" | "danger";
  description: string;
}

export function TrialQualityBreakdown({
  trials,
  className,
}: {
  trials: OptimizationTrialRow[];
  className?: string;
}) {
  const { buckets, paretoCount, total } = React.useMemo(() => {
    let ok = 0;
    let low = 0;
    let unreliable = 0;
    let onPareto = 0;
    for (const t of trials) {
      const q: TrialQuality = classifyTrial({
        sampleSize: t.sampleSize ?? null,
        deflatedSharpe: t.deflatedSharpe ?? null,
        oosRoiCiLow: t.oosRoiCiLow ?? null,
        compositeScore: t.compositeScore ?? null,
      }).quality;
      if (q === "ok") ok += 1;
      else if (q === "low") low += 1;
      else unreliable += 1;
      if (t.onPareto) onPareto += 1;
    }
    return {
      buckets: [
        {
          label: "Passed every safety check",
          count: ok,
          tone: "good" as const,
          description: "100+ bets · DSR ≥ 0.8 · CI above zero",
        },
        {
          label: "Borderline — useful as a hint",
          count: low,
          tone: "warning" as const,
          description: "≥ 30 bets but wide CI or DSR 0.5–0.8",
        },
        {
          label: "Unreliable — treat as noise",
          count: unreliable,
          tone: "danger" as const,
          description: "< 30 bets, DSR < 0.5, or sentinel composite",
        },
      ] satisfies Bucket[],
      paretoCount: onPareto,
      total: trials.length,
    };
  }, [trials]);

  if (total === 0) {
    return (
      <section
        className={cn(
          "rounded-lg border border-border/60 bg-card p-4",
          className,
        )}
      >
        <p className="text-[11px] text-muted-foreground py-6 text-center">
          No trials yet.
        </p>
      </section>
    );
  }

  return (
    <section
      className={cn(
        "rounded-lg border border-border/60 bg-card p-4 flex flex-col gap-3",
        className,
      )}
    >
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Quality breakdown</h2>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {total.toLocaleString()} trials
        </span>
      </header>

      <ul className="flex flex-col gap-2.5">
        {buckets.map((b) => (
          <BucketRow key={b.label} bucket={b} total={total} />
        ))}
      </ul>

      <footer className="border-t border-border/60 pt-2.5 grid grid-cols-2 gap-2">
        <Stat
          label={<TermTooltip term="pareto">On trade-off line</TermTooltip>}
          value={paretoCount.toLocaleString()}
          tone="good"
        />
        <Stat
          label="Dominated"
          value={(total - paretoCount).toLocaleString()}
          tone="muted"
        />
      </footer>
    </section>
  );
}

function BucketRow({ bucket, total }: { bucket: Bucket; total: number }) {
  const pct = total > 0 ? (bucket.count / total) * 100 : 0;
  const barColor =
    bucket.tone === "good"
      ? "bg-emerald-500/80"
      : bucket.tone === "warning"
        ? "bg-amber-500/80"
        : "bg-red-500/70";
  const valueColor =
    bucket.tone === "good"
      ? "text-emerald-600 dark:text-emerald-400"
      : bucket.tone === "warning"
        ? "text-amber-600 dark:text-amber-400"
        : "text-red-600 dark:text-red-400";

  return (
    <li className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="text-foreground/80 truncate">{bucket.label}</span>
        <span className={cn("font-semibold tabular-nums", valueColor)}>
          {bucket.count.toLocaleString()}{" "}
          <span className="text-muted-foreground font-normal text-[10px]">
            ({pct.toFixed(0)}%)
          </span>
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-muted/60 overflow-hidden">
        <div
          className={cn("h-full transition-all", barColor)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[10px] text-muted-foreground leading-snug">
        {bucket.description}
      </p>
    </li>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: React.ReactNode;
  value: string;
  tone: "good" | "muted";
}) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground truncate">
        {label}
      </span>
      <span
        className={cn(
          "text-sm font-semibold tabular-nums",
          tone === "good"
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}
