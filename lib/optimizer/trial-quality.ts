/**
 * Shared trial-quality classifier — the canonical rule for whether a
 * trial row is trustworthy enough to (a) show by default in the
 * TrialsTable, (b) promote to a live strategy, (c) headline in the
 * run-detail ResultsReport.
 *
 * We saw on 2026-04-24 (run 00MOCZZ72WEZZXYKCZSW7PYIDO) that the raw
 * composite-argmax winner was a 5-bet trial with an outlier +48% ROI
 * and a DSR of 0.34 — statistical noise dressed up as a signal. The
 * composite formula has since been hardened in the sidecar
 * (services/optimizer/app/scoring.py::MIN_SAMPLE_FOR_CREDIT) to clamp
 * such trials below any legitimate one, and this classifier mirrors
 * that logic in TypeScript so the UI surfaces quality consistently.
 *
 * Three buckets:
 *   - "ok":         n ≥ 100, DSR ≥ 0.8, CI-low > 0
 *   - "low":        30 ≤ n < 100 OR CI crosses zero OR 0.5 ≤ DSR < 0.8
 *   - "unreliable": n < 30 OR DSR < 0.5 OR composite ≤ LOW_SAMPLE_MAX
 *
 * Thresholds mirror `services/optimizer/app/scoring.py`; keep in sync.
 */

/**
 * Lower bound of the composite "legitimate trial" band. Any composite
 * at or below this is in the sidecar's low-sample clamp range — the
 * trial has 0 < n < 30 and the composite is a pure-penalty value, not
 * a real performance score.
 */
export const LOW_SAMPLE_CLAMP_CEILING = -1;

/** Minimum OOS sample size before a trial counts as statistically real. */
export const MIN_SAMPLE_FOR_CREDIT = 30;
/** Minimum OOS sample size for full "OK" classification (no CI caveat). */
export const MIN_SAMPLE_FOR_OK = 100;

export type TrialQuality = "ok" | "low" | "unreliable";

export interface TrialQualityInput {
  /** OOS sample size (bets that survived the config's filters). */
  sampleSize: number | null;
  /** Deflated Sharpe Ratio in [0, 1]. */
  deflatedSharpe: number | null;
  /** OOS ROI 95% CI lower bound (percent). */
  oosRoiCiLow: number | null;
  /** Raw composite score as persisted. */
  compositeScore: number | null;
}

export interface TrialQualityResult {
  quality: TrialQuality;
  /**
   * Plain-English reason for the classification, phrased for a
   * non-technical reader. Surfaces in tooltip + banner copy.
   */
  reason: string;
  /** Short chip label — "OK" / "Low" / "Unreliable". */
  label: string;
  /** Traffic-light tone for UI tokens (`positive` / `warning` / `danger`). */
  tone: "positive" | "warning" | "danger";
}

export function classifyTrial(input: TrialQualityInput): TrialQualityResult {
  const { sampleSize, deflatedSharpe, oosRoiCiLow, compositeScore } = input;

  const n = sampleSize ?? 0;

  // Hardest disqualifiers first — any one of these → unreliable.
  if (compositeScore != null && compositeScore <= LOW_SAMPLE_CLAMP_CEILING) {
    return {
      quality: "unreliable",
      label: "Unreliable",
      tone: "danger",
      reason:
        "Composite is a sidecar penalty value — this trial's filters left 0 or very few OOS bets, so its 'score' is a placeholder, not a real measurement.",
    };
  }
  if (n < MIN_SAMPLE_FOR_CREDIT) {
    return {
      quality: "unreliable",
      label: "Unreliable",
      tone: "danger",
      reason:
        n === 0
          ? "No OOS bets survived this trial's filters — there is nothing to measure."
          : `Only ${n} OOS bets — below the 30-bet floor where Sharpe / ROI CIs are stable. A single big win or loss swings every metric.`,
    };
  }
  if (deflatedSharpe != null && deflatedSharpe < 0.5) {
    return {
      quality: "unreliable",
      label: "Unreliable",
      tone: "danger",
      reason: `Deflated Sharpe ${deflatedSharpe.toFixed(2)} is below 0.5 — after accounting for the number of trials, this one looks indistinguishable from luck.`,
    };
  }

  // Low-confidence band — at least one warning axis but not disqualifying.
  const crossesZero = oosRoiCiLow != null && oosRoiCiLow <= 0;
  if (n < MIN_SAMPLE_FOR_OK) {
    return {
      quality: "low",
      label: "Low confidence",
      tone: "warning",
      reason: `${n} OOS bets is above the 30-bet floor but below 100 — the confidence interval is wide. Useful as a hint, not a production strategy.`,
    };
  }
  if (crossesZero) {
    return {
      quality: "low",
      label: "Low confidence",
      tone: "warning",
      reason:
        "The 95% ROI confidence interval crosses zero — we can't statistically distinguish this trial's edge from random chance.",
    };
  }
  if (deflatedSharpe != null && deflatedSharpe < 0.8) {
    return {
      quality: "low",
      label: "Low confidence",
      tone: "warning",
      reason: `Deflated Sharpe ${deflatedSharpe.toFixed(2)} — suggestive but not yet 'unlikely to be a fluke' (which starts at 0.8).`,
    };
  }

  // Passed every gate.
  return {
    quality: "ok",
    label: "OK",
    tone: "positive",
    reason: `n=${n} bets, DSR ${deflatedSharpe?.toFixed(2) ?? "—"}, 95% ROI CI is entirely above zero. This trial's edge is statistically real within the search we ran.`,
  };
}

/** Tiny helper for the "is this the best actionable trial?" question. */
export function bestActionableTrial<
  T extends TrialQualityInput & { compositeScore: number | null },
>(trials: readonly T[]): T | null {
  // Sort by composite desc, then pick the first that passes classify().
  const sorted = [...trials].sort((a, b) => {
    const sa = a.compositeScore ?? Number.NEGATIVE_INFINITY;
    const sb = b.compositeScore ?? Number.NEGATIVE_INFINITY;
    return sb - sa;
  });
  for (const t of sorted) {
    if (classifyTrial(t).quality === "ok") return t;
  }
  return null;
}

/**
 * Returns the dominant top trial by composite regardless of quality.
 * Used to decide whether to render the "top trial is unreliable" banner
 * on the run detail page.
 */
export function topTrialByComposite<
  T extends { compositeScore: number | null },
>(trials: readonly T[]): T | null {
  if (trials.length === 0) return null;
  return trials.reduce((best, t) => {
    const bestScore = best.compositeScore ?? Number.NEGATIVE_INFINITY;
    const tScore = t.compositeScore ?? Number.NEGATIVE_INFINITY;
    return tScore > bestScore ? t : best;
  });
}
