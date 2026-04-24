"use client";

/**
 * ResultsReport — post-run verdict card that answers three questions
 * in plain English so the operator doesn't have to stitch metrics
 * together in their head:
 *
 *   1. Did we find a real edge?
 *   2. How confident should I be in that finding?
 *   3. What's the best actionable trial (if any)?
 *
 * Inputs come from the run summary + trials table; the heavy lifting
 * (quality classification, best-actionable pick) is delegated to the
 * shared `lib/optimizer/trial-quality.ts` so this card never disagrees
 * with the TrialsTable's quality chips.
 *
 * Rendered on the run detail page only when `run.status === "completed"`.
 */

import * as React from "react";
import {
  AlertTriangle,
  BadgeCheck,
  CircleDashed,
  Flame,
  Info,
  Trophy,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TermTooltip } from "@/components/ui/TermTooltip";
import {
  MIN_SAMPLE_FOR_CREDIT,
  bestActionableTrial,
  classifyTrial,
  topTrialByComposite,
} from "@/lib/optimizer/trial-quality";
import type {
  OptimizationRunRow,
  OptimizationTrialRow,
} from "@/lib/optimizer/repository";

export interface ResultsReportProps {
  run: OptimizationRunRow;
  trials: OptimizationTrialRow[];
}

type Tone = "positive" | "warning" | "danger" | "muted";

interface Row {
  label: React.ReactNode;
  value: React.ReactNode;
  tone: Tone;
  note: React.ReactNode;
}

export function ResultsReport({ run, trials }: ResultsReportProps) {
  const summary = (run.summary as Record<string, unknown> | null) ?? null;

  // ── Classify every trial once ─────────────────────────────────────────
  const classified = React.useMemo(
    () =>
      trials.map((t) => ({
        t,
        q: classifyTrial({
          sampleSize: t.sampleSize ?? null,
          deflatedSharpe: t.deflatedSharpe ?? null,
          oosRoiCiLow: t.oosRoiCiLow ?? null,
          compositeScore: t.compositeScore ?? null,
        }),
      })),
    [trials],
  );
  const nOk = classified.filter((c) => c.q.quality === "ok").length;
  const nLow = classified.filter((c) => c.q.quality === "low").length;
  const nUnreliable = classified.filter(
    (c) => c.q.quality === "unreliable",
  ).length;
  const okPct = trials.length > 0 ? (nOk / trials.length) * 100 : 0;

  const rawWinner = topTrialByComposite(trials);
  const actionableWinner = bestActionableTrial(trials);

  // ── Question 1: Did we find an edge? ──────────────────────────────────
  const edgeVerdict: { tone: Tone; headline: string; detail: string } = (() => {
    if (actionableWinner) {
      return {
        tone: "positive",
        headline: "Yes — at least one trial survived every quality gate.",
        detail: `Trial #${actionableWinner.trialIndex} has n=${actionableWinner.sampleSize ?? "?"}, a DSR of ${actionableWinner.deflatedSharpe?.toFixed(2) ?? "—"}, and a 95% ROI CI entirely above zero. Promote with confidence.`,
      };
    }
    if (nOk === 0 && nLow > 0) {
      return {
        tone: "warning",
        headline:
          "Not yet — nothing crosses the high-confidence bar, but there are hints.",
        detail: `${nLow} trial${nLow === 1 ? "" : "s"} passed the "Low confidence" bar (n≥${MIN_SAMPLE_FOR_CREDIT}, some statistical signal) but none have the n≥100, DSR≥0.8, CI>0 trifecta we need to trust a promotion. Run more trials or widen the search space.`,
      };
    }
    return {
      tone: "danger",
      headline:
        "No — this run didn't find a positive edge in your historical bets.",
      detail:
        "Either the filter ranges we swept exclude the profitable region of your data, the dataset is too small, or there isn't a persistent edge to find at these settings. Try widening the search space or collecting more settled bets before the next run.",
    };
  })();

  // ── Question 2: How confident in those numbers? ──────────────────────
  const pbo =
    typeof summary?.["pbo"] === "number" ? (summary["pbo"] as number) : null;
  const wrc =
    typeof summary?.["wrc_pvalue"] === "number"
      ? (summary["wrc_pvalue"] as number)
      : null;
  const nPareto =
    typeof summary?.["n_pareto"] === "number"
      ? (summary["n_pareto"] as number)
      : null;

  const confidenceRows: Row[] = [
    {
      label: (
        <span className="inline-flex items-center gap-1">
          <TermTooltip term="pbo">PBO (overfit risk)</TermTooltip>
        </span>
      ),
      value: pbo != null ? `${(pbo * 100).toFixed(1)}%` : "—",
      tone:
        pbo == null
          ? "muted"
          : pbo < 0.05
            ? "positive"
            : pbo < 0.3
              ? "warning"
              : "danger",
      note:
        pbo == null
          ? "Not available."
          : pbo < 0.05
            ? "Low overfit risk — the top configs generalise well across CV folds."
            : pbo < 0.3
              ? "Borderline — the winning config didn't dominate every fold. Watch drift once live."
              : "Search space is too aggressive for this dataset. Narrow the dimensions or get more bets.",
    },
    {
      label: (
        <span className="inline-flex items-center gap-1">
          <TermTooltip term="wrc">WRC p-value</TermTooltip>
        </span>
      ),
      value: wrc != null ? wrc.toFixed(3) : "—",
      tone:
        wrc == null
          ? "muted"
          : wrc < 0.05
            ? "positive"
            : wrc < 0.2
              ? "warning"
              : "danger",
      note:
        wrc == null
          ? "Not available."
          : wrc < 0.05
            ? "Winner beats a baseline by more than chance alone would explain."
            : wrc < 0.2
              ? "Weak evidence that the winner beats the baseline — run more trials."
              : "Best trial is statistically indistinguishable from the baseline.",
    },
    {
      label: (
        <span className="inline-flex items-center gap-1">
          <TermTooltip term="pareto">Pareto frontier size</TermTooltip>
        </span>
      ),
      value: nPareto != null ? String(nPareto) : "—",
      tone:
        nPareto == null
          ? "muted"
          : nPareto >= 3
            ? "positive"
            : nPareto >= 1
              ? "warning"
              : "danger",
      note:
        nPareto == null
          ? "Not available."
          : nPareto >= 3
            ? "Multiple configs on the frontier — you can pick ROI-max vs. drawdown-min."
            : nPareto === 1
              ? "Only one config on the frontier — trade-off options are thin."
              : "Empty frontier — no non-dominated configs at all.",
    },
    {
      label: "Trials that passed every gate",
      value: (
        <span className="tabular-nums">
          {nOk} / {trials.length}{" "}
          <span className="text-muted-foreground text-[10px]">
            ({okPct.toFixed(0)}%)
          </span>
        </span>
      ),
      tone: okPct >= 10 ? "positive" : okPct >= 2 ? "warning" : "danger",
      note:
        okPct >= 10
          ? "Healthy pass rate — the search is finding real configs, not just lucky ones."
          : okPct >= 2
            ? "Only a small share of trials pass the confidence bar. Widen the search or run more trials."
            : `${nUnreliable} unreliable trials means the current filter ranges aren't finding an edge in your bets.`,
    },
  ];

  // ── Card ──────────────────────────────────────────────────────────────
  return (
    <section className="rounded-lg border border-border/60 bg-card overflow-hidden">
      <header className="flex items-center gap-2.5 px-5 py-3.5 border-b border-border/60 bg-muted/20">
        <VerdictIcon tone={edgeVerdict.tone} />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Results report</h2>
          <p className="text-xs text-muted-foreground leading-snug mt-0.5">
            What we learned from this run, in plain English.
          </p>
        </div>
      </header>

      <div className="p-5 space-y-5">
        {/* Q1 — edge? */}
        <Block
          eyebrow="1. Did we find a real edge?"
          headline={edgeVerdict.headline}
          headlineTone={edgeVerdict.tone}
          detail={edgeVerdict.detail}
        />

        {/* Q2 — confidence? */}
        <Block
          eyebrow="2. How confident should I be?"
          headline={confidenceHeadline(confidenceRows)}
          headlineTone="muted"
        >
          <ul className="mt-2 divide-y divide-border/60 rounded-md border border-border/60 bg-background/40">
            {confidenceRows.map((r, idx) => (
              <li
                key={idx}
                className="grid grid-cols-[180px_80px_1fr] gap-3 items-start px-3 py-2 text-xs"
              >
                <span className="text-muted-foreground inline-flex items-center gap-1">
                  {r.label}
                </span>
                <span
                  className={cn(
                    "font-semibold tabular-nums",
                    r.tone === "positive" &&
                      "text-emerald-600 dark:text-emerald-400",
                    r.tone === "warning" &&
                      "text-amber-600 dark:text-amber-400",
                    r.tone === "danger" && "text-red-600 dark:text-red-400",
                    r.tone === "muted" && "text-muted-foreground",
                  )}
                >
                  {r.value}
                </span>
                <span className="text-[11px] text-muted-foreground leading-snug">
                  {r.note}
                </span>
              </li>
            ))}
          </ul>
        </Block>

        {/* Q3 — best actionable trial */}
        <Block
          eyebrow="3. What's the best actionable trial?"
          headline={
            actionableWinner
              ? `Trial #${actionableWinner.trialIndex} — promote this one.`
              : "No trial passed the confidence bar. Don't promote anything yet."
          }
          headlineTone={actionableWinner ? "positive" : "warning"}
          detail={
            actionableWinner
              ? `ROI ${fmtPct(actionableWinner.oosRoiMean)} (95% CI ${fmtPct(actionableWinner.oosRoiCiLow)} → ${fmtPct(actionableWinner.oosRoiCiHigh)}), Sharpe ${fmtNum(actionableWinner.oosSharpe)}, DSR ${fmtNum(actionableWinner.deflatedSharpe)}, n=${actionableWinner.sampleSize ?? "?"}. This isn't always the composite-max winner — it's the highest-ranked trial that also passes the n≥100 · DSR≥0.8 · CI>0 gate.`
              : rawWinner
                ? `The composite-max winner (Trial #${rawWinner.trialIndex}) is classified Unreliable. Promoting it would be betting on noise. Run a longer sweep or widen the search before promoting.`
                : undefined
          }
        />
      </div>
    </section>
  );
}

// ── Small pieces ────────────────────────────────────────────────────────

function Block({
  eyebrow,
  headline,
  headlineTone,
  detail,
  children,
}: {
  eyebrow: string;
  headline: string;
  headlineTone: Tone;
  detail?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {eyebrow}
      </div>
      <p
        className={cn(
          "text-sm font-medium leading-snug",
          headlineTone === "positive" &&
            "text-emerald-700 dark:text-emerald-400",
          headlineTone === "warning" && "text-amber-700 dark:text-amber-400",
          headlineTone === "danger" && "text-red-700 dark:text-red-400",
          headlineTone === "muted" && "text-foreground",
        )}
      >
        {headline}
      </p>
      {detail && (
        <p className="text-xs text-muted-foreground leading-relaxed">
          {detail}
        </p>
      )}
      {children}
    </div>
  );
}

function VerdictIcon({ tone }: { tone: Tone }) {
  const Icon =
    tone === "positive"
      ? Trophy
      : tone === "warning"
        ? AlertTriangle
        : tone === "danger"
          ? XCircle
          : CircleDashed;
  const color =
    tone === "positive"
      ? "text-emerald-500"
      : tone === "warning"
        ? "text-amber-500"
        : tone === "danger"
          ? "text-red-500"
          : "text-muted-foreground";
  return <Icon className={cn("size-5 shrink-0", color)} aria-hidden />;
}

function confidenceHeadline(rows: Row[]): string {
  const danger = rows.filter((r) => r.tone === "danger").length;
  const warning = rows.filter((r) => r.tone === "warning").length;
  const positive = rows.filter((r) => r.tone === "positive").length;
  if (danger > 0)
    return "Mixed — one or more confidence checks flagged as problematic.";
  if (warning > 0) return "Cautious — confidence signals are uneven.";
  if (positive >= 3) return "Strong — most confidence checks land green.";
  return "Inconclusive.";
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

/** Banner variant — drops above the TrialsTable when the composite-max
 *  winner is Unreliable. Minimal, loud, actionable. */
export function UnreliableWinnerBanner({ run, trials }: ResultsReportProps) {
  const winner = topTrialByComposite(trials);
  if (!winner) return null;
  const q = classifyTrial({
    sampleSize: winner.sampleSize ?? null,
    deflatedSharpe: winner.deflatedSharpe ?? null,
    oosRoiCiLow: winner.oosRoiCiLow ?? null,
    compositeScore: winner.compositeScore ?? null,
  });
  if (q.quality !== "unreliable") return null;

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3.5 flex items-start gap-3 text-xs text-amber-900 dark:text-amber-200">
      <Flame className="size-4 shrink-0 mt-0.5 text-amber-600" />
      <div className="space-y-1 min-w-0">
        <p className="font-semibold text-amber-800 dark:text-amber-200">
          The top-scoring trial is Unreliable — treat it as noise, not signal
        </p>
        <p className="leading-relaxed text-amber-900/80 dark:text-amber-200/90">
          Trial #{winner.trialIndex} is on top by composite score only because
          the composite rewards small-sample outliers when the field is sparse.{" "}
          <span className="font-medium">Reason:</span> {q.reason}{" "}
          <Info className="inline size-3 -mt-0.5" aria-hidden /> Do not promote
          it. The Results report above flags the first actionable trial if one
          exists.{" "}
          <span className="text-amber-900/70 dark:text-amber-200/70">
            Run ID {run.id.slice(0, 12)}…
          </span>
        </p>
      </div>
      <BadgeCheck className="size-4 shrink-0 mt-0.5 opacity-0" />
    </div>
  );
}
