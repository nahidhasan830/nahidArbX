"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Sparkles,
  Loader2,
  Info,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  HelpCircle,
  TrendingUp,
  TrendingDown,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import { useProposeRules } from "@/lib/backtest/hooks";
import type {
  ProposeHeadlineInput,
  ProposeResponse,
  ProposeSliceInput,
} from "@/lib/backtest/api-client";
import { computeStrategyMetrics, STRATEGIES } from "@/lib/backtest/analyze";
import { derive, settlementPnl } from "@/lib/backtest/derive";
import {
  bhAdjust,
  brierScore,
  logLoss,
  maxDrawdown,
  meanCi95,
  reliabilityBuckets,
  shrinkToward,
  sortino,
  summarizeClv,
  ulcerIndex,
  valueForDimension,
  walkForwardSplit,
  wilsonCi95,
  winZScore,
  zToPValue,
  type PivotDimension,
} from "@/lib/backtest/metrics";
import { hasPnl, type ValueBetRow } from "@/lib/backtest/types";
import { ProposedRulesDialog } from "./ProposedRulesDialog";
import { formatMarketType, formatAtomLabel } from "@/lib/formatting/labels";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  rows: ValueBetRow[];
  scope: "selected" | "all";
  /** True while the parent is still fetching the full dataset for scope="all". */
  loading?: boolean;
  /** Progress reporter for the parent's paged fetch. */
  loadingProgress?: { loaded: number; total: number | null } | null;
  /** Historical in-play rows that were silently excluded by the parent. */
  excludedInPlayCount?: number;
};

const fmtPct = (n: number | null, signed = false, digits = 1): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  const s = signed && n > 0 ? "+" : "";
  return `${s}${n.toFixed(digits)}%`;
};

const fmtNum = (n: number | null, digits = 2): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
};

const signedClass = (n: number | null): string => {
  if (n == null) return "text-muted-foreground";
  if (n > 0) return "text-emerald-400";
  if (n < 0) return "text-rose-400";
  return "text-foreground";
};

// ─────────────────────────────────────────────────────────────────
// Headline tab — plain-English first; raw stats collapsed behind a toggle.
// Designed so a non-technical user can read the top 3 sections and know:
//   1. Am I making money?   2. Is the edge real?   3. What should I do next?
// ─────────────────────────────────────────────────────────────────

type VerdictTone = "green" | "yellow" | "red" | "gray";
type Verdict = { tone: VerdictTone; headline: string; detail: string };

function HeadlineTab({ rows }: { rows: ValueBetRow[] }) {
  const flat = useMemo(() => computeStrategyMetrics(rows, "flat"), [rows]);
  const clv = useMemo(() => summarizeClv(rows), [rows]);
  const sort = useMemo(() => sortino(rows), [rows]);
  const ulcer = useMemo(() => ulcerIndex(rows), [rows]);
  const maxDD = useMemo(() => maxDrawdown(rows), [rows]);
  const z = useMemo(() => winZScore(rows), [rows]);
  const p = z == null ? null : zToPValue(z);
  const brier = useMemo(() => brierScore(rows), [rows]);
  const ll = useMemo(() => logLoss(rows), [rows]);

  const decided = flat.wins + flat.losses;
  const winRate = decided > 0 ? (flat.wins / decided) * 100 : null;

  const { roiCiPct, winRateCiPct } = useMemo(() => {
    const perBetRoi: number[] = [];
    for (const r of rows) {
      if (r.outcome === "won" || r.outcome === "lost") {
        perBetRoi.push(settlementPnl(r, 1));
      } else if (r.outcome === "half_won" || r.outcome === "half_lost") {
        perBetRoi.push(settlementPnl(r, 1) / 0.5);
      }
    }
    const roiHw = meanCi95(perBetRoi);
    const wrHw = wilsonCi95(flat.wins, flat.wins + flat.losses);
    return {
      roiCiPct: roiHw != null ? roiHw * 100 : null,
      winRateCiPct: wrHw != null ? wrHw * 100 : null,
    };
  }, [rows, flat.wins, flat.losses]);

  // Verdict — the single most important plain-English summary. Drives the
  // colour of the banner and the tone of the recommendations.
  const verdict: Verdict = useMemo(() => {
    if (clv.withClosing < 30 || clv.meanPct == null) {
      return {
        tone: "gray",
        headline: "Not enough closing-line data yet",
        detail: `Need ${Math.max(0, 30 - clv.withClosing)} more bets with Pinnacle closing odds to evaluate edge. Keep the system running — closing capture fires automatically around kickoff.`,
      };
    }
    const hw = clv.meanCiHalfWidthPct ?? Infinity;
    const lo = clv.meanPct - hw;
    const hi = clv.meanPct + hw;
    if (lo > 0) {
      return {
        tone: "green",
        headline: "Plausible edge detected",
        detail: `You're consistently beating Pinnacle's closing price by ${clv.meanPct.toFixed(1)}%. The 95% confidence range (${lo.toFixed(1)}% to ${hi.toFixed(1)}%) stays positive — this is real signal, not luck.`,
      };
    }
    if (hi < 0) {
      return {
        tone: "red",
        headline: "System may be losing long-run edge",
        detail: `Your entry prices are worse than Pinnacle's close by ${Math.abs(clv.meanPct).toFixed(1)}% on average. The 95% confidence range stays negative — this isn't a bad run, it's a consistent loss. Review the "What to watch" section below.`,
      };
    }
    return {
      tone: "yellow",
      headline: "Too early to tell",
      detail: `Mean CLV is ${clv.meanPct >= 0 ? "+" : ""}${clv.meanPct.toFixed(1)}%, but the 95% confidence range (${lo.toFixed(1)}% to ${hi.toFixed(1)}%) crosses zero. You need more closing-line data before the edge is statistically distinguishable from noise.`,
    };
  }, [clv]);

  // Data readiness — how far along we are toward statistically-reliable conclusions.
  const readiness = useMemo(() => {
    const CLOSING_TARGET = 100;
    const DECIDED_TARGET = 500;
    const closingProgress = Math.min(1, clv.withClosing / CLOSING_TARGET);
    const decidedProgress = Math.min(1, decided / DECIDED_TARGET);
    // We need both — CLV and outcome-based metrics are orthogonal signals.
    const pct = Math.min(closingProgress, decidedProgress) * 100;
    let label: string;
    if (pct < 10) label = "Very early — treat every number with skepticism";
    else if (pct < 50) label = "Accumulating — trends emerging but not firm";
    else if (pct < 90) label = "Getting reliable — CIs are tightening";
    else label = "Mature — conclusions are trustworthy";
    return {
      pct,
      label,
      closingNeeded: Math.max(0, CLOSING_TARGET - clv.withClosing),
      decidedNeeded: Math.max(0, DECIDED_TARGET - decided),
    };
  }, [clv.withClosing, decided]);

  // Market breakdown — "what's working" / "what to watch"
  const markets = useMemo(() => {
    type Agg = {
      marketType: string;
      n: number;
      decided: number;
      wins: number;
      losses: number;
      roiPct: number | null;
      roiCiHw: number | null;
      clvMean: number | null;
      clvN: number;
    };
    const byMarket = new Map<string, ValueBetRow[]>();
    for (const r of rows) {
      const list = byMarket.get(r.marketType) ?? [];
      list.push(r);
      byMarket.set(r.marketType, list);
    }
    const out: Agg[] = [];
    for (const [marketType, bucket] of byMarket) {
      const dec = bucket.filter(
        (r) =>
          r.outcome === "won" ||
          r.outcome === "lost" ||
          r.outcome === "half_won" ||
          r.outcome === "half_lost",
      );
      const w = dec.filter(
        (r) => r.outcome === "won" || r.outcome === "half_won",
      ).length;
      const l = dec.filter(
        (r) => r.outcome === "lost" || r.outcome === "half_lost",
      ).length;
      const perBet: number[] = [];
      let staked = 0;
      let returned = 0;
      for (const r of dec) {
        const fullStake = r.outcome === "won" || r.outcome === "lost";
        const stake = fullStake ? 1 : 0.5;
        staked += stake;
        const pnl = settlementPnl(r, 1);
        returned += pnl;
        perBet.push(fullStake ? pnl : pnl / 0.5);
      }
      const roiPct = staked > 0 ? (returned / staked) * 100 : null;
      const roiHw = meanCi95(perBet);
      const clvVals = bucket
        .filter((r) => r.closingSharpOdds != null)
        .map((r) => (r.softOddsFirst / r.closingSharpOdds! - 1) * 100);
      const clvMean =
        clvVals.length > 0
          ? clvVals.reduce((a, b) => a + b, 0) / clvVals.length
          : null;
      out.push({
        marketType,
        n: bucket.length,
        decided: dec.length,
        wins: w,
        losses: l,
        roiPct,
        roiCiHw: roiHw != null ? roiHw * 100 : null,
        clvMean,
        clvN: clvVals.length,
      });
    }
    const MIN_SAMPLE = 20;
    const ranked = out.filter((m) => m.decided >= MIN_SAMPLE);
    const working = [...ranked]
      .filter((m) => (m.clvMean ?? m.roiPct ?? 0) > 0)
      .sort(
        (a, b) => (b.clvMean ?? b.roiPct ?? 0) - (a.clvMean ?? a.roiPct ?? 0),
      )
      .slice(0, 3);
    const watching = [...ranked]
      .filter((m) => (m.clvMean ?? m.roiPct ?? 0) < 0)
      .sort(
        (a, b) => (a.clvMean ?? a.roiPct ?? 0) - (b.clvMean ?? b.roiPct ?? 0),
      )
      .slice(0, 3);
    return { working, watching, hasUnderSampled: out.length > ranked.length };
  }, [rows]);

  // Auto-generated recommendations from verdict + readiness + market signal.
  const recommendations = useMemo(() => {
    const recs: string[] = [];
    if (verdict.tone === "green") {
      recs.push(
        "Keep the system running. Don't scale up stakes yet — wait for the confidence range to tighten further.",
      );
    } else if (verdict.tone === "red") {
      recs.push(
        "Pause or audit before placing more real money. Something structural is off — check the 'What to watch' markets first.",
      );
    } else if (verdict.tone === "yellow") {
      recs.push(
        "Let the system keep running. Don't draw conclusions yet — variance on small samples is wild.",
      );
    } else {
      recs.push(
        "Keep running the system and wait for closing-line data to accumulate. No conclusions possible yet.",
      );
    }
    if (markets.working.length > 0 && verdict.tone !== "red") {
      const top = markets.working[0];
      recs.push(
        `Your strongest slice is ${top.marketType} — ${top.clvMean != null ? `+${top.clvMean.toFixed(1)}% CLV` : `${top.roiPct!.toFixed(1)}% ROI`} on ${top.decided} settled bets. If you filter or prioritise, start there.`,
      );
    }
    if (markets.watching.length > 0 && markets.watching[0].decided >= 50) {
      const worst = markets.watching[0];
      recs.push(
        `Consider excluding ${worst.marketType} — ${worst.clvMean != null ? `${worst.clvMean.toFixed(1)}% CLV` : `${worst.roiPct!.toFixed(1)}% ROI`} on ${worst.decided} settled bets suggests this market is actively costing you.`,
      );
    }
    if (readiness.decidedNeeded > 0) {
      recs.push(
        `Data collection: ${readiness.decidedNeeded} more settled bets needed for high-confidence conclusions (currently ${decided}/${decided + readiness.decidedNeeded}).`,
      );
    }
    return recs.slice(0, 4);
  }, [verdict, markets, readiness, decided]);

  const fmtCi = (hw: number | null, unit = "pp"): string | undefined =>
    hw == null ? undefined : `±${hw.toFixed(1)}${unit} · 95% CI`;
  const signedClassWithCi = (
    value: number | null,
    halfWidth: number | null,
  ): string => {
    if (value == null) return "text-muted-foreground";
    if (halfWidth == null) return signedClass(value);
    if (value - halfWidth > 0) return "text-emerald-400";
    if (value + halfWidth < 0) return "text-rose-400";
    return "text-muted-foreground";
  };

  return (
    <div className="space-y-4">
      {/* 1. Verdict banner */}
      <VerdictBanner verdict={verdict} />

      {/* 2. Plain-English KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        <PlainKpi
          question="Are you making money?"
          value={
            flat.settledBets > 0 ? fmtPct(flat.roiPct, true, 1) : "No data yet"
          }
          valueClass={signedClassWithCi(
            flat.settledBets > 0 ? flat.roiPct : null,
            roiCiPct,
          )}
          context={
            flat.settledBets > 0
              ? `Per unit staked, on ${flat.settledBets} settled bets. ${fmtCi(roiCiPct) ?? ""}`
              : "Place some bets and wait for them to settle."
          }
          footnote={
            roiCiPct != null && roiCiPct > 15
              ? "⚠ Wide confidence range — number could swing a lot with more data."
              : undefined
          }
        />
        <PlainKpi
          question="Is the edge real?"
          value={
            clv.withClosing > 0
              ? fmtPct(clv.meanPct, true, 1)
              : "No closing data"
          }
          valueClass={signedClassWithCi(clv.meanPct, clv.meanCiHalfWidthPct)}
          context={
            clv.withClosing > 0
              ? `Your entry price vs Pinnacle's closing line. Based on ${clv.withClosing} bets. ${fmtCi(clv.meanCiHalfWidthPct) ?? ""}`
              : "Closing odds captured automatically around kickoff. Keep running."
          }
          footnote={
            clv.withClosing > 0 && clv.withClosing < 30
              ? "⚠ Small sample — don't trust this number yet."
              : undefined
          }
        />
        <PlainKpi
          question="How often do you win?"
          value={winRate != null ? fmtPct(winRate, false, 1) : "—"}
          valueClass="text-foreground"
          context={
            decided > 0
              ? `${flat.wins} wins, ${flat.losses} losses. ${fmtCi(winRateCiPct) ?? ""}`
              : "No settled bets yet."
          }
          footnote="Win rate alone doesn't tell you if you're profitable — read alongside ROI."
        />
        <ReadinessKpi readiness={readiness} />
      </div>

      {/* 3. What's working / What to watch */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <MarketPanel
          tone="working"
          title="What's working"
          markets={markets.working}
          emptyText="No markets have a clear positive signal yet. Keep collecting data."
        />
        <MarketPanel
          tone="watching"
          title="What to watch"
          markets={markets.watching}
          emptyText="Nothing is clearly costing you money right now. ✓"
        />
      </div>

      {/* 4. Supporting metrics — non-duplicated technical values, each with
          a plain-English explanation in the tooltip (hover the ⓘ icon). The
          four primary KPIs above already cover ROI, Mean CLV, Win rate, and
          data readiness, so these are the supporting signals that add depth
          without repeating values. */}
      <section>
        <SectionHeader title="Supporting metrics — hover each for a plain-English explanation" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Metric
            label="Median CLV"
            value={fmtPct(clv.medianPct, true, 2)}
            valueClassName={signedClass(clv.medianPct)}
            explain={{
              what: "The middle CLV value — half your bets beat it, half are below. Not affected by a few huge outliers.",
              example:
                "If mean CLV is +6% but median is +1%, a few freak bets are inflating the average — the typical bet isn't as strong as the mean suggests.",
            }}
          />
          <Metric
            label="Beat-close rate"
            value={fmtPct(clv.beatRatePct, false, 0)}
            ci={fmtCi(clv.beatRateCiHalfWidthPct)}
            sub="target > 55%"
            explain={{
              what: "Percentage of bets where your entry price beat the closing line. A sustained rate above 55% on a decent sample is real edge.",
              example: "100% on 6 bets is noise. 58% on 500 bets is signal.",
            }}
          />
          <Metric
            label="Max DD · Ulcer"
            value={`${fmtNum(maxDD, 1)} · ${fmtNum(ulcer, 2)}`}
            sub="flat 1u equity units"
            explain={{
              what: "Max DD = worst peak-to-trough drop of your equity curve, in units. Ulcer Index = how painful the drawdowns felt on average (long grinding losses score worse than one sharp drop).",
              example:
                "Max DD of 8u means at some point your equity was 8 units below its prior peak. Two strategies with the same ROI but different Ulcer values feel very different to bet with.",
            }}
          />
          <Metric
            label="Sortino"
            value={fmtNum(sort, 2)}
            sub=">0.5 good · >1 excellent"
            explain={{
              what: "Reward per unit of downside risk. Like the Sharpe ratio but only penalises losing variance — upside volatility doesn't hurt the score.",
              formula: "Sortino = mean_return ÷ stdev(losses)",
              example:
                "+5% ROI with a smooth curve → high Sortino. +5% ROI with a big mid-period drawdown → low Sortino. Higher is better.",
            }}
          />
          <Metric
            label="z (wins vs expected)"
            value={fmtNum(z, 2)}
            sub="|z|<2 noise · >3 signal"
            valueClassName={
              z == null
                ? ""
                : Math.abs(z) > 3
                  ? "text-emerald-400"
                  : Math.abs(z) > 2
                    ? "text-amber-300"
                    : "text-muted-foreground"
            }
            explain={{
              what: "How many standard deviations your actual wins are away from what Pinnacle's probabilities predicted. Positive = you win more than expected.",
              example:
                "Pinnacle said you'd win 50 of 100; you won 65 → z ≈ +3.0, very unlikely to be luck. z = −0.3 means you're basically on the expected line.",
            }}
          />
          <Metric
            label="p-value"
            value={p == null ? "—" : p < 0.001 ? "<0.001" : p.toFixed(3)}
            explain={{
              what: "The probability of seeing results this extreme by pure chance if Pinnacle's predictions are correct. Lower = more likely there's a real edge.",
              example:
                "p = 0.03 → only a 3% chance this is random luck. p = 0.76 → almost certainly within normal variance; don't get excited yet.",
            }}
          />
          <Metric
            label="Brier score"
            value={fmtNum(brier, 3)}
            sub="lower = better calibrated"
            explain={{
              what: "How accurate Pinnacle's probability predictions are vs. what actually happened. Measures calibration quality of the sharp reference.",
              example:
                "0 = perfect forecaster. 0.25 = always guessing 50/50 with no info. Below 0.22 is a well-calibrated sharp book.",
            }}
          />
          <Metric
            label="Log loss"
            value={fmtNum(ll, 3)}
            sub="lower = better calibrated"
            explain={{
              what: "Another calibration score. Penalises confidently-wrong predictions much more harshly than Brier — useful as a cross-check.",
              example:
                "0.69 is the baseline (random coin flip). Below that means the probabilities carry real information; above means they're actively misleading.",
            }}
          />
        </div>
      </section>

      {/* 5. Recommendations — the action payoff, placed last so all signals
          are in view before the user reads what to do. */}
      <div className="rounded-md border border-border bg-muted/20 p-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
          What to do next
        </div>
        <ol className="space-y-1.5 text-[13px] leading-relaxed">
          {recommendations.map((rec, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-muted-foreground font-medium tabular-nums">
                {i + 1}.
              </span>
              <span>{rec}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Headline sub-components
// ─────────────────────────────────────────────────────────────────

function VerdictBanner({ verdict }: { verdict: Verdict }) {
  const palette: Record<
    VerdictTone,
    { bg: string; border: string; text: string; Icon: typeof CheckCircle2 }
  > = {
    green: {
      bg: "bg-emerald-500/10",
      border: "border-emerald-500/40",
      text: "text-emerald-400",
      Icon: CheckCircle2,
    },
    red: {
      bg: "bg-rose-500/10",
      border: "border-rose-500/40",
      text: "text-rose-400",
      Icon: AlertCircle,
    },
    yellow: {
      bg: "bg-amber-500/10",
      border: "border-amber-500/40",
      text: "text-amber-400",
      Icon: AlertTriangle,
    },
    gray: {
      bg: "bg-muted/40",
      border: "border-border",
      text: "text-muted-foreground",
      Icon: HelpCircle,
    },
  };
  const p = palette[verdict.tone];
  const Icon = p.Icon;
  return (
    <div
      className={cn(
        "rounded-md border-2 px-4 py-3 flex gap-3 items-start",
        p.bg,
        p.border,
      )}
    >
      <Icon className={cn("size-5 mt-0.5 shrink-0", p.text)} />
      <div className="flex-1 min-w-0">
        <div className={cn("font-semibold text-sm", p.text)}>
          {verdict.headline}
        </div>
        <div className="text-[12px] text-foreground/80 mt-0.5 leading-relaxed">
          {verdict.detail}
        </div>
      </div>
    </div>
  );
}

function PlainKpi({
  question,
  value,
  valueClass,
  context,
  footnote,
}: {
  question: string;
  value: string;
  valueClass?: string;
  context: string;
  footnote?: string;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/20 px-3 py-2.5">
      <div className="text-[11px] text-muted-foreground font-medium">
        {question}
      </div>
      <div
        className={cn(
          "text-2xl font-semibold tabular-nums leading-tight mt-1",
          valueClass,
        )}
      >
        {value}
      </div>
      <div className="text-[10px] text-muted-foreground/90 mt-1 leading-snug">
        {context}
      </div>
      {footnote && (
        <div className="text-[10px] text-amber-400/90 mt-1 leading-snug">
          {footnote}
        </div>
      )}
    </div>
  );
}

function ReadinessKpi({
  readiness,
}: {
  readiness: {
    pct: number;
    label: string;
    closingNeeded: number;
    decidedNeeded: number;
  };
}) {
  return (
    <div className="rounded-md border border-border bg-muted/20 px-3 py-2.5">
      <div className="text-[11px] text-muted-foreground font-medium">
        How reliable is this data?
      </div>
      <div className="text-2xl font-semibold tabular-nums leading-tight mt-1">
        {Math.round(readiness.pct)}%
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full bg-primary transition-all duration-500 ease-out"
          style={{ width: `${readiness.pct}%` }}
        />
      </div>
      <div className="text-[10px] text-muted-foreground/90 mt-1 leading-snug">
        {readiness.label}
      </div>
      {readiness.decidedNeeded > 0 && (
        <div className="text-[10px] text-muted-foreground/80 mt-0.5 leading-snug">
          {readiness.decidedNeeded} more settled bets for high confidence.
        </div>
      )}
    </div>
  );
}

type MarketAgg = {
  marketType: string;
  n: number;
  decided: number;
  wins: number;
  losses: number;
  roiPct: number | null;
  roiCiHw: number | null;
  clvMean: number | null;
  clvN: number;
};

function MarketPanel({
  tone,
  title,
  markets,
  emptyText,
}: {
  tone: "working" | "watching";
  title: string;
  markets: MarketAgg[];
  emptyText: string;
}) {
  const Icon = tone === "working" ? TrendingUp : TrendingDown;
  const toneClass = tone === "working" ? "text-emerald-400" : "text-rose-400";
  return (
    <div className="rounded-md border border-border bg-muted/20 p-3">
      <div className="flex items-center gap-1.5 mb-2">
        <Icon className={cn("size-3.5", toneClass)} />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
      </div>
      {markets.length === 0 ? (
        <div className="text-[12px] text-muted-foreground py-2">
          {emptyText}
        </div>
      ) : (
        <ul className="space-y-2">
          {markets.map((m) => {
            const primary =
              m.clvMean != null
                ? { label: "CLV", value: m.clvMean }
                : m.roiPct != null
                  ? { label: "ROI", value: m.roiPct }
                  : null;
            if (!primary) return null;
            return (
              <li key={m.marketType} className="flex items-baseline gap-2">
                <span
                  className={cn(
                    "text-sm font-semibold tabular-nums min-w-[4.5rem]",
                    toneClass,
                  )}
                >
                  {primary.value >= 0 ? "+" : ""}
                  {primary.value.toFixed(1)}%
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium truncate">
                    {m.marketType}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {primary.label} on{" "}
                    {m.clvMean != null
                      ? `${m.clvN} closing`
                      : `${m.decided} settled`}{" "}
                    bets · {m.wins}W / {m.losses}L
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Calibration tab — reliability diagram
// ─────────────────────────────────────────────────────────────────

function CalibrationTab({ rows }: { rows: ValueBetRow[] }) {
  const buckets = useMemo(() => reliabilityBuckets(rows), [rows]);
  const total = buckets.reduce((s, b) => s + b.n, 0);

  if (total < 30) {
    return (
      <div className="text-[12px] text-muted-foreground py-8 text-center">
        Not enough settled bets for a reliable diagram (need &ge;30, have{" "}
        {total}).
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <SectionHeader
        title={`Reliability — predicted vs realized hit rate (${total} settled)`}
      />
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Bucket</TableHead>
              <TableHead className="text-right">N</TableHead>
              <TableHead className="text-right">Predicted</TableHead>
              <TableHead className="text-right">Realized</TableHead>
              <TableHead className="text-right">Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {buckets.map((b, i) => {
              const err = b.realizedHitRate - b.predictedMean;
              return (
                <TableRow key={i}>
                  <TableCell className="text-[12px]">{b.label}</TableCell>
                  <TableCell className="text-right tabular-nums text-[12px]">
                    {b.n}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-[12px] text-muted-foreground">
                    {b.n === 0 ? "—" : (b.predictedMean * 100).toFixed(1) + "%"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-[12px]">
                    {b.n === 0
                      ? "—"
                      : (b.realizedHitRate * 100).toFixed(1) + "%"}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums text-[12px]",
                      signedClass(b.n === 0 ? null : err),
                    )}
                  >
                    {b.n === 0
                      ? "—"
                      : `${err > 0 ? "+" : ""}${(err * 100).toFixed(1)} pp`}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-[10px] text-muted-foreground/80">
        Perfect calibration: realized = predicted within each bucket. Systematic
        positive errors on the low-probability rows = longshot overpricing in
        your favour. Systematic negative errors on the high-probability rows =
        favourites overbet.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Bets tab — the raw rows feeding every metric, so users can verify
// the sample matches their expectation.
// ─────────────────────────────────────────────────────────────────

const OUTCOME_BADGE: Record<string, string> = {
  won: "text-emerald-400",
  half_won: "text-emerald-400",
  lost: "text-rose-400",
  half_lost: "text-rose-400",
  void: "text-muted-foreground",
  pending: "text-amber-300",
};

function BetsTab({ rows }: { rows: ValueBetRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="text-[12px] text-muted-foreground py-8 text-center">
        No bets in the current analysis set.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <SectionHeader title={`Bets feeding this analysis (${rows.length})`} />
        <span className="text-[10px] text-muted-foreground">
          Scroll — all rows listed; every metric is computed from exactly this
          set.
        </span>
      </div>
      <div className="rounded-md border max-h-[520px] overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 bg-background z-10">
            <TableRow>
              <TableHead>Event</TableHead>
              <TableHead>Market</TableHead>
              <TableHead>Side</TableHead>
              <TableHead className="text-right">Entry</TableHead>
              <TableHead className="text-right">Close</TableHead>
              <TableHead className="text-right">CLV</TableHead>
              <TableHead className="text-right">EV%</TableHead>
              <TableHead className="text-right">Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const clv =
                r.closingSharpOdds != null
                  ? (r.softOddsFirst / r.closingSharpOdds - 1) * 100
                  : null;
              const ev = derive(r).evPctFirst;
              return (
                <TableRow key={r.id}>
                  <TableCell className="text-[11px]">
                    <div className="flex flex-col">
                      <span className="font-medium">
                        {r.homeTeam} vs {r.awayTeam}
                      </span>
                      {r.competition && (
                        <span className="text-[10px] text-muted-foreground">
                          {r.competition}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-[11px] text-muted-foreground">
                    {formatMarketType(r.marketType)}
                  </TableCell>
                  <TableCell className="text-[11px]">{formatAtomLabel(r.atomLabel)}</TableCell>
                  <TableCell className="text-right tabular-nums text-[11px] font-medium">
                    {r.softOddsFirst.toFixed(2)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-[11px] text-muted-foreground">
                    {r.closingSharpOdds?.toFixed(2) ?? "—"}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums text-[11px]",
                      signedClass(clv),
                    )}
                  >
                    {clv == null ? "—" : fmtPct(clv, true, 1)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums text-[11px]",
                      signedClass(ev),
                    )}
                  >
                    {fmtPct(ev, true, 1)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right text-[11px] uppercase tracking-wider",
                      OUTCOME_BADGE[r.outcome] ?? "text-muted-foreground",
                    )}
                  >
                    {r.outcome}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Strategies tab (staking comparison — all 5 strategies)
// ─────────────────────────────────────────────────────────────────

function StrategiesComparisonTab({ rows }: { rows: ValueBetRow[] }) {
  const all = useMemo(
    () => STRATEGIES.map((s) => computeStrategyMetrics(rows, s.id)),
    [rows],
  );
  return (
    <div className="space-y-3">
      <SectionHeader title="Staking strategies — flat 1u vs Kelly variants vs EV-proportional" />
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Strategy</TableHead>
              <TableHead className="text-right">Staked</TableHead>
              <TableHead className="text-right">Return</TableHead>
              <TableHead className="text-right">ROI</TableHead>
              <TableHead className="text-right">Max DD</TableHead>
              <TableHead className="text-right">Settled</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {all.map((s) => (
              <TableRow key={s.strategy}>
                <TableCell className="text-[12px]">{s.label}</TableCell>
                <TableCell className="text-right tabular-nums text-[12px]">
                  {s.totalStaked.toFixed(2)}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right tabular-nums text-[12px]",
                    signedClass(s.totalReturn),
                  )}
                >
                  {s.totalReturn >= 0 ? "+" : ""}
                  {s.totalReturn.toFixed(2)}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right tabular-nums text-[12px] font-medium",
                    signedClass(s.settledBets > 0 ? s.roiPct : null),
                  )}
                >
                  {s.settledBets > 0 ? fmtPct(s.roiPct, true, 1) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums text-[12px] text-muted-foreground">
                  {s.maxDrawdown.toFixed(2)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-[12px]">
                  {s.settledBets}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-[10px] text-muted-foreground/80">
        Full Kelly maximises log growth but doubles drawdowns if your edge
        estimate is off by half. Pros almost universally pick ¼ or ½ Kelly.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Pivot tab — group-by + then-by with shrinkage, z, BH-FDR
// ─────────────────────────────────────────────────────────────────

const DIMENSION_OPTIONS: { value: PivotDimension | "none"; label: string }[] = [
  { value: "none", label: "— none —" },
  { value: "marketType", label: "Market" },
  { value: "softProvider", label: "Soft provider" },
  { value: "timeScope", label: "Time scope" },
  { value: "atomId", label: "Atom / side" },
  { value: "competition", label: "Competition" },
  { value: "evBucket", label: "EV bucket" },
  { value: "oddsBucket", label: "Odds bucket" },
  { value: "tickBucket", label: "Tick-count bucket" },
  { value: "hoursToKickoffBucket", label: "Hours to kickoff" },
  { value: "familyLine", label: "Family line" },
];

type PivotCell = {
  primary: string;
  secondary: string;
  n: number;
  wins: number;
  losses: number;
  pendings: number;
  roiPct: number | null;
  shrunkRoiPct: number | null;
  avgEvPct: number;
  clvPct: number | null;
  z: number | null;
  p: number | null;
  pAdj: number | null;
};

function PivotTab({
  rows,
  testOnly,
  onTestOnlyChange,
  onPropose,
  proposeLoading,
  headline,
}: {
  rows: ValueBetRow[];
  testOnly: boolean;
  onTestOnlyChange: (v: boolean) => void;
  onPropose: (
    slices: ProposeSliceInput[],
    headline: ProposeHeadlineInput,
  ) => void;
  proposeLoading: boolean;
  headline: ProposeHeadlineInput;
}) {
  const [primary, setPrimary] = useState<PivotDimension>("marketType");
  const [secondary, setSecondary] = useState<PivotDimension | "none">("none");

  const scopedRows = useMemo(() => {
    if (!testOnly) return rows;
    return walkForwardSplit(rows, 0.3).test;
  }, [rows, testOnly]);

  const populationRoi = useMemo(() => {
    // Any row with P&L (won, lost, half_won, half_lost) contributes.
    // Half outcomes use 0.5 stake since the other half pushed.
    const settled = scopedRows.filter((r) => hasPnl(r.outcome));
    if (settled.length === 0) return 0;
    let staked = 0;
    let returned = 0;
    for (const r of settled) {
      const stake =
        r.outcome === "half_won" || r.outcome === "half_lost" ? 0.5 : 1;
      staked += stake;
      returned += settlementPnl(r, 1);
    }
    return staked > 0 ? (returned / staked) * 100 : 0;
  }, [scopedRows]);

  const cells: PivotCell[] = useMemo(() => {
    type Bucket = {
      primary: string;
      secondary: string;
      rows: ValueBetRow[];
    };
    const groups = new Map<string, Bucket>();
    for (const r of scopedRows) {
      const p = valueForDimension(r, primary);
      const s =
        secondary === "none"
          ? ""
          : valueForDimension(r, secondary as PivotDimension);
      const key = `${p}‖${s}`;
      let b = groups.get(key);
      if (!b) {
        b = { primary: p, secondary: s, rows: [] };
        groups.set(key, b);
      }
      b.rows.push(r);
    }

    const built: PivotCell[] = [];
    const rawPs: (number | null)[] = [];

    for (const b of groups.values()) {
      let wins = 0;
      let losses = 0;
      let pendings = 0;
      let staked = 0;
      let returned = 0;
      let evSum = 0;
      let clvSum = 0;
      let clvN = 0;

      for (const r of b.rows) {
        // Half-wins count as 0.5 of a win; half-losses as 0.5 of a loss.
        if (r.outcome === "won") wins++;
        else if (r.outcome === "half_won") wins += 0.5;
        else if (r.outcome === "lost") losses++;
        else if (r.outcome === "half_lost") losses += 0.5;
        else if (r.outcome === "pending") pendings++;

        evSum += derive(r).evPctFirst;

        if (r.closingSharpOdds != null) {
          clvSum += r.softOddsFirst / r.closingSharpOdds - 1;
          clvN++;
        }

        if (r.outcome === "won" || r.outcome === "lost") {
          staked += 1;
          returned += settlementPnl(r, 1);
        } else if (r.outcome === "half_won" || r.outcome === "half_lost") {
          staked += 0.5;
          returned += settlementPnl(r, 1);
        }
      }

      const decided = wins + losses;
      const roiPct = staked > 0 ? (returned / staked) * 100 : null;
      const shrunkRoiPct =
        decided > 0
          ? shrinkToward(roiPct ?? 0, decided, populationRoi, 200)
          : null;
      const z = winZScore(b.rows);
      const p = z == null ? null : zToPValue(z);

      built.push({
        primary: b.primary,
        secondary: b.secondary,
        n: b.rows.length,
        wins,
        losses,
        pendings,
        roiPct,
        shrunkRoiPct,
        avgEvPct: evSum / b.rows.length,
        clvPct: clvN > 0 ? (clvSum / clvN) * 100 : null,
        z,
        p,
        pAdj: null,
      });
      rawPs.push(p);
    }

    const adj = bhAdjust(rawPs);
    for (let i = 0; i < built.length; i++) {
      built[i].pAdj = adj[i];
    }

    built.sort((a, b) => b.n - a.n);
    return built;
  }, [scopedRows, primary, secondary, populationRoi]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Group by</span>
          <Select
            value={primary}
            onValueChange={(v) => setPrimary(v as PivotDimension)}
          >
            <SelectTrigger size="sm" className="h-7 w-[160px] text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DIMENSION_OPTIONS.filter((o) => o.value !== "none").map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Then by</span>
          <Select
            value={secondary}
            onValueChange={(v) => setSecondary(v as PivotDimension | "none")}
          >
            <SelectTrigger size="sm" className="h-7 w-[160px] text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DIMENSION_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            Walk-forward OOS only
          </span>
          <Checkbox
            checked={testOnly}
            onCheckedChange={(v) => onTestOnlyChange(v === true)}
            className="size-3.5"
          />
        </div>
        <Button
          size="sm"
          className="h-7 px-2 text-[11px] gap-1"
          disabled={proposeLoading || cells.length === 0}
          onClick={() => {
            // Rank cells by z × √N × shrunkROI — puts strong positive-edge
            // slices first. Negative/empty score slices sink to the bottom.
            const ranked = [...cells]
              .map((c) => {
                const z = c.z ?? 0;
                const sr = c.shrunkRoiPct ?? 0;
                const score = z * Math.sqrt(c.n) * sr;
                return { c, score };
              })
              .sort((a, b) => b.score - a.score)
              .slice(0, 30);

            const slices: ProposeSliceInput[] = ranked.map(({ c }) => {
              const dimensions: Record<string, string> = {
                [primary]: c.primary,
              };
              if (secondary !== "none" && c.secondary) {
                dimensions[secondary] = c.secondary;
              }
              return {
                label: `${c.primary}${c.secondary ? ` × ${c.secondary}` : ""}`,
                dimensions,
                n: c.n,
                wins: c.wins,
                losses: c.losses,
                roiPct: c.roiPct,
                shrunkRoiPct: c.shrunkRoiPct,
                clvPct: c.clvPct,
                avgEvPct: c.avgEvPct,
                z: c.z,
                pAdj: c.pAdj,
              };
            });

            if (slices.length === 0) {
              toast.error("No slices to analyse — widen your pivot first.");
              return;
            }

            onPropose(slices, headline);
          }}
        >
          {proposeLoading ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Sparkles className="size-3" />
          )}
          Propose with Gemini
        </Button>
      </div>

      <div className="rounded-md border max-h-[420px] overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Group</TableHead>
              {secondary !== "none" && <TableHead>Then</TableHead>}
              <TableHead className="text-right">N</TableHead>
              <TableHead className="text-right">W / L</TableHead>
              <TableHead className="text-right">ROI</TableHead>
              <TableHead className="text-right">ROI*</TableHead>
              <TableHead className="text-right">CLV</TableHead>
              <TableHead className="text-right">Avg EV</TableHead>
              <TableHead className="text-right">z</TableHead>
              <TableHead className="text-right">p (BH)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cells.map((c, i) => {
              const smallSample = c.n < 100;
              const notSignificant = c.pAdj == null || c.pAdj > 0.05;
              const dim = smallSample || notSignificant;
              return (
                <TableRow key={i} className={cn(dim && "opacity-50")}>
                  <TableCell className="text-[12px]">{c.primary}</TableCell>
                  {secondary !== "none" && (
                    <TableCell className="text-[12px] text-muted-foreground">
                      {c.secondary}
                    </TableCell>
                  )}
                  <TableCell className="text-right tabular-nums text-[12px]">
                    {c.n}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-[12px]">
                    <span className="text-emerald-400">{c.wins}</span>
                    <span className="text-muted-foreground mx-0.5">/</span>
                    <span className="text-rose-400">{c.losses}</span>
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums text-[12px] font-medium",
                      signedClass(c.roiPct),
                    )}
                  >
                    {c.roiPct == null ? "—" : fmtPct(c.roiPct, true, 1)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums text-[12px]",
                      signedClass(c.shrunkRoiPct),
                    )}
                  >
                    {c.shrunkRoiPct == null
                      ? "—"
                      : fmtPct(c.shrunkRoiPct, true, 1)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums text-[12px]",
                      signedClass(c.clvPct),
                    )}
                  >
                    {c.clvPct == null ? "—" : fmtPct(c.clvPct, true, 2)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums text-[12px]",
                      signedClass(c.avgEvPct),
                    )}
                  >
                    {fmtPct(c.avgEvPct, true, 1)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-[12px]">
                    {fmtNum(c.z, 2)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums text-[12px]",
                      c.pAdj != null && c.pAdj < 0.05
                        ? "text-emerald-400 font-medium"
                        : "text-muted-foreground",
                    )}
                  >
                    {c.pAdj == null
                      ? "—"
                      : c.pAdj < 0.001
                        ? "<0.001"
                        : c.pAdj.toFixed(3)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-[10px] text-muted-foreground/80">
        ROI* = Bayesian-shrunk toward population mean (prior N=200). Rows with
        N&lt;100 OR Benjamini-Hochberg-adjusted p&gt;0.05 are dimmed — those are
        noise-candidates.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Google AI Mode launcher — builds a detailed prompt summarising the
// current analysis set and opens it in a new tab. The AI is asked to
// drive a clarifying-question conversation before giving conclusions.
// ─────────────────────────────────────────────────────────────────

const buildAiModePrompt = (rows: ValueBetRow[]): string => {
  const flat = computeStrategyMetrics(rows, "flat");
  const clv = summarizeClv(rows);
  const brier = brierScore(rows);
  const ll = logLoss(rows);
  const z = winZScore(rows);
  const p = z == null ? null : zToPValue(z);
  const decided = flat.wins + flat.losses;
  const winRate = decided > 0 ? (flat.wins / decided) * 100 : null;

  const fmt = (n: number | null, digits = 2): string =>
    n == null || !Number.isFinite(n) ? "—" : n.toFixed(digits);

  // Percentiles — use nearest-rank for simplicity. Returns "—" when empty.
  const distro = (xs: number[], digits = 2): string => {
    if (xs.length === 0) return "—";
    const s = [...xs].sort((a, b) => a - b);
    const q = (pct: number) => {
      const idx = Math.min(s.length - 1, Math.floor((pct / 100) * s.length));
      return s[idx];
    };
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    return `min ${s[0].toFixed(digits)} · p25 ${q(25).toFixed(digits)} · median ${q(50).toFixed(digits)} · p75 ${q(75).toFixed(digits)} · max ${s[s.length - 1].toFixed(digits)} · mean ${mean.toFixed(digits)}`;
  };

  // Count outcome types so the AI doesn't have to infer from (settled - wins - losses).
  let halfW = 0,
    halfL = 0,
    voids = 0,
    pendings = 0;
  for (const r of rows) {
    if (r.outcome === "half_won") halfW++;
    else if (r.outcome === "half_lost") halfL++;
    else if (r.outcome === "void") voids++;
    else if (r.outcome === "pending") pendings++;
  }

  // Distributions the AI will otherwise ask for.
  const entryOdds = rows.map((r) => r.softOddsFirst);
  const sharpOdds = rows.map((r) => r.sharpOdds);
  const evs = rows.map((r) => derive(r).evPctFirst);
  const evByRowId = new Map(rows.map((r) => [r.id, derive(r).evPctFirst]));
  const ticks = rows.map((r) => r.tickCount);
  const hoursToKick = rows.map((r) => {
    const start = new Date(r.eventStartTime).getTime();
    const seen = new Date(r.firstSeenAt).getTime();
    return (start - seen) / 3_600_000;
  });

  // Pinnacle snapshot age — critical latency signal. Null-safe.
  const snapshotAgeSec = rows
    .map((r) => r.sharpOddsAgeMs)
    .filter((v): v is number => v != null)
    .map((ms) => ms / 1000);

  // Commission split — exchange (>0%) vs sportsbook (0%).
  const commissioned = rows.filter((r) => r.softCommissionPct > 0).length;

  // Outcome cross-tab: count + mean EV + mean CLV + mean snapshot age per bucket.
  type OutcomeAgg = {
    n: number;
    evSum: number;
    clvSum: number;
    clvN: number;
    ageSum: number;
    ageN: number;
  };
  const outcomeBuckets = new Map<string, OutcomeAgg>();
  for (const r of rows) {
    let a = outcomeBuckets.get(r.outcome);
    if (!a) {
      a = { n: 0, evSum: 0, clvSum: 0, clvN: 0, ageSum: 0, ageN: 0 };
      outcomeBuckets.set(r.outcome, a);
    }
    a.n++;
    a.evSum += evByRowId.get(r.id) ?? 0;
    if (r.closingSharpOdds != null) {
      a.clvSum += (r.softOddsFirst / r.closingSharpOdds - 1) * 100;
      a.clvN++;
    }
    if (r.sharpOddsAgeMs != null) {
      a.ageSum += r.sharpOddsAgeMs / 1000;
      a.ageN++;
    }
  }
  const outcomeOrder = [
    "won",
    "lost",
    "half_won",
    "half_lost",
    "void",
    "pending",
  ];
  const outcomeTable = outcomeOrder
    .filter((k) => outcomeBuckets.has(k))
    .map((k) => {
      const a = outcomeBuckets.get(k)!;
      const meanEv = (a.evSum / a.n).toFixed(1);
      const meanClv = a.clvN > 0 ? (a.clvSum / a.clvN).toFixed(1) : "—";
      const meanAge = a.ageN > 0 ? (a.ageSum / a.ageN).toFixed(0) : "—";
      return `  ${k.padEnd(10)} n=${a.n}  avgEV ${meanEv}%  avgCLV ${meanClv}%  avgSharpAge ${meanAge}s`;
    })
    .join("\n");

  // Odds-bucket cross-tab: helps the AI see longshot vs favourite behaviour.
  const oddsBuckets: { label: string; lo: number; hi: number }[] = [
    { label: "1.00-2.00", lo: 1, hi: 2 },
    { label: "2.00-3.00", lo: 2, hi: 3 },
    { label: "3.00-5.00", lo: 3, hi: 5 },
    { label: "5.00-10.0", lo: 5, hi: 10 },
    { label: "10.0+    ", lo: 10, hi: Infinity },
  ];
  const oddsTable = oddsBuckets
    .map((b) => {
      const bucket = rows.filter(
        (r) => r.softOddsFirst >= b.lo && r.softOddsFirst < b.hi,
      );
      if (bucket.length === 0) return null;
      let w = 0,
        l = 0,
        evSum = 0;
      for (const r of bucket) {
        if (r.outcome === "won") w++;
        else if (r.outcome === "half_won") w += 0.5;
        else if (r.outcome === "lost") l++;
        else if (r.outcome === "half_lost") l += 0.5;
        evSum += evByRowId.get(r.id) ?? 0;
      }
      const decided = w + l;
      const wr = decided > 0 ? ((w / decided) * 100).toFixed(0) : "—";
      return `  ${b.label}  n=${bucket.length}  ${w}W/${l}L (${wr}%)  avgEV ${(evSum / bucket.length).toFixed(1)}%`;
    })
    .filter((s): s is string => s != null)
    .join("\n");

  // Market breakdown (top 5 by volume) — now with max EV and closing coverage
  // so the AI can see where extreme outliers concentrate and where CLV data is
  // structurally missing.
  type Agg = {
    n: number;
    wins: number;
    losses: number;
    evSum: number;
    evMax: number;
    withClosing: number;
  };
  const byMarket = new Map<string, Agg>();
  for (const r of rows) {
    let a = byMarket.get(r.marketType);
    if (!a) {
      a = {
        n: 0,
        wins: 0,
        losses: 0,
        evSum: 0,
        evMax: -Infinity,
        withClosing: 0,
      };
      byMarket.set(r.marketType, a);
    }
    a.n++;
    if (r.outcome === "won") a.wins++;
    else if (r.outcome === "half_won") a.wins += 0.5;
    else if (r.outcome === "lost") a.losses++;
    else if (r.outcome === "half_lost") a.losses += 0.5;
    const ev = evByRowId.get(r.id) ?? 0;
    a.evSum += ev;
    if (ev > a.evMax) a.evMax = ev;
    if (r.closingSharpOdds != null) a.withClosing++;
  }
  const topMarkets = [...byMarket.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 5)
    .map(([k, a]) => {
      const d = a.wins + a.losses;
      const wr = d > 0 ? ((a.wins / d) * 100).toFixed(0) : "—";
      const coverage = ((a.withClosing / a.n) * 100).toFixed(0);
      return `  ${k}: n=${a.n}  ${a.wins}W/${a.losses}L (${wr}%)  avgEV ${(a.evSum / a.n).toFixed(1)}%  maxEV ${a.evMax.toFixed(1)}%  closing ${coverage}%`;
    })
    .join("\n");

  // Provider breakdown — soft book side.
  const byProvider = new Map<string, number>();
  for (const r of rows) {
    byProvider.set(r.softProvider, (byProvider.get(r.softProvider) ?? 0) + 1);
  }
  const providerList = [...byProvider.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `  ${k}: ${n}`)
    .join("\n");

  // Settlement source breakdown — only relevant for settled rows.
  const bySource = new Map<string, number>();
  for (const r of rows) {
    if (!r.settledBySource) continue;
    bySource.set(r.settledBySource, (bySource.get(r.settledBySource) ?? 0) + 1);
  }
  const sourceList =
    bySource.size === 0
      ? "  (none settled yet)"
      : [...bySource.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `  ${k}: ${n}`)
          .join("\n");

  // Red flags the AI should focus on. Conditional — only include when triggered.
  const avgEv =
    evs.length > 0 ? evs.reduce((a, b) => a + b, 0) / evs.length : 0;
  const redFlags: string[] = [];
  if (avgEv > 15) {
    redFlags.push(
      `- Mean EV is ${avgEv.toFixed(1)}% — this is 5×+ the detection threshold (2%). Pinnacle is extremely sharp; real edges on mainstream markets rarely exceed 3-5%. Strongly consider: (a) stale Pinnacle line at detection (token/capture age), (b) palp error on the soft side (usually voided by book later), (c) timing mismatch between sharp and soft snapshots, (d) commission not being applied correctly, (e) wrong atom mapping between providers.`,
    );
  }
  if (rows.length < 30) {
    redFlags.push(
      `- Sample size is ${rows.length}. Anything resembling a "conclusion" here is noise. Need ~200+ settled bets before win-rate/ROI numbers stabilise.`,
    );
  }
  if (clv.withClosing === 0) {
    redFlags.push(
      `- No bets have Pinnacle closing-line data yet. CLV — the most reliable edge signal — is therefore uncomputable. Closing capture runs ±5 min around kickoff; investigate why none were captured.`,
    );
  } else if (clv.withClosing < rows.length * 0.5) {
    redFlags.push(
      `- Only ${clv.withClosing}/${rows.length} bets (${((clv.withClosing / rows.length) * 100).toFixed(0)}%) have closing-line data. CLV metrics are drawn from a potentially biased subset.`,
    );
  }

  return [
    "I'm debugging a value-betting backtest and need sharp, skeptical analysis.",
    "",
    "SYSTEM",
    "  Detects positive-EV bets by comparing soft-book odds against Pinnacle's vig-removed true probability.",
    "  Softs: NineWickets Exchange (commissioned), NineWickets Sportsbook (0% comm), BetConstruct.",
    "  Sharp: Pinnacle via Betjili (token-captured, ~1h validity). Vig removed per family with balanced-margin.",
    "  Detection threshold: EV ≥ 2%. Sharp-staleness gate: snapshot must be <90s old at detection.",
    "  Scope: PRE-MATCH ONLY. In-play detection is not supported; any in-play rows historically present have been excluded from this analysis.",
    "  P&L booked at entry price, commission-adjusted.",
    "",
    "SAMPLE",
    `  Total: ${rows.length} bets | settled: ${flat.settledBets} | pending: ${pendings} | void: ${voids}`,
    `  Decided outcomes: ${flat.wins}W / ${flat.losses}L / ${halfW}½W / ${halfL}½L`,
    `  Closing-line coverage: ${clv.withClosing}/${rows.length} (${((clv.withClosing / Math.max(1, rows.length)) * 100).toFixed(0)}%)`,
    `  Commission mix: ${commissioned} exchange / ${rows.length - commissioned} sportsbook`,
    "",
    "RETURNS",
    `  Win rate: ${fmt(winRate, 1)}%  ·  Flat-1u ROI: ${fmt(flat.roiPct, 2)}%`,
    `  Brier: ${fmt(brier, 3)}  ·  Log loss: ${fmt(ll, 3)}  (log-loss 0.693 = random baseline)`,
    `  z (wins vs expected): ${fmt(z, 2)}  ·  p: ${p == null ? "—" : p.toFixed(3)}`,
    "",
    "CLV  (CLV = softOddsFirst / pinnacleClose − 1, at entry)",
    `  Mean: ${fmt(clv.meanPct, 2)}%  ·  Median: ${fmt(clv.medianPct, 2)}%  ·  Beat-close rate: ${fmt(clv.beatRatePct, 1)}%`,
    "",
    "DISTRIBUTIONS",
    `  Soft entry odds:   ${distro(entryOdds)}`,
    `  Pinnacle odds:     ${distro(sharpOdds)}`,
    `  EV % per bet:      ${distro(evs, 2)}`,
    `  Hours-to-kickoff at detection: ${distro(hoursToKick, 1)}`,
    `  Pinnacle snapshot age (sec):    ${distro(snapshotAgeSec, 0)}${snapshotAgeSec.length < rows.length ? ` (${rows.length - snapshotAgeSec.length} rows missing age data)` : ""}`,
    `  Tick count (re-observations):   ${distro(ticks, 0)}`,
    "",
    "OUTCOME CROSS-TAB  (does high EV concentrate in losses/voids?)",
    outcomeTable || "  (no settled rows)",
    "",
    "ODDS-BUCKET CROSS-TAB  (longshot vs favourite behaviour)",
    oddsTable || "  (no breakdown)",
    "",
    "MARKETS (top 5 by volume) — includes max EV + per-market closing coverage",
    topMarkets || "  (no breakdown)",
    "",
    "SOFT PROVIDER BREAKDOWN",
    providerList,
    "",
    "SETTLEMENT SOURCE BREAKDOWN",
    sourceList,
    "",
    ...(redFlags.length > 0
      ? ["RED FLAGS I'VE NOTICED (focus here)", ...redFlags, ""]
      : []),
    "WHAT I NEED",
    "  1. Ask 2-4 clarifying questions ONLY for things you cannot infer from the data above. Do NOT ask about: average/range of odds, time-to-kickoff, Pinnacle snapshot age, commission mix, settlement source, sample size, outcome split, or per-market stats — all already provided.",
    "  2. Diagnose: is the observed edge real, or phantom (stale Pinnacle snapshot, palp errors voided later, atom-mapping bugs)? Rank causes by likelihood given the numbers above.",
    '  3. Tell me which slices to prune vs investigate deeper. Be specific (e.g. "drop AH bets with entry odds > 5.0", not "improve AH").',
    "  4. Propose 2-3 concrete diagnostics I can add to existing code in under a day. No rewrites.",
    "  5. If sample is too small for a conclusion, say so and give the minimum N that would change your view. No hedging.",
    "",
    "CONSTRAINTS",
    "  Solo builder. Personal project. Simplicity over optimality. Prefer diagnostics I can add to existing code over rewrites.",
  ].join("\n");
};

const openInGoogleAiMode = (prompt: string) => {
  const url = `https://www.google.com/search?udm=50&q=${encodeURIComponent(prompt)}`;
  window.open(url, "_blank", "noopener,noreferrer");
};

// ─────────────────────────────────────────────────────────────────
// Dialog shell
// ─────────────────────────────────────────────────────────────────

export function AnalysisDialog({
  open,
  onOpenChange,
  rows,
  scope,
  loading = false,
  loadingProgress = null,
  excludedInPlayCount = 0,
}: Props) {
  const [walkForwardOnly, setWalkForwardOnly] = useState(false);

  const headlineRows = useMemo(
    () => (walkForwardOnly ? walkForwardSplit(rows, 0.3).test : rows),
    [rows, walkForwardOnly],
  );
  const n = rows.length;
  const oosN = headlineRows.length;

  // Shape the headline into what /ai-propose expects.
  const proposeHeadline = useMemo<ProposeHeadlineInput>(() => {
    const flat = computeStrategyMetrics(headlineRows, "flat");
    const clv = summarizeClv(headlineRows);
    const brier = brierScore(headlineRows);
    const decided = flat.wins + flat.losses;
    return {
      totalRows: headlineRows.length,
      settledRows: flat.settledBets,
      winRatePct: decided > 0 ? (flat.wins / decided) * 100 : null,
      flatRoiPct: flat.settledBets > 0 ? flat.roiPct : null,
      meanClvPct: clv.meanPct,
      beatCloseRatePct: clv.beatRatePct,
      brier,
    };
  }, [headlineRows]);

  const proposeMut = useProposeRules();
  const [proposeOpen, setProposeOpen] = useState(false);
  const [proposeResponse, setProposeResponse] =
    useState<ProposeResponse | null>(null);

  const handlePropose = (
    slices: ProposeSliceInput[],
    headline: ProposeHeadlineInput,
  ) => {
    setProposeOpen(true);
    setProposeResponse(null);
    proposeMut.mutate(
      { topSlices: slices, headline, maxRules: 5 },
      {
        onSuccess: (r) => {
          setProposeResponse(r);
          toast.success(
            `Gemini returned ${r.rules.length} rule${r.rules.length === 1 ? "" : "s"}`,
          );
        },
        onError: (err) => {
          toast.error(`Propose failed: ${(err as Error).message}`);
          setProposeOpen(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl h-[90vh] overflow-hidden flex flex-col">
        <TooltipProvider delayDuration={200}>
          <DialogHeader>
            <DialogTitle>Analysis</DialogTitle>
            <DialogDescription>
              {loading
                ? `Fetching every bet matching the current filters…`
                : `Deterministic analysis of ${n} ${scope === "selected" ? "selected" : "matching"} pre-match bets`}
              {!loading &&
                walkForwardOnly &&
                ` · showing out-of-sample (${oosN} rows)`}
              {!loading && excludedInPlayCount > 0 && (
                <span className="block text-[11px] text-muted-foreground mt-1">
                  {excludedInPlayCount.toLocaleString()} historical in-play row
                  {excludedInPlayCount === 1 ? "" : "s"} excluded — platform is
                  pre-match only.
                </span>
              )}
            </DialogDescription>
          </DialogHeader>

          {loading && (
            <LoadingBody progress={loadingProgress} totalHint={n || null} />
          )}

          {!loading && (
            <Tabs
              defaultValue="headline"
              className="flex-1 overflow-hidden flex flex-col"
            >
              <TabsList>
                <TabsTrigger value="headline">Headline</TabsTrigger>
                <TabsTrigger value="calibration">Calibration</TabsTrigger>
                <TabsTrigger value="strategies">Strategies</TabsTrigger>
                <TabsTrigger value="pivot">Pivot</TabsTrigger>
                <TabsTrigger value="bets">Bets ({rows.length})</TabsTrigger>
              </TabsList>

              <div className="flex-1 overflow-auto pt-3">
                <TabsContent value="headline" className="outline-none">
                  <div className="flex items-center justify-end mb-2 gap-2">
                    <span className="text-[11px] text-muted-foreground">
                      Walk-forward OOS only
                    </span>
                    <Checkbox
                      checked={walkForwardOnly}
                      onCheckedChange={(v) => setWalkForwardOnly(v === true)}
                      className="size-3.5"
                    />
                  </div>
                  <HeadlineTab rows={headlineRows} />
                </TabsContent>

                <TabsContent value="calibration" className="outline-none">
                  <CalibrationTab rows={headlineRows} />
                </TabsContent>

                <TabsContent value="strategies" className="outline-none">
                  <StrategiesComparisonTab rows={headlineRows} />
                </TabsContent>

                <TabsContent value="pivot" className="outline-none">
                  <PivotTab
                    rows={rows}
                    testOnly={walkForwardOnly}
                    onTestOnlyChange={setWalkForwardOnly}
                    onPropose={handlePropose}
                    proposeLoading={proposeMut.isPending}
                    headline={proposeHeadline}
                  />
                </TabsContent>

                <TabsContent value="bets" className="outline-none">
                  <BetsTab rows={headlineRows} />
                </TabsContent>
              </div>
            </Tabs>
          )}

          <DialogFooter className="sm:justify-between">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={loading || rows.length === 0}
                  onClick={() => openInGoogleAiMode(buildAiModePrompt(rows))}
                >
                  <Sparkles className="size-3.5" />
                  Deep-dive with Google AI
                  <ExternalLink className="size-3 opacity-60" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[280px]">
                Opens Google AI Mode in a new tab with a pre-filled prompt
                summarising this analysis. The AI will ask you clarifying
                questions, then walk you through a deeper look at the data.
              </TooltipContent>
            </Tooltip>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </DialogFooter>
        </TooltipProvider>
      </DialogContent>

      <ProposedRulesDialog
        open={proposeOpen}
        onOpenChange={(o) => {
          setProposeOpen(o);
          if (!o) setProposeResponse(null);
        }}
        loading={proposeMut.isPending}
        response={proposeResponse}
      />
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────

const LOADING_TIPS = [
  "Bigger samples mean tighter confidence intervals — longer waits lead to more trustworthy numbers.",
  "Your CLV is the most reliable signal of long-run edge. Win rate alone can lie.",
  "Full Kelly stakes are mathematically optimal — and emotionally unbearable. Most pros use ¼ or ½.",
  "A 55% beat-close rate on 500+ bets > a 100% rate on 6 bets. Ignore early hot streaks.",
  "Brier score below 0.22 means Pinnacle's probabilities are sharply calibrated on your sample.",
  "When p-value > 0.1, assume it's noise until you see the same result on twice the data.",
];

function LoadingBody({
  progress,
  totalHint,
}: {
  progress: { loaded: number; total: number | null } | null;
  totalHint: number | null;
}) {
  const [tipIndex, setTipIndex] = useState(() =>
    Math.floor(Math.random() * LOADING_TIPS.length),
  );
  useEffect(() => {
    const id = setInterval(() => {
      setTipIndex((i) => (i + 1) % LOADING_TIPS.length);
    }, 4500);
    return () => clearInterval(id);
  }, []);

  const loaded = progress?.loaded ?? 0;
  const total = progress?.total ?? totalHint;
  const pct = total && total > 0 ? Math.min(100, (loaded / total) * 100) : null;

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 py-12 px-6">
      <div className="flex items-center gap-3 text-sm">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        <span className="font-medium tabular-nums">
          {loaded.toLocaleString()}
          {total != null && (
            <>
              <span className="opacity-60 mx-1">/</span>
              <span className="opacity-80">{total.toLocaleString()}</span>
            </>
          )}{" "}
          bets loaded
        </span>
      </div>
      <div className="w-full max-w-md">
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-300 ease-out"
            style={{
              width: pct == null ? "35%" : `${pct}%`,
              animation:
                pct == null ? "pulse 2s ease-in-out infinite" : undefined,
            }}
          />
        </div>
      </div>
      <div className="text-center text-[12px] text-muted-foreground max-w-md leading-relaxed min-h-[3em]">
        <span className="font-medium text-foreground/80">
          While you wait —{" "}
        </span>
        <span key={tipIndex} className="animate-in fade-in duration-500">
          {LOADING_TIPS[tipIndex]}
        </span>
      </div>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
      {title}
    </h3>
  );
}

type MetricExplain = {
  what: string;
  example?: string;
  formula?: string;
};

function Metric({
  label,
  value,
  sub,
  ci,
  valueClassName,
  explain,
  primary = false,
}: {
  label: string;
  value: string;
  sub?: string;
  /** Confidence-interval descriptor, e.g. "±12.4pp (95% CI)". Rendered between value and sub. */
  ci?: string;
  valueClassName?: string;
  explain?: MetricExplain;
  /** Primary-signal accent: thicker border, larger value, emphasis ring. */
  primary?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-md px-3 py-2",
        primary
          ? "border-2 border-primary/40 bg-primary/5"
          : "border border-border bg-muted/30",
      )}
    >
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>{label}</span>
        {explain && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`About ${label}`}
                className="inline-flex items-center text-muted-foreground/70 hover:text-foreground transition-colors cursor-help"
              >
                <Info className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="max-w-[300px] text-xs px-3 py-2 leading-relaxed normal-case tracking-normal"
            >
              <div className="font-semibold mb-1">{label}</div>
              <div className="opacity-80">{explain.what}</div>
              {explain.formula && (
                <div className="mt-1.5 text-[11px] font-mono opacity-70">
                  {explain.formula}
                </div>
              )}
              {explain.example && (
                <div className="mt-1.5 text-[11px] opacity-80">
                  <span className="font-medium">Example: </span>
                  {explain.example}
                </div>
              )}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      <div
        className={cn(
          "font-semibold tabular-nums leading-tight",
          primary ? "text-2xl" : "text-lg",
          valueClassName,
        )}
      >
        {value}
      </div>
      {ci && (
        <div className="text-[10px] text-muted-foreground/80 tabular-nums font-medium">
          {ci}
        </div>
      )}
      {sub && (
        <div className="text-[10px] text-muted-foreground tabular-nums">
          {sub}
        </div>
      )}
    </div>
  );
}
