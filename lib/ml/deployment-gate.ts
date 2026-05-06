/**
 * ML Deployment Gate — runtime permission checking for deployed models.
 *
 * Phase 7 of the ML optimizer plan. This module provides runtime
 * permission-level checks that determine how the ML model's score
 * affects bet placement behavior.
 *
 * Permission levels (escalation order):
 *   - shadow: score and log only — no effect on placement
 *   - gate_only: can skip low-score bets (below ML_MIN_SCORE)
 *   - stake_reduce: can reduce stake on weak bets (never increase)
 *   - stake_increase: can increase stake on strong bets
 *     (disabled until real placed-settled evidence exists)
 *
 * The permission level is stored in ml_models.permission_level and
 * set by the Python training pipeline's deployment gate after training.
 * This module reads the deployed model's permission level and provides
 * helpers for the auto-placer and staker to check what operations
 * the current model is allowed to perform.
 */

import { singleton } from "@/lib/util/singleton";
import { logger } from "@/lib/shared/logger";

// ============================================
// Permission levels
// ============================================

export type MLPermissionLevel =
  | "shadow"
  | "gate_only"
  | "stake_reduce"
  | "stake_increase";

/** All valid permission levels in escalation order. */
export const PERMISSION_LEVELS: readonly MLPermissionLevel[] = [
  "shadow",
  "gate_only",
  "stake_reduce",
  "stake_increase",
] as const;

// ============================================
// Singleton state
// ============================================

interface DeploymentGateState {
  /** Current model's permission level (from ml_models row). */
  permissionLevel: MLPermissionLevel;
  /** Model version this permission applies to. */
  modelVersion: number | null;
  /** Last time the permission was refreshed from DB. */
  lastRefreshedAt: number;
}

const state = singleton("ml:deployment-gate", (): DeploymentGateState => ({
  permissionLevel: "shadow",
  modelVersion: null,
  lastRefreshedAt: 0,
}));

/** How often to re-read permission level from DB (ms). */
const REFRESH_INTERVAL_MS = 60_000;

// ============================================
// Public API
// ============================================

/**
 * Refresh the deployment gate state from the deployed model's DB row.
 * Called periodically by the model watcher in scorer.ts.
 */
export async function refreshPermissionLevel(): Promise<void> {
  try {
    const now = Date.now();
    if (now - state.lastRefreshedAt < REFRESH_INTERVAL_MS) return;

    const { db } = await import("@/lib/db/client");
    const { mlModels } = await import("@/lib/db/schema");
    const { eq, desc } = await import("drizzle-orm");

    const [deployed] = await db
      .select({
        version: mlModels.version,
        permissionLevel: mlModels.permissionLevel,
      })
      .from(mlModels)
      .where(eq(mlModels.status, "deployed"))
      .orderBy(desc(mlModels.deployedAt))
      .limit(1);

    if (deployed) {
      const level = parsePermissionLevel(deployed.permissionLevel);
      state.permissionLevel = level;
      state.modelVersion = deployed.version;
    } else {
      // No deployed model — default to shadow (pass-through)
      state.permissionLevel = "shadow";
      state.modelVersion = null;
    }
    state.lastRefreshedAt = now;
  } catch (err) {
    logger.warn(
      "MLDeploymentGate",
      `Failed to refresh permission level: ${(err as Error).message}`,
    );
  }
}

/**
 * Get the current model's permission level.
 * Returns "shadow" if no model is deployed.
 */
export function getPermissionLevel(): MLPermissionLevel {
  return state.permissionLevel;
}

/**
 * Get the current model version (null if no model deployed).
 */
export function getModelVersion(): number | null {
  return state.modelVersion;
}

/**
 * Check if the current model is allowed to gate bets (skip low-score bets).
 * Requires gate_only or higher.
 */
export function canGateBets(): boolean {
  return permissionAtLeast(state.permissionLevel, "gate_only");
}

/**
 * Check if the current model is allowed to reduce stakes on weak bets.
 * Requires stake_reduce or higher.
 */
export function canReduceStake(): boolean {
  return permissionAtLeast(state.permissionLevel, "stake_reduce");
}

/**
 * Check if the current model is allowed to increase stakes on strong bets.
 * Requires stake_increase — currently impossible without real placed-settled data.
 */
export function canIncreaseStake(): boolean {
  return permissionAtLeast(state.permissionLevel, "stake_increase");
}

/**
 * Get the full deployment gate status for diagnostics.
 */
export function getDeploymentGateStatus() {
  return {
    permissionLevel: state.permissionLevel,
    modelVersion: state.modelVersion,
    canGate: canGateBets(),
    canReduceStake: canReduceStake(),
    canIncreaseStake: canIncreaseStake(),
    lastRefreshedAt: state.lastRefreshedAt > 0
      ? new Date(state.lastRefreshedAt).toISOString()
      : null,
  };
}

// ============================================
// Helpers
// ============================================

/**
 * Parse a permission level string into a typed value.
 * Falls back to "shadow" for unknown values.
 */
function parsePermissionLevel(raw: string | null | undefined): MLPermissionLevel {
  if (raw && (PERMISSION_LEVELS as readonly string[]).includes(raw)) {
    return raw as MLPermissionLevel;
  }
  return "shadow";
}

/**
 * Check if `current` is at least `required` level.
 * Uses the PERMISSION_LEVELS ordering for comparison.
 */
function permissionAtLeast(
  current: MLPermissionLevel,
  required: MLPermissionLevel,
): boolean {
  const currentIdx = PERMISSION_LEVELS.indexOf(current);
  const requiredIdx = PERMISSION_LEVELS.indexOf(required);
  return currentIdx >= requiredIdx;
}
