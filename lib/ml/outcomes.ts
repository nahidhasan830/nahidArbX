/**
 * ML Outcome Vocabulary & Label Derivation
 *
 * Single source of truth for outcome → label mapping, unit return
 * computation, and sample weight derivation. Used by both the
 * training-example-writer (TS) and referenced by the Python loader
 * for parity.
 *
 * Phase 2: Canonical Training Corpus
 */

// ── Outcome vocabulary ────────────────────────────────────────────────

/** Outcomes that indicate the bet has been settled. */
export const SETTLED_OUTCOMES = [
  "won",
  "half_won",
  "lost",
  "half_lost",
  "void",
] as const;

/** Outcomes that count as positive label for the binary classifier. */
export const POSITIVE_OUTCOMES = ["won", "half_won"] as const;

/** Outcomes excluded from training — voids carry no predictive signal. */
export const EXCLUDED_OUTCOMES = ["void"] as const;

/** Outcomes that count as negative label. */
export const NEGATIVE_OUTCOMES = ["lost", "half_lost"] as const;

export type SettledOutcome = (typeof SETTLED_OUTCOMES)[number];
export type TrainingLabel = "positive" | "negative";
export type ExampleType =
  | "settled_detected"
  | "placed_settled"
  | "shadow_scored";

// ── Label derivation ──────────────────────────────────────────────────

/**
 * Derive label from bet outcome.
 *   won, half_won → positive
 *   lost, half_lost → negative
 *   void, pending, cancelled → null (excluded)
 */
export function deriveLabel(outcome: string): TrainingLabel | null {
  if ((POSITIVE_OUTCOMES as readonly string[]).includes(outcome))
    return "positive";
  if ((NEGATIVE_OUTCOMES as readonly string[]).includes(outcome))
    return "negative";
  return null;
}

// ── Unit return computation ───────────────────────────────────────────

/**
 * Compute normalized 1-unit return for a bet based on outcome and odds.
 *
 * This is the canonical metric for model evaluation — it simulates what
 * would happen if we staked exactly 1 unit on this bet. Real `pnl` is
 * null for unplaced detections, so this is the only fair comparison.
 *
 * @param outcome - Settlement outcome
 * @param softOdds - Soft bookmaker odds at detection
 * @param commissionPct - Soft bookmaker commission (0-100)
 * @returns Unit return (e.g., +1.5 for a won bet at 2.5 odds, -1 for a loss)
 *          or null if the outcome is excluded (void/pending)
 */
export function computeUnitReturn(
  outcome: string,
  softOdds: number,
  commissionPct: number,
): number | null {
  // Commission-adjusted net return per unit staked
  const b = (softOdds - 1) * (1 - commissionPct / 100);

  switch (outcome) {
    case "won":
      return b;
    case "half_won":
      return b * 0.5;
    case "lost":
      return -1;
    case "half_lost":
      return -0.5;
    default:
      return null; // void, pending, cancelled — excluded
  }
}

// ── Sample weight derivation ──────────────────────────────────────────

/** PnL-magnitude boost scale and cap — must match Python _pnl_boost(). */
const PNL_BOOST_SCALE = 5.0;
const PNL_BOOST_CAP = 2.0;

/**
 * Multiplicative boost from absolute PnL — higher impact → more weight.
 * Returns a multiplier in [1.0, PNL_BOOST_CAP]. Zero PnL → 1.0.
 */
export function pnlBoost(pnlAbs: number): number {
  if (pnlAbs <= 0) return 1.0;
  const boost = 1.0 + Math.log1p(pnlAbs / PNL_BOOST_SCALE) * 0.3;
  return Math.min(boost, PNL_BOOST_CAP);
}

/**
 * Derive sample weight from outcome, example type, and PnL magnitude.
 *
 * Weight formula:
 *   base = 0.5 for half outcomes, 1.0 otherwise
 *   boost = pnlBoost(|pnl|)
 *   final = base × boost
 *
 * Shadow-scored examples start at 1.0 (adjusted when resolved).
 */
export function deriveSampleWeight(
  outcome: string,
  _exampleType: ExampleType,
  pnl: number | null,
): number {
  let base: number;
  switch (outcome) {
    case "half_won":
    case "half_lost":
      base = 0.5;
      break;
    default:
      base = 1.0;
  }
  return base * pnlBoost(Math.abs(pnl ?? 0));
}

// ── Training precedence ───────────────────────────────────────────────

/**
 * Example type precedence (higher = stronger evidence).
 *
 * placed_settled > settled_detected > shadow_scored
 *
 * Used when multiple example types exist for the same bet: the strongest
 * type should be used for training.
 */
export const EXAMPLE_TYPE_PRECEDENCE: Record<ExampleType, number> = {
  placed_settled: 4,
  settled_detected: 3,
  shadow_scored: 2,
};

/**
 * Returns true if `candidate` should replace `existing` based on
 * training precedence rules.
 */
export function shouldReplaceExample(
  existing: ExampleType,
  candidate: ExampleType,
): boolean {
  return EXAMPLE_TYPE_PRECEDENCE[candidate] > EXAMPLE_TYPE_PRECEDENCE[existing];
}
