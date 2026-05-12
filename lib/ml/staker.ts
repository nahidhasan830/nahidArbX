/**
 * ML Staker — Permission-Aware Kelly Sizing
 *
 * Phase 8 of the ML optimizer plan. Adjusts the base Kelly fraction
 * using the ML model's confidence score and feature-derived signals,
 * but ONLY when the deployment gate grants the appropriate permission.
 *
 * Permission-level behavior:
 *   - shadow:         returns null (no Kelly adjustment — persist score only)
 *   - gate_only:      returns 0 when model EV is <= break-even, 1 otherwise
 *                     (the auto-placer uses 1.0 as pass-through sizing)
 *   - stake_reduce:   applies full multiplier logic but caps at 1.0×
 *                     (can reduce Kelly, never increase)
 *   - stake_increase: applies full multiplier logic (future only)
 *
 * Key design decisions:
 *   - Model EV <= 0 at offered odds → return 0 (skip bet entirely)
 *   - Positive model EV scales smoothly from 0.5× toward 1.5×
 *   - Convergence penalty: negative convergence_rate (soft moving toward
 *     sharp) reduces sizing since the value window is closing
 *   - Persistence bonus: bets that persist for 10+ ticks are more real
 *   - Steam confirmation: sharp steam move confirms edge direction
 *   - Capped at 2× base Kelly to prevent over-leverage (stake_increase only)
 *   - Capped at 1× base Kelly for stake_reduce (never increase)
 */

import { FEATURE_NAMES } from "./features";
import type { MLPermissionLevel } from "./deployment-gate";
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
const F = Object.fromEntries(
  FEATURE_NAMES.map((n, i) => [n, i]),
) as Record<string, number>;

const MODEL_EDGE_FULL_SCALE_PCT = 10;

// ============================================
// Public API
// ============================================

/**
 * Compute the raw Kelly multiplier from ML score + features.
 * This is the internal engine — permission checking is done by
 * `computeScoredStake()` which wraps this.
 */
function computeRawMultiplier(mlScore: number, features: number[]): number {
  const modelEdgePct = computeModelEdgePct(mlScore, features);
  if (modelEdgePct <= 0) return 0; // Model says offered odds are not +EV

  let multiplier = 1.0;

  // ── Score-based scaling ──────────────────────────────────────────────
  // Linear interpolation: 0% model edge → 0.5×, 10%+ model edge → 1.5×.
  // This optimizes expected return at the offered odds, not raw win probability.
  multiplier *=
    0.5 + Math.min(modelEdgePct, MODEL_EDGE_FULL_SCALE_PCT) / MODEL_EDGE_FULL_SCALE_PCT;

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
 * @param mlScore         Calibrated P(win) from ONNX scorer [0, 1], or null if no model
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
    case "shadow":
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
 * Legacy API — kept for backward compatibility with shadow-mode logging.
 * Computes the raw adjusted Kelly without permission checking.
 *
 * @deprecated Use `computeScoredStake()` instead.
 */
export function computeAdjustedKelly(
  baseKelly: number,
  mlScore: number,
  features: number[],
): number {
  const raw = computeRawMultiplier(mlScore, features);
  if (raw === 0) return 0;
  return Math.min(baseKelly * raw, baseKelly * 2);
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
    case "shadow":
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
 * Public alias of `computeRawMultiplier` for the shadow analytics API.
 * The shadow API needs to recompute the raw multiplier from stored features
 * to generate the shadow A/B comparison without permission-level gating.
 */
export function computeRawMultiplierForShadow(
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
export function computeModelEdgePct(mlScore: number, features: number[]): number {
  const adjustedSoftOdds = features[F.adjusted_soft_odds] ?? 0;
  const softOdds = features[F.soft_odds] ?? 0;
  const odds = adjustedSoftOdds > 1.01 ? adjustedSoftOdds : softOdds;
  if (!Number.isFinite(mlScore) || !Number.isFinite(odds) || odds <= 1.01) {
    return -100;
  }
  return (mlScore * odds - 1) * 100;
}
