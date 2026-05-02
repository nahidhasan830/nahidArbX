/**
 * ML Staker — Dynamic Kelly Sizing Based on ML Score
 *
 * Adjusts the base Kelly fraction using the ML model's confidence score
 * and feature-derived signals. The goal is to bet more aggressively on
 * high-confidence opportunities and reduce or skip low-confidence ones.
 *
 * Key design decisions:
 *   - Score below ML_MIN_SCORE → return 0 (skip bet entirely)
 *   - Linear score scaling: 0.4→1.0 maps to 0.5×→1.5× multiplier
 *   - Convergence penalty: negative convergence_rate (soft moving toward
 *     sharp) reduces sizing since the value window is closing
 *   - Persistence bonus: bets that persist for 10+ ticks are more real
 *   - Steam confirmation: sharp steam move confirms edge direction
 *   - Capped at 2× base Kelly to prevent over-leverage
 */

import { FEATURE_NAMES } from "./features";
import { ML_MIN_SCORE } from "@/lib/shared/constants";

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
 * Compute a dynamically adjusted Kelly stake.
 *
 * @param baseKelly - Raw Kelly fraction from value detector (fractional, e.g. 0.03)
 * @param mlScore - P(profitable) from ONNX scorer [0, 1]
 * @param features - 23-element feature vector (same indices as FEATURE_NAMES)
 * @returns Adjusted Kelly fraction. 0 means "skip this bet".
 */
export function computeAdjustedKelly(
  baseKelly: number,
  mlScore: number,
  features: number[],
): number {
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

  // ── Cap at 2× base Kelly to prevent over-leverage ───────────────────
  return Math.min(baseKelly * multiplier, baseKelly * 2);
}
