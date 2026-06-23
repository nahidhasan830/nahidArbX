
import { singleton } from "@/lib/util/singleton";
import { logger } from "@/lib/shared/logger";


export type MLPermissionLevel =
  | "observe"
  | "gate_only"
  | "stake_reduce"
  | "stake_increase";

export const PERMISSION_LEVELS: readonly MLPermissionLevel[] = [
  "observe",
  "gate_only",
  "stake_reduce",
  "stake_increase",
] as const;


interface DeploymentGateState {
  permissionLevel: MLPermissionLevel;
  policyEdgeThresholdPct: number;
  policyEdgeThresholdSource: PolicyEdgeThresholdSource;
  modelVersion: number | null;
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

const REFRESH_INTERVAL_MS = 60_000;

export const POLICY_EDGE_THRESHOLD_DENY_ALL_PCT = 1_000_000;

export type PolicyEdgeThresholdSource =
  | "artifact"
  | "missing_artifact"
  | "no_model";

export interface PolicyEdgeThresholdResolution {
  thresholdPct: number;
  source: PolicyEdgeThresholdSource;
}


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

export function getPermissionLevel(): MLPermissionLevel {
  return state.permissionLevel;
}

export function getModelVersion(): number | null {
  return state.modelVersion;
}

export function getPolicyEdgeThresholdPct(): number {
  return state.policyEdgeThresholdPct;
}

export function getPolicyEdgeThresholdSource(): PolicyEdgeThresholdSource {
  return state.policyEdgeThresholdSource;
}

export function canGateBets(): boolean {
  return permissionAtLeast(state.permissionLevel, "gate_only");
}

export function canReduceStake(): boolean {
  return permissionAtLeast(state.permissionLevel, "stake_reduce");
}

export function canIncreaseStake(): boolean {
  return permissionAtLeast(state.permissionLevel, "stake_increase");
}

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

function permissionAtLeast(
  current: MLPermissionLevel,
  required: MLPermissionLevel,
): boolean {
  const currentIdx = PERMISSION_LEVELS.indexOf(current);
  const requiredIdx = PERMISSION_LEVELS.indexOf(required);
  return currentIdx >= requiredIdx;
}
