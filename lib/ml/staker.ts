
import { FEATURE_INDEX } from "./feature-contract";
import {
  getPolicyEdgeThresholdPct,
  type MLPermissionLevel,
} from "./deployment-gate";
import { isPilotActive, pilotCoinFlip } from "./pilot";


const F = FEATURE_INDEX;

const MODEL_EDGE_FULL_SCALE_PCT = 10;
const SIMPLE_RULE_MIN_EV_PCT = 3;
const SIMPLE_RULE_MARKET_TYPE_CODES = new Set([0, 2]);

export function capProbAtSharp(mlScore: number, features: number[]): number {
  const sharpTrueProb = features[F.sharp_true_prob] ?? Number.NaN;
  if (!Number.isFinite(sharpTrueProb) || sharpTrueProb <= 0 || sharpTrueProb > 1) {
    return mlScore;
  }
  return Math.min(mlScore, sharpTrueProb);
}


function computeRawMultiplier(mlScore: number, features: number[]): number {
  if (!passesSimpleEvOverlay(features)) return 0;

  const modelEdgePct = computeModelEdgePct(mlScore, features);
  const edgeThresholdPct = getPolicyEdgeThresholdPct();
  if (modelEdgePct <= edgeThresholdPct) return 0;

  let multiplier = 1.0;

  const excessEdgePct = modelEdgePct - edgeThresholdPct;
  multiplier *=
    0.5 +
    Math.min(excessEdgePct, MODEL_EDGE_FULL_SCALE_PCT) /
      MODEL_EDGE_FULL_SCALE_PCT;

  const convergence = features[F.convergence_rate] ?? 0;
  if (convergence < 0) {
    multiplier *= Math.max(0.5, 1 + convergence);
  }

  const tickCount = features[F.tick_count] ?? 0;
  if (tickCount > 10) multiplier *= 1.2;

  const steamSharp = features[F.steam_move_sharp] ?? 0;
  if (steamSharp > 0) multiplier *= 1.3;

  return multiplier;
}

export function computeScoredStake(
  baseKelly: number,
  mlScore: number | null,
  features: number[],
  permissionLevel: MLPermissionLevel,
  betId?: string,
): number | null {
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
      if (raw > 1.05 && betId) {
        if (isPilotActive() && pilotCoinFlip(betId)) {
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

export function computeRawStakeMultiplier(
  mlScore: number,
  features: number[],
): number {
  return computeRawMultiplier(mlScore, features);
}

export function computeModelEdgePct(
  mlScore: number,
  features: number[],
): number {
  const adjustedSoftOdds = features[F.adjusted_soft_odds] ?? 0;
  const softOdds = features[F.soft_odds] ?? 0;
  const odds = adjustedSoftOdds > 1.01 ? adjustedSoftOdds : softOdds;
  return computeModelEdgePctAtEffectiveOdds(
    capProbAtSharp(mlScore, features),
    odds,
  );
}

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
