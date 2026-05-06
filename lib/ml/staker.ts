/**
 * ML Staker — Permission-Aware Kelly Sizing
 *
 * Phase 8 of the ML optimizer plan. Adjusts the base Kelly fraction
 * using the ML model's confidence score and feature-derived signals,
 * but ONLY when the deployment gate grants the appropriate permission.
 *
 * Permission-level behavior:
 *   - shadow:         returns null (no Kelly adjustment — persist score only)
 *   - gate_only:      returns 0 for low scores, null for above-threshold
 *                     (the auto-placer skips low-score bets, but doesn't
 *                     adjust Kelly sizing for passing bets)
 *   - stake_reduce:   applies full multiplier logic but caps at 1.0×
 *                     (can reduce Kelly, never increase)
 *   - stake_increase: applies full multiplier logic (future only)
 *
 * Key design decisions:
 *   - Score below ML_MIN_SCORE → return 0 (skip bet entirely)
 *   - Linear score scaling: 0.4→1.0 maps to 0.5×→1.5× multiplier
 *   - Convergence penalty: negative convergence_rate (soft moving toward
 *     sharp) reduces sizing since the value window is closing
 *   - Persistence bonus: bets that persist for 10+ ticks are more real
 *   - Steam confirmation: sharp steam move confirms edge direction
 *   - Capped at 2× base Kelly to prevent over-leverage (stake_increase only)
 *   - Capped at 1× base Kelly for stake_reduce (never increase)
 */

import { FEATURE_NAMES } from "./features";
import { ML_MIN_SCORE } from "@/lib/shared/constants";
import type { MLPermissionLevel } from "./deployment-gate";

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

// ============================================
// Public API
// ============================================

/**
 * Compute the raw Kelly multiplier from ML score + features.
 * This is the internal engine — permission checking is done by
 * `computeScoredStake()` which wraps this.
 */
function computeRawMultiplier(mlScore: number, features: number[]): number {
  if (mlScore < ML_MIN_SCORE) return 0; // Below confidence threshold — skip

  let multiplier = 1.0;

  // ── Score-based scaling ──────────────────────────────────────────────
  // Linear interpolation: ML_MIN_SCORE (0.4) → 1.0 maps to 0.5× → 1.5×
  // This gives graduated sizing rather than a binary gate.
  multiplier *= 0.5 + ((mlScore - ML_MIN_SCORE) / (1.0 - ML_MIN_SCORE));

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
 * @param mlScore         P(profitable) from ONNX scorer [0, 1], or null if no model
 * @param features        25-element feature vector
 * @param permissionLevel Current model's deployment permission
 * @returns               Adjusted Kelly fraction, or null if ML should not affect staking.
 *                        0 means "skip this bet" (gated). null means "use baseKelly unchanged".
 */
export function computeScoredStake(
  baseKelly: number,
  mlScore: number | null,
  features: number[],
  permissionLevel: MLPermissionLevel,
): number | null {
  // No model loaded → no ML effect, use base Kelly
  if (mlScore == null) return null;

  switch (permissionLevel) {
    case "shadow":
      // Score is persisted for analysis, but no effect on staking
      return null;

    case "gate_only":
      // Below threshold → skip (return 0). Above threshold → no adjustment.
      if (mlScore < ML_MIN_SCORE) return 0;
      return null; // pass through — use base Kelly unchanged

    case "stake_reduce": {
      // Full multiplier logic, but capped at 1.0× (can reduce, never increase)
      const raw = computeRawMultiplier(mlScore, features);
      if (raw === 0) return 0; // below threshold
      const capped = Math.min(raw, 1.0); // never increase
      return baseKelly * capped;
    }

    case "stake_increase": {
      // Full multiplier logic with 2× ceiling
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
