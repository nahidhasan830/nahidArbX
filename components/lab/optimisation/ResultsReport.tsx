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
      const survived =
        nOk === 1 ? "1 strategy passed" : `${nOk} strategies passed`;
      return {
        tone: "positive",
        headline: `Yes — ${survived} every safety check (out of ${trials.length} tried).`,
        detail: `Strategy #${actionableWinner.trialIndex} won on ${actionableWinner.sampleSize ?? "?"} bets, with strong evidence the result is real skill rather than luck, and even the bottom of its believable range is above zero. Safe to take this one live.`,
      };
    }
    if (nOk === 0 && nLow > 0) {
      return {
        tone: "warning",
        headline:
          "Not yet — nothing crosses the high-confidence bar, but there are hints.",
        detail: `${nLow} strategy${nLow === 1 ? "" : "ies"} survived the lowest bar (at least ${MIN_SAMPLE_FOR_CREDIT} bets and some signal) but none cleared the bar we'd want before going live: 100+ bets, strong evidence it's not luck, and a believable range that stays above zero. Either run more trials or widen the menu of knobs.`,
      };
    }
    return {
      tone: "danger",
      headline:
        "No — this run didn't find a real edge in your historical bets.",
      detail:
        "Either the knob ranges you set rule out the profitable corner of your data, your bet history is too small, or there's no persistent edge here at all. Widen the menu of knobs or collect more settled bets before the next run.",
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
          <TermTooltip term="pbo">Overfit risk (PBO)</TermTooltip>
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
            ? "Looks real — the winning strategies hold up well on bets they were never trained on."
            : pbo < 0.3
              ? "Borderline — the winner didn't dominate every test. Watch the live ROI carefully."
              : "You searched too hard — the winner probably won't survive on new bets. Narrow the menu of knobs or wait for more bets.",
    },
    {
      label: (
        <span className="inline-flex items-center gap-1">
          <TermTooltip term="wrc">Beats baseline (WRC)</TermTooltip>
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
            ? "The winner clearly beats the dumb 'bet everything' baseline."
            : wrc < 0.2
              ? "Slim margin over the baseline — run a longer search before promoting."
              : "The winner isn't really beating a 'bet everything' fallback. Don't promote.",
    },
    {
      label: (
        <span className="inline-flex items-center gap-1">
          <TermTooltip term="pareto">Trade-off options</TermTooltip>
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
            ? "Several strategies to choose from — you can pick higher ROI or smaller drawdown."
            : nPareto === 1
              ? "Only one strategy worth considering."
              : "Nothing worth considering.",
    },
    {
      label: "Strategies that passed every check",
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
          ? "Healthy pass rate — the search is finding real strategies, not just lucky ones."
          : okPct >= 2
            ? "Only a small share survive every check. Widen the search or run more trials."
            : `${nUnreliable} unreliable strategies means the current knob ranges aren't finding an edge in your bets.`,
    },
  ];

  // ── Card ──────────────────────────────────────────────────────────────
  return (
    <section className="rounded-lg border border-border/60 bg-card overflow-hidden">
      <header className="flex items-center gap-2.5 px-5 py-3.5 border-b border-border/60 bg-muted/20">
        <VerdictIcon tone={edgeVerdict.tone} />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Results report</h2>
          <p className="text-[13px] text-muted-foreground leading-snug mt-0.5">
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
                className="grid grid-cols-[180px_80px_1fr] gap-3 items-start px-3 py-2 text-[13px]"
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
                <span className="text-[13px] text-muted-foreground leading-snug">
                  {r.note}
                </span>
              </li>
            ))}
          </ul>
        </Block>

        {/* Q3 — best actionable trial */}
        <Block
          eyebrow="3. What's the best strategy to take live?"
          headline={
            actionableWinner
              ? `Strategy #${actionableWinner.trialIndex} — promote this one.`
              : "No strategy passed the safety bar. Don't promote anything yet."
          }
          headlineTone={actionableWinner ? "positive" : "warning"}
          detail={
            actionableWinner
              ? `ROI ${fmtPct(actionableWinner.oosRoiMean)} on ${actionableWinner.sampleSize ?? "?"} bets (believable range ${fmtPct(actionableWinner.oosRoiCiLow)} to ${fmtPct(actionableWinner.oosRoiCiHigh)}). This isn't always the highest-scoring trial — it's the highest-scoring one that also passed the safety bar (100+ bets, strong evidence it's not luck, believable range above zero).`
              : rawWinner
                ? `The top-scoring strategy (#${rawWinner.trialIndex}) didn't pass the safety bar — promoting it would be betting on noise. Run a longer search or widen the menu of knobs before promoting.`
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
        <p className="text-[13px] text-muted-foreground leading-relaxed">
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
  if (danger > 0) return "Mixed — one or more safety checks came back red.";
  if (warning > 0) return "Cautious — the safety checks are uneven.";
  if (positive >= 3) return "Strong — most safety checks land green.";
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
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3.5 flex items-start gap-3 text-[13px] text-amber-900 dark:text-amber-200">
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
