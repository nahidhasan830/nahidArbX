/**
 * ML Staker — Permission-Aware Kelly Sizing
 *
 * Adjusts the base Kelly fraction using the ML model's confidence score
 * and feature-derived signals, but ONLY when the deployment gate grants
 * the appropriate permission.
 *
 * Permission-level behavior:
 *   - observe:        returns null (no Kelly adjustment — persist score only)
 *   - gate_only:      returns 0 unless simple EV passes and model EV clears
 *                     the learned policy threshold, 1 otherwise
 *                     (the auto-placer uses 1.0 as pass-through sizing)
 *   - stake_reduce:   applies full multiplier logic but caps at 1.0×
 *                     (can reduce Kelly, never increase)
 *   - stake_increase: applies full multiplier logic (future only)
 *
 * Key design decisions:
 *   - Model EV below the learned policy threshold → return 0 (skip bet)
 *   - Model EV above the learned threshold scales smoothly from 0.5× to 1.5×
 *   - Convergence penalty: negative convergence_rate (soft moving toward
 *     sharp) reduces sizing since the value window is closing
 *   - Persistence bonus: bets that persist for 10+ ticks are more real
 *   - Steam confirmation: sharp steam move confirms edge direction
 *   - Capped at 2× base Kelly to prevent over-leverage (stake_increase only)
 *   - Capped at 1× base Kelly for stake_reduce (never increase)
 */

import { FEATURE_INDEX } from "./feature-contract";
import {
  getPolicyEdgeThresholdPct,
  type MLPermissionLevel,
} from "./deployment-gate";
import { isPilotActive, pilotCoinFlip } from "./pilot";

// ============================================
// Compile-time feature index map
// ============================================

/**
 * O(1) feature lookup by name. The map is built once from FEATURE_NAMES
 * so we don't scatter magic indices through the staking logic. An
 * undefined access on a typo would produce NaN, which downstream
 * arithmetic would propagate visibly.
 */
const F = FEATURE_INDEX;

const MODEL_EDGE_FULL_SCALE_PCT = 10;
const SIMPLE_RULE_MIN_EV_PCT = 3;
const SIMPLE_RULE_MARKET_TYPE_CODES = new Set([0, 2]);

// ============================================
// Public API
// ============================================

/**
 * Compute the raw Kelly multiplier from ML score + features.
 * This is the internal engine — permission checking is done by
 * `computeScoredStake()` which wraps this.
 */
function computeRawMultiplier(mlScore: number, features: number[]): number {
  if (!passesSimpleEvOverlay(features)) return 0;

  const modelEdgePct = computeModelEdgePct(mlScore, features);
  const edgeThresholdPct = getPolicyEdgeThresholdPct();
  if (modelEdgePct <= edgeThresholdPct) return 0;

  let multiplier = 1.0;

  // ── Score-based scaling ──────────────────────────────────────────────
  // Linear interpolation: threshold edge → 0.5×, threshold+10% → 1.5×.
  // This optimizes expected return at the offered odds, not raw win probability.
  const excessEdgePct = modelEdgePct - edgeThresholdPct;
  multiplier *=
    0.5 +
    Math.min(excessEdgePct, MODEL_EDGE_FULL_SCALE_PCT) /
      MODEL_EDGE_FULL_SCALE_PCT;

  // ── Convergence penalty ──────────────────────────────────────────────
  // Negative convergence_rate = soft odds moving toward sharp (value window
  // closing). Apply a smooth penalty instead of a hard cutoff.
  const convergence = features[F.convergence_rate] ?? 0;
  if (convergence < 0) {
    // convergence = -1 → multiplier *= 0.5 (max penalty)
    // convergence = 0  → multiplier *= 1.0 (no change)
    multiplier *= Math.max(0.5, 1 + convergence);
  }

  // ── Persistence bonus ────────────────────────────────────────────────
  // Bets persisting for 10+ ticks are more likely real value, not noise.
  const tickCount = features[F.tick_count] ?? 0;
  if (tickCount > 10) multiplier *= 1.2;

  // ── Steam confirmation ───────────────────────────────────────────────
  // Sharp steam move (Pinnacle odds moved ≥3% in 60s) in same direction
  // confirms market consensus aligning with our edge.
  const steamSharp = features[F.steam_move_sharp] ?? 0;
  if (steamSharp > 0) multiplier *= 1.3;

  return multiplier;
}

/**
 * Compute the permission-aware ML-adjusted Kelly stake.
 *
 * This is the primary entry point for the reactive detector and
 * auto-placer. It respects the deployment gate permission level:
 *
 * @param baseKelly       Raw Kelly fraction from value detector (e.g. 0.03)
 * @param mlScore         Calibrated P(win) from cloud scorer [0, 1], or null if no model
 * @param features        25-element feature vector
 * @param permissionLevel Current model's deployment permission
 * @param betId           Unique bet identifier (required for stake-increase pilot)
 * @returns               Adjusted Kelly fraction, or null if ML should not affect staking.
 *                        0 means "skip this bet" (gated). null means "use baseKelly unchanged".
 */
export function computeScoredStake(
  baseKelly: number,
  mlScore: number | null,
  features: number[],
  permissionLevel: MLPermissionLevel,
  betId?: string,
): number | null {
  // No model loaded → no ML effect, use base Kelly
  if (mlScore == null) return null;

  switch (permissionLevel) {
    case "observe":
      return null;

    case "gate_only":
      if (computeRawMultiplier(mlScore, features) === 0) return 0;
      return null;

    case "stake_reduce": {
      const raw = computeRawMultiplier(mlScore, features);
      if (raw === 0) return 0;
      // Pilot: coin-flip test for stake_increase promotion
      if (raw > 1.05 && betId) {
        if (isPilotActive() && pilotCoinFlip(betId)) {
          // Boosted group: apply uncapped as if stake_increase
          return Math.min(baseKelly * raw, baseKelly * 2);
        }
      }
      const capped = Math.min(raw, 1.0);
      return baseKelly * capped;
    }

    case "stake_increase": {
      const raw = computeRawMultiplier(mlScore, features);
      if (raw === 0) return 0;
      return Math.min(baseKelly * raw, baseKelly * 2);
    }

    default:
      return null;
  }
}

/**
 * Compute the permission-aware ML Kelly multiplier (not the adjusted Kelly).
 *
 * Returns the raw multiplier (1.0 = agree, <1 = shrink, >1 = boost, 0 = skip)
 * with permission-level checks applied. This is used by the reactive detector
 * to pass the raw multiplier to the auto-placer for stake sizing.
 *
 * @returns multiplier number, or null if ML should not affect staking
 */
export function computeKellyMultiplier(
  mlScore: number | null,
  features: number[],
  permissionLevel: MLPermissionLevel,
): number | null {
  if (mlScore == null) return null;

  switch (permissionLevel) {
    case "observe":
      return null;

    case "gate_only":
      if (computeRawMultiplier(mlScore, features) === 0) return 0;
      return 1.0;

    case "stake_reduce": {
      const raw = computeRawMultiplier(mlScore, features);
      if (raw === 0) return 0;
      return Math.min(raw, 1.0);
    }

    case "stake_increase": {
      const raw = computeRawMultiplier(mlScore, features);
      if (raw === 0) return 0;
      return Math.min(raw, 2.0);
    }

    default:
      return null;
  }
}

/**
 * Public alias of `computeRawMultiplier` for the paper-trading analytics API.
 * The paper-trading API needs to recompute the raw multiplier from stored
 * features to generate the baseline-vs-model comparison without
 * permission-level gating.
 */
export function computeRawStakeMultiplier(
  mlScore: number,
  features: number[],
): number {
  return computeRawMultiplier(mlScore, features);
}

/**
 * Convert calibrated P(win) into expected unit return at the offered odds.
 * Decimal odds EV per unit stake is p * odds - 1. The adjusted soft odds
 * feature already reflects commission when available.
 */
export function computeModelEdgePct(
  mlScore: number,
  features: number[],
): number {
  const adjustedSoftOdds = features[F.adjusted_soft_odds] ?? 0;
  const softOdds = features[F.soft_odds] ?? 0;
  const odds = adjustedSoftOdds > 1.01 ? adjustedSoftOdds : softOdds;
  return computeModelEdgePctAtEffectiveOdds(mlScore, odds);
}

/**
 * Compute model EV at a concrete book price. Used for placement-time audit
 * because the final accepted/booked odds may differ from the detected odds
 * that were present in the feature vector.
 */
export function computeModelEdgePctAtOdds(
  mlScore: number,
  softOdds: number,
  commissionPct = 0,
): number {
  const adjustedOdds =
    1 + (softOdds - 1) * (1 - Math.max(0, commissionPct) / 100);
  return computeModelEdgePctAtEffectiveOdds(mlScore, adjustedOdds);
}

function computeModelEdgePctAtEffectiveOdds(
  mlScore: number,
  effectiveOdds: number,
): number {
  if (
    !Number.isFinite(mlScore) ||
    !Number.isFinite(effectiveOdds) ||
    effectiveOdds <= 1.01
  ) {
    return -100;
  }
  return (mlScore * effectiveOdds - 1) * 100;
}

function passesSimpleEvOverlay(features: number[]): boolean {
  const sharpTrueProb = features[F.sharp_true_prob] ?? 0;
  const softOdds = features[F.soft_odds] ?? 0;
  const adjustedSoftOdds = features[F.adjusted_soft_odds] ?? 0;
  const marketType = features[F.market_type_encoded] ?? Number.NaN;
  const odds = adjustedSoftOdds > 1.01 ? adjustedSoftOdds : softOdds;
  const evPct =
    Number.isFinite(sharpTrueProb) && Number.isFinite(odds) && odds > 1.01
      ? (odds * sharpTrueProb - 1) * 100
      : Number.NEGATIVE_INFINITY;
  return (
    evPct >= SIMPLE_RULE_MIN_EV_PCT &&
    SIMPLE_RULE_MARKET_TYPE_CODES.has(marketType)
  );
}
