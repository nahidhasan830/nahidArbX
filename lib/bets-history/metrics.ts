/**
 * Deterministic metric helpers for the analysis panel.
 *
 * All functions take plain ValueBetRow[] and return numbers. No I/O, no AI.
 * Keep the formulas here and the UI code free of math.
 */

import { derive, settlementPnl } from "./derive";
import {
  hasPnl,
  isSettledOutcome,
  type Outcome,
  type ValueBetRow,
} from "./types";

// ─────────────────────────────────────────────────────────────────
// Closing Line Value (CLV)
// ─────────────────────────────────────────────────────────────────

/**
 * CLV% on the soft book: did we beat the sharp closing line at the price
 * we actually entered at?
 *   beatRatio = softOddsFirst / closingSharpOdds - 1
 * A +2–3% mean CLV with >55% beat-rate ≈ long-run profitable.
 *
 * Null if closing snapshot is missing for the row.
 */
export const clvPct = (row: ValueBetRow): number | null => {
  if (row.closingSharpOdds == null) return null;
  return row.softOdds / row.closingSharpOdds - 1;
};

export type ClvSummary = {
  n: number;
  withClosing: number;
  meanPct: number | null;
  medianPct: number | null;
  beatRatePct: number | null; // % of rows where clv > 0
  /** 95% CI half-width on meanPct, in percentage points. Null if n < 2. */
  meanCiHalfWidthPct: number | null;
  /** 95% CI half-width on beatRatePct, percentage points (Wilson). */
  beatRateCiHalfWidthPct: number | null;
};

/**
 * 95% confidence-interval half-width on the mean of a sample, using the
 * t-distribution approximation via z=1.96 (fine for n≥30, slightly tight for
 * smaller n — good enough for gut-checking). Returns null when n<2.
 */
export const meanCi95 = (xs: number[]): number | null => {
  const n = xs.length;
  if (n < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance =
    xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1);
  return 1.96 * Math.sqrt(variance / n);
};

/**
 * 95% Wilson-score CI half-width on a proportion k/n, in proportion units
 * (multiply by 100 for percentage points). Better than Wald for small n and
 * proportions near 0 or 1.
 */
export const wilsonCi95 = (k: number, n: number): number | null => {
  if (n === 0) return null;
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const halfWidth =
    (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return halfWidth;
};

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
};

export const summarizeClv = (rows: ValueBetRow[]): ClvSummary => {
  const values: number[] = [];
  for (const r of rows) {
    const v = clvPct(r);
    if (v != null) values.push(v);
  }
  const withClosing = values.length;
  if (withClosing === 0) {
    return {
      n: rows.length,
      withClosing: 0,
      meanPct: null,
      medianPct: null,
      beatRatePct: null,
      meanCiHalfWidthPct: null,
      beatRateCiHalfWidthPct: null,
    };
  }
  const sum = values.reduce((s, x) => s + x, 0);
  const beats = values.filter((x) => x > 0).length;
  const meanCi = meanCi95(values); // CI on fraction (values are in fraction units)
  const beatCi = wilsonCi95(beats, withClosing);
  return {
    n: rows.length,
    withClosing,
    meanPct: (sum / withClosing) * 100,
    medianPct: median(values) * 100,
    beatRatePct: (beats / withClosing) * 100,
    meanCiHalfWidthPct: meanCi != null ? meanCi * 100 : null,
    beatRateCiHalfWidthPct: beatCi != null ? beatCi * 100 : null,
  };
};

// ─────────────────────────────────────────────────────────────────
// Calibration — Brier, log loss, reliability decile
// ─────────────────────────────────────────────────────────────────

/**
 * Binary label for probability-calibration metrics (Brier, log-loss,
 * reliability, z-score). We deliberately exclude half_won / half_lost
 * here — those are structurally mixed outcomes and introducing fractional
 * labels would complicate the Bernoulli-variance interpretation. They're
 * still captured in the P&L metrics (Sortino, equity curve, ROI).
 */
const decidedOutcome = (o: ValueBetRow["outcome"]): 0 | 1 | null => {
  if (o === "won") return 1;
  if (o === "lost") return 0;
  return null;
};

export const brierScore = (rows: ValueBetRow[]): number | null => {
  const xs: number[] = [];
  for (const r of rows) {
    const y = decidedOutcome(r.outcome);
    if (y == null) continue;
    const p = r.sharpTrueProb;
    xs.push((p - y) * (p - y));
  }
  if (xs.length === 0) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
};

export const logLoss = (rows: ValueBetRow[]): number | null => {
  const EPS = 1e-6;
  const xs: number[] = [];
  for (const r of rows) {
    const y = decidedOutcome(r.outcome);
    if (y == null) continue;
    const p = Math.min(1 - EPS, Math.max(EPS, r.sharpTrueProb));
    xs.push(-(y * Math.log(p) + (1 - y) * Math.log(1 - p)));
  }
  if (xs.length === 0) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
};

export type ReliabilityBucket = {
  label: string;
  predictedMean: number;
  realizedHitRate: number;
  n: number;
};

/**
 * 10-decile reliability diagram: predicted trueProb vs realized win rate.
 * Buckets use equal-width probability bins (0.0–0.1, 0.1–0.2, …, 0.9–1.0).
 */
export const reliabilityBuckets = (
  rows: ValueBetRow[],
): ReliabilityBucket[] => {
  const buckets: { sumP: number; wins: number; n: number }[] = [];
  for (let i = 0; i < 10; i++) buckets.push({ sumP: 0, wins: 0, n: 0 });

  for (const r of rows) {
    const y = decidedOutcome(r.outcome);
    if (y == null) continue;
    const p = Math.min(0.9999, Math.max(0, r.sharpTrueProb));
    const idx = Math.min(9, Math.floor(p * 10));
    buckets[idx].sumP += p;
    buckets[idx].wins += y;
    buckets[idx].n += 1;
  }

  return buckets.map((b, i) => ({
    label: `${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}`,
    predictedMean: b.n > 0 ? b.sumP / b.n : 0,
    realizedHitRate: b.n > 0 ? b.wins / b.n : 0,
    n: b.n,
  }));
};

// ─────────────────────────────────────────────────────────────────
// Risk metrics — Sortino, Ulcer, max drawdown
// ─────────────────────────────────────────────────────────────────

const stakeFlat = () => 1;

type EquityCurve = { index: number; equity: number }[];

const buildEquityCurve = (rows: ValueBetRow[]): EquityCurve => {
  const settled = rows
    .filter((r) => isSettledOutcome(r.outcome as Outcome))
    .sort((a, b) =>
      (a.settledAt ?? a.firstSeenAt).localeCompare(
        b.settledAt ?? b.firstSeenAt,
      ),
    );

  const curve: EquityCurve = [{ index: 0, equity: 0 }];
  let equity = 0;
  settled.forEach((row, i) => {
    equity += settlementPnl(row, stakeFlat());
    curve.push({ index: i + 1, equity });
  });
  return curve;
};

/**
 * Sortino: (mean_return_per_bet - MAR) / downside_stdev
 * MAR = 0 (break-even). Denominator uses only returns below MAR.
 */
export const sortino = (rows: ValueBetRow[]): number | null => {
  // Any row with non-zero P&L counts — that includes half-wins/half-losses.
  const decided = rows.filter((r) => hasPnl(r.outcome as Outcome));
  if (decided.length < 2) return null;

  const returns = decided.map((r) => settlementPnl(r, 1));
  const mean = returns.reduce((s, x) => s + x, 0) / returns.length;

  const downside = returns.filter((x) => x < 0).map((x) => x * x);
  if (downside.length === 0) return null;
  const downsideVar = downside.reduce((s, x) => s + x, 0) / returns.length;
  const downsideStd = Math.sqrt(downsideVar);
  if (downsideStd === 0) return null;
  return mean / downsideStd;
};

/**
 * Ulcer Index: sqrt(mean(drawdown_pct^2)) over the equity curve.
 * Penalises depth AND duration of drawdowns. Expressed in equity units.
 */
export const ulcerIndex = (rows: ValueBetRow[]): number => {
  const curve = buildEquityCurve(rows);
  let peak = 0;
  const dd2: number[] = [];
  for (const p of curve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak - p.equity;
    dd2.push(dd * dd);
  }
  if (dd2.length === 0) return 0;
  const meanSq = dd2.reduce((s, x) => s + x, 0) / dd2.length;
  return Math.sqrt(meanSq);
};

export const maxDrawdown = (rows: ValueBetRow[]): number => {
  const curve = buildEquityCurve(rows);
  let peak = 0;
  let maxDD = 0;
  for (const p of curve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak - p.equity;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
};

// ─────────────────────────────────────────────────────────────────
// Significance — z-score of wins vs expected, BH-FDR correction,
// Bayesian shrinkage.
// ─────────────────────────────────────────────────────────────────

/**
 * z-score: (observed wins - sum(trueProb)) / sqrt(sum(p*(1-p)))
 * |z|<2 = noise, 2–3 = tentative, >3 = signal.
 */
export const winZScore = (rows: ValueBetRow[]): number | null => {
  let sumP = 0;
  let variance = 0;
  let wins = 0;
  let decided = 0;
  for (const r of rows) {
    if (r.outcome !== "won" && r.outcome !== "lost") continue;
    decided++;
    sumP += r.sharpTrueProb;
    variance += r.sharpTrueProb * (1 - r.sharpTrueProb);
    if (r.outcome === "won") wins++;
  }
  if (decided < 10 || variance <= 0) return null;
  return (wins - sumP) / Math.sqrt(variance);
};

/** Normal two-sided p-value via Abramowitz & Stegun 7.1.26 approximation. */
export const zToPValue = (z: number): number => {
  const absZ = Math.abs(z);
  const b1 = 0.31938153;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;
  const t = 1 / (1 + 0.2316419 * absZ);
  const pdf = Math.exp(-(absZ * absZ) / 2) / Math.sqrt(2 * Math.PI);
  const cdfUpper =
    pdf * (b1 * t + b2 * t ** 2 + b3 * t ** 3 + b4 * t ** 4 + b5 * t ** 5);
  return 2 * cdfUpper;
};

/**
 * Benjamini–Hochberg FDR correction.
 * Input: array of raw p-values. Output: same length array of adjusted p-values,
 * where adj[i] is the BH-adjusted p for the original i-th input.
 */
export const bhAdjust = (pvals: (number | null)[]): (number | null)[] => {
  const withIdx = pvals
    .map((p, i) => ({ p, i }))
    .filter((x): x is { p: number; i: number } => x.p != null)
    .sort((a, b) => a.p - b.p);
  const m = withIdx.length;
  const adjusted = new Array(pvals.length).fill(null) as (number | null)[];

  // Step-up: adj_k = min_{j>=k} p_j * m / j
  let minSoFar = 1;
  for (let k = m - 1; k >= 0; k--) {
    const { p, i } = withIdx[k];
    const raw = (p * m) / (k + 1);
    minSoFar = Math.min(minSoFar, raw);
    adjusted[i] = Math.min(1, minSoFar);
  }
  return adjusted;
};

/**
 * Bayesian shrinkage toward a population mean.
 *   posterior = (n * sample + n_prior * prior) / (n + n_prior)
 * n_prior ≈ 500 is a mildly informative prior; tune lower for more trust in
 * the sample. Returns the shrunk value.
 */
export const shrinkToward = (
  sample: number,
  n: number,
  prior: number,
  nPrior: number = 500,
): number => {
  if (n <= 0) return prior;
  return (n * sample + nPrior * prior) / (n + nPrior);
};

// ─────────────────────────────────────────────────────────────────
// Bucketers for pivot-table dimensions
// ─────────────────────────────────────────────────────────────────

export const evBucket = (evPct: number): string => {
  if (evPct < 0) return "neg";
  if (evPct < 2) return "0–2%";
  if (evPct < 5) return "2–5%";
  if (evPct < 10) return "5–10%";
  return "10%+";
};

export const oddsBucket = (odds: number): string => {
  if (odds < 1.5) return "<1.5";
  if (odds < 2) return "1.5–2";
  if (odds < 3) return "2–3";
  if (odds < 5) return "3–5";
  return "5+";
};

export const tickBucket = (ticks: number): string => {
  if (ticks <= 1) return "1";
  if (ticks <= 3) return "2–3";
  if (ticks <= 10) return "4–10";
  return "10+";
};

export const hoursToKickoffBucket = (row: ValueBetRow): string => {
  const kick = new Date(row.eventStartTime).getTime();
  const seen = new Date(row.firstSeenAt).getTime();
  const hrs = (kick - seen) / 3600000;
  if (hrs < 1) return "<1h";
  if (hrs < 6) return "1–6h";
  if (hrs < 24) return "6–24h";
  return "24h+";
};

export type PivotDimension =
  | "marketType"
  | "softProvider"
  | "timeScope"
  | "familyLine"
  | "atomId"
  | "competition"
  | "evBucket"
  | "oddsBucket"
  | "tickBucket"
  | "hoursToKickoffBucket";

export const valueForDimension = (
  row: ValueBetRow,
  dim: PivotDimension,
): string => {
  switch (dim) {
    case "marketType":
      return row.marketType;
    case "softProvider":
      return row.softProvider;
    case "timeScope":
      return row.timeScope ?? "—";
    case "familyLine":
      return row.familyLine == null ? "—" : String(row.familyLine);
    case "atomId":
      return row.atomLabel ?? row.atomId;
    case "competition":
      return row.competition ?? "—";
    case "evBucket":
      return evBucket(derive(row).evPct);
    case "oddsBucket":
      return oddsBucket(row.softOdds);
    case "tickBucket":
      return tickBucket(row.tickCount);
    case "hoursToKickoffBucket":
      return hoursToKickoffBucket(row);
  }
};

// ─────────────────────────────────────────────────────────────────
// Walk-forward split
// ─────────────────────────────────────────────────────────────────

/**
 * Split rows into (train, test) by first_seen_at. Default 70/30.
 * Only out-of-sample (test) rows should drive strategy decisions.
 */
export const walkForwardSplit = (
  rows: ValueBetRow[],
  testFraction = 0.3,
): { train: ValueBetRow[]; test: ValueBetRow[] } => {
  const sorted = [...rows].sort((a, b) =>
    a.firstSeenAt.localeCompare(b.firstSeenAt),
  );
  const cut = Math.floor(sorted.length * (1 - testFraction));
  return {
    train: sorted.slice(0, cut),
    test: sorted.slice(cut),
  };
};

// ─────────────────────────────────────────────────────────────────
// Inline toolbar metrics — flat and quarter-Kelly ROI summaries
// ─────────────────────────────────────────────────────────────────

export type InlineMetrics = {
  settledBets: number;
  wins: number;
  halfWins: number;
  losses: number;
  halfLosses: number;
  winRate: number;
  roiPct: number;
};

const EMPTY_INLINE: InlineMetrics = {
  settledBets: 0,
  wins: 0,
  halfWins: 0,
  losses: 0,
  halfLosses: 0,
  winRate: 0,
  roiPct: 0,
};

export const computeFlatMetrics = (rows: ValueBetRow[]): InlineMetrics => {
  const settled = rows.filter((r) => isSettledOutcome(r.outcome as Outcome));
  if (settled.length === 0) return EMPTY_INLINE;
  const wins = settled.filter((r) => r.outcome === "won").length;
  const halfWins = settled.filter((r) => r.outcome === "half_won").length;
  const losses = settled.filter((r) => r.outcome === "lost").length;
  const halfLosses = settled.filter((r) => r.outcome === "half_lost").length;
  const totalPnl = settled.reduce((sum, r) => sum + settlementPnl(r, 1), 0);
  return {
    settledBets: settled.length,
    wins,
    halfWins,
    losses,
    halfLosses,
    winRate: (wins + halfWins * 0.5) / settled.length,
    roiPct: (totalPnl / settled.length) * 100,
  };
};

export const computeKellyQMetrics = (rows: ValueBetRow[]): InlineMetrics => {
  const settled = rows.filter((r) => isSettledOutcome(r.outcome as Outcome));
  if (settled.length === 0) return EMPTY_INLINE;
  const wins = settled.filter((r) => r.outcome === "won").length;
  const halfWins = settled.filter((r) => r.outcome === "half_won").length;
  const losses = settled.filter((r) => r.outcome === "lost").length;
  const halfLosses = settled.filter((r) => r.outcome === "half_lost").length;
  const stakes = settled.map((r) =>
    Math.max(0, derive(r).kellyFraction * 0.25),
  );
  const totalStake = stakes.reduce((s, x) => s + x, 0);
  const winRate = (wins + halfWins * 0.5) / settled.length;
  if (totalStake === 0)
    return {
      settledBets: settled.length,
      wins,
      halfWins,
      losses,
      halfLosses,
      winRate,
      roiPct: 0,
    };
  const totalPnl = settled.reduce(
    (sum, r, i) => sum + settlementPnl(r, stakes[i]),
    0,
  );
  return {
    settledBets: settled.length,
    wins,
    halfWins,
    losses,
    halfLosses,
    winRate,
    roiPct: (totalPnl / totalStake) * 100,
  };
};
