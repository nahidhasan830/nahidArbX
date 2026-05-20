/**
 * ML Deployment Gate — runtime permission checking for deployed models.
 *
 * Phase 7 of the ML optimizer plan. This module provides runtime
 * permission-level checks that determine how the ML model's score
 * affects bet placement behavior.
 *
 * Permission levels (escalation order):
 *   - observe: score and log only — no effect on placement
 *   - gate_only: can skip bets below the model's learned EV threshold
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
  | "observe"
  | "gate_only"
  | "stake_reduce"
  | "stake_increase";

/** All valid permission levels in escalation order. */
export const PERMISSION_LEVELS: readonly MLPermissionLevel[] = [
  "observe",
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
  /** Learned model-edge threshold selected during training. */
  policyEdgeThresholdPct: number;
  /** Where the current model-edge threshold came from. */
  policyEdgeThresholdSource: PolicyEdgeThresholdSource;
  /** Model version this permission applies to. */
  modelVersion: number | null;
  /** Last time the permission was refreshed from DB. */
  lastRefreshedAt: number;
}

const state = singleton(
  "ml:deployment-gate",
  (): DeploymentGateState => ({
    permissionLevel: "observe",
    policyEdgeThresholdPct: 0,
    policyEdgeThresholdSource: "no_model",
    modelVersion: null,
    lastRefreshedAt: 0,
  }),
);

/** How often to re-read permission level from DB (ms). */
const REFRESH_INTERVAL_MS = 60_000;

/**
 * Old artifacts did not persist a learned policy threshold. Active runtime
 * permissions must fail closed instead of silently falling back to edge > 0.
 */
export const POLICY_EDGE_THRESHOLD_DENY_ALL_PCT = 1_000_000;

export type PolicyEdgeThresholdSource = "artifact" | "missing_artifact" | "no_model";

export interface PolicyEdgeThresholdResolution {
  thresholdPct: number;
  source: PolicyEdgeThresholdSource;
}

// ============================================
// Public API
// ============================================

/**
 * Refresh the deployment gate state from the deployed model's DB row.
 * Called periodically by the model watcher in scorer.ts.
 */
export async function refreshPermissionLevel(force = false): Promise<void> {
  try {
    const now = Date.now();
    if (!force && now - state.lastRefreshedAt < REFRESH_INTERVAL_MS) return;

    const { db } = await import("@/lib/db/client");
    const { mlModels } = await import("@/lib/db/schema");
    const { eq, desc } = await import("drizzle-orm");

    const [deployed] = await db
      .select({
        version: mlModels.version,
        permissionLevel: mlModels.permissionLevel,
        trainingReport: mlModels.trainingReport,
      })
      .from(mlModels)
      .where(eq(mlModels.status, "deployed"))
      .orderBy(desc(mlModels.deployedAt))
      .limit(1);

    if (deployed) {
      const previousVersion = state.modelVersion;
      const level = parsePermissionLevel(deployed.permissionLevel);
      const threshold = resolvePolicyEdgeThreshold(deployed.trainingReport);
      state.permissionLevel = level;
      state.policyEdgeThresholdPct = threshold.thresholdPct;
      state.policyEdgeThresholdSource = threshold.source;
      state.modelVersion = deployed.version;

      if (threshold.source !== "artifact" && level !== "observe") {
        logger.warn(
          "MLDeploymentGate",
          `Model v${deployed.version} has active permission=${level} but no learned policy threshold; failing closed at edge>${threshold.thresholdPct}%`,
        );
      }
      if (force || previousVersion !== deployed.version) {
        logger.info(
          "MLDeploymentGate",
          `Loaded model v${deployed.version}: permission=${level}, policyEdgeThreshold=${threshold.thresholdPct}% (${threshold.source})`,
        );
      }
    } else {
      // No deployed model — default to observe (pass-through)
      state.permissionLevel = "observe";
      state.policyEdgeThresholdPct = 0;
      state.policyEdgeThresholdSource = "no_model";
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
 * Returns "observe" if no model is deployed.
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
 * Get the current model's learned model-edge threshold.
 */
export function getPolicyEdgeThresholdPct(): number {
  return state.policyEdgeThresholdPct;
}

/**
 * Get the source of the current model-edge threshold.
 */
export function getPolicyEdgeThresholdSource(): PolicyEdgeThresholdSource {
  return state.policyEdgeThresholdSource;
}

/**
 * Check if the current model is allowed to gate bets with low model EV.
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
    policyEdgeThresholdPct: state.policyEdgeThresholdPct,
    policyEdgeThresholdSource: state.policyEdgeThresholdSource,
    modelVersion: state.modelVersion,
    canGate: canGateBets(),
    canReduceStake: canReduceStake(),
    canIncreaseStake: canIncreaseStake(),
    lastRefreshedAt:
      state.lastRefreshedAt > 0
        ? new Date(state.lastRefreshedAt).toISOString()
        : null,
  };
}

// ============================================
// Helpers
// ============================================

/**
 * Parse a permission level string into a typed value.
 * Falls back to "observe" for unknown values.
 */
function parsePermissionLevel(
  raw: string | null | undefined,
): MLPermissionLevel {
  if (raw && (PERMISSION_LEVELS as readonly string[]).includes(raw)) {
    return raw as MLPermissionLevel;
  }
  return "observe";
}

export function resolvePolicyEdgeThreshold(
  report: unknown,
): PolicyEdgeThresholdResolution {
  if (!report || typeof report !== "object") {
    return {
      thresholdPct: POLICY_EDGE_THRESHOLD_DENY_ALL_PCT,
      source: "missing_artifact",
    };
  }

  const raw = (report as Record<string, unknown>).policy_edge_threshold_pct;
  const threshold =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : Number.NaN;

  if (
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold >= POLICY_EDGE_THRESHOLD_DENY_ALL_PCT
  ) {
    return {
      thresholdPct: POLICY_EDGE_THRESHOLD_DENY_ALL_PCT,
      source: "missing_artifact",
    };
  }

  return { thresholdPct: threshold, source: "artifact" };
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
