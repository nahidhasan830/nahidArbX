/**
 * ML Feature Extractor
 *
 * Extracts a 22-dimensional feature vector from a ValueBet and the
 * in-memory odds stores. Feature order is contractual — it must match
 * the Python training pipeline's `feature_names.py` exactly.
 *
 * All values are rounded to 4 decimals to prevent HOT-busting
 * float drift when re-persisting unchanged bets.
 */

import type { ValueBet } from "@/lib/atoms/value-detector";
import {
  getAtomHistory,
  getOrderedTicks,
  detectSteamMove,
  getMovementSummary,
} from "@/lib/atoms/odds-history";
import { getAllOddsForAtom } from "@/lib/atoms/store";
import { getFamily } from "@/lib/atoms/registry";
import { getCachedVigData } from "@/lib/atoms/value-detector";
import { getEvent } from "@/lib/store";
import {
  computeConvergenceRate,
  computeConvergenceRateFromTicks,
} from "@/lib/ml/convergence";
import { getCompetitionTier } from "@/lib/ml/competition-enrichment";
import {
  ML_WARMUP_MIN_TICKS,
  STEAM_MOVE_WINDOW_MS,
  STEAM_MOVE_MODERATE_PCT,
  STEAM_MOVE_STRONG_PCT,
} from "@/lib/shared/constants";
import { adjustOddsForCommission } from "@/lib/shared/commission";
import { differenceInMinutes } from "date-fns";
import type { AtomMarketType } from "@/lib/atoms/types";
import type { OddsMovementData } from "@/lib/bets-history/types";
export {
  FEATURE_NAMES,
  FEATURE_COUNT,
  FEATURE_VERSION,
  FEATURE_NAMES_HASH,
} from "@/lib/ml/feature-contract";
import { FEATURE_COUNT } from "@/lib/ml/feature-contract";

const MARKET_TYPE_ORDINAL: Record<string, number> = {
  MATCH_RESULT: 0,
  TOTAL_GOALS: 1,
  ASIAN_HANDICAP: 2,
  EUROPEAN_HANDICAP: 3,
  BTTS: 4,
  DNB: 5,
  DOUBLE_CHANCE: 6,
  HOME_TEAM_TOTAL: 7,
  AWAY_TEAM_TOTAL: 8,
  CORNERS: 9,
  CORNERS_HANDICAP: 10,
  CORNERS_EUROPEAN_HANDICAP: 11,
  HOME_CORNERS_TOTAL: 12,
  AWAY_CORNERS_TOTAL: 13,
  BOOKINGS: 14,
  BOOKINGS_HANDICAP: 15,
  ODD_EVEN_GOALS: 16,
  CLEAN_SHEET: 17,
  WIN_TO_NIL: 18,
  TO_SCORE: 19,
};

export type PersistedOddsMovement =
  | Record<string, OddsMovementData>
  | OddsMovementData
  | null
  | undefined;

export type HistoricalFeatureSkipReason =
  | "missing_odds_movement"
  | "missing_sharp_snapshot"
  | "missing_soft_snapshot"
  | "missing_sharp_opening_odds"
  | "missing_sharp_sparkline"
  | "missing_soft_sparkline"
  | "missing_vig_pct"
  | "invalid_true_prob"
  | "invalid_soft_odds"
  | "invalid_market_type"
  | "non_finite_feature"
  | "wrong_feature_length";

export interface HistoricalFeatureInput {
  eventStartTime: Date | string;
  firstSeenAt: Date | string;
  competition: string | null;
  marketType: string;
  familyLine: number | null;
  sharpProvider: string;
  sharpOdds: number;
  sharpTrueProb: number;
  softProvider: string;
  softCommissionPct: number;
  softOdds: number;
  numMarketsSameEvent?: number;
  oddsMovement: PersistedOddsMovement;
}

export type HistoricalFeatureExtractionResult =
  | { ok: true; features: number[] }
  | { ok: false; reasons: HistoricalFeatureSkipReason[] };

type HistoricalTick = {
  odds: number;
  timestamp: number;
};

function encodeDirection(dir: "up" | "down" | "stable" | undefined): number {
  if (dir === "up") return 1;
  if (dir === "down") return -1;
  return 0;
}

function roundFeatureValue(value: number): number {
  const safe = Number.isFinite(value) ? value : 0;
  return Math.round(safe * 10000) / 10000;
}

function isOddsMovementData(value: unknown): value is OddsMovementData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as OddsMovementData;
  return (
    typeof candidate.provider === "string" &&
    Array.isArray(candidate.sparkline) &&
    typeof candidate.totalTicks === "number"
  );
}

function normalizeHistoricalTicks(
  snapshot: OddsMovementData | undefined,
): HistoricalTick[] {
  if (!snapshot) return [];

  return snapshot.sparkline
    .filter(
      (point): point is [number, number] =>
        Array.isArray(point) &&
        point.length === 2 &&
        Number.isFinite(point[0]) &&
        Number.isFinite(point[1]) &&
        point[1] > 0,
    )
    .map(([timestamp, odds]) => ({ timestamp, odds }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

function computeHistoricalMovementPct(
  snapshot: OddsMovementData,
  ticks: HistoricalTick[],
): number {
  const openingOdds = snapshot.openingOdds;
  const latestTick = ticks[ticks.length - 1];
  if (!openingOdds || openingOdds <= 0 || !latestTick) return 0;

  const changePct = ((latestTick.odds - openingOdds) / openingOdds) * 100;
  return Math.max(-50, Math.min(50, changePct));
}

function computeHistoricalDirection(ticks: HistoricalTick[]): number {
  const window = ticks.slice(-10);
  if (window.length < 2) return 0;

  const first = window[0];
  const last = window[window.length - 1];
  if (!first || !last || first.odds <= 0) return 0;

  const changePct = ((last.odds - first.odds) / first.odds) * 100;
  if (changePct > 0.1) return 1;
  if (changePct < -0.1) return -1;
  return 0;
}

function computeHistoricalSteamMove(ticks: HistoricalTick[]): number {
  if (ticks.length < 3) return 0;

  const lastTick = ticks[ticks.length - 1];
  if (!lastTick) return 0;

  const cutoff = lastTick.timestamp - STEAM_MOVE_WINDOW_MS;
  const recent = ticks.filter((tick) => tick.timestamp >= cutoff);
  if (recent.length < 2) return 0;

  const first = recent[0];
  const last = recent[recent.length - 1];
  if (!first || !last || first.odds <= 0) return 0;

  const changePct = Math.abs((last.odds - first.odds) / first.odds) * 100;
  const durationMs = last.timestamp - first.timestamp;

  if (changePct < 1) return 0;
  if (changePct >= STEAM_MOVE_STRONG_PCT && durationMs <= 30_000) return 1;
  if (changePct >= STEAM_MOVE_MODERATE_PCT) return 1;
  return 0;
}

function computeHistoricalTickVelocity(ticks: HistoricalTick[]): number {
  if (ticks.length < 2) return 0;

  const first = ticks[0];
  const last = ticks[ticks.length - 1];
  if (!first || !last) return 0;

  const spanMs = last.timestamp - first.timestamp;
  if (spanMs <= 0) return 0;

  return (ticks.length / spanMs) * 60_000;
}

function computeHistoricalVigPct(
  sharpOdds: number,
  sharpTrueProb: number,
): number {
  if (!Number.isFinite(sharpOdds) || sharpOdds <= 1) return Number.NaN;
  if (!Number.isFinite(sharpTrueProb) || sharpTrueProb <= 0) return Number.NaN;

  const rawProb = 1 / sharpOdds;
  return (rawProb / sharpTrueProb - 1) * 100;
}

function computeHistoricalHoursSinceLineOpened(
  firstSeenAt: Date | string,
  ticks: HistoricalTick[],
): number {
  if (ticks.length === 0) return 0;

  const openingTick = ticks[0];
  if (!openingTick || !Number.isFinite(openingTick.timestamp)) return 0;

  const deltaMs = toDate(firstSeenAt).getTime() - openingTick.timestamp;
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return 0;

  return deltaMs / 3_600_000;
}

function isAsianLine(line: number | null): number {
  if (line == null) return 0;
  if ((line * 4) % 1 === 0 && line % 0.5 !== 0) return 1;
  return 0;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function pushReason(
  reasons: HistoricalFeatureSkipReason[],
  reason: HistoricalFeatureSkipReason,
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

export function normalizeHistoricalOddsMovement(
  oddsMovement: PersistedOddsMovement,
): Record<string, OddsMovementData> {
  if (!oddsMovement) return {};

  if (isOddsMovementData(oddsMovement)) {
    return oddsMovement.provider
      ? { [oddsMovement.provider]: oddsMovement }
      : {};
  }

  const normalized: Record<string, OddsMovementData> = {};
  for (const [provider, snapshot] of Object.entries(oddsMovement)) {
    if (!isOddsMovementData(snapshot)) continue;
    normalized[provider] = snapshot;
  }
  return normalized;
}

export function extractHistoricalFeatures(
  input: HistoricalFeatureInput,
): HistoricalFeatureExtractionResult {
  const reasons: HistoricalFeatureSkipReason[] = [];
  const normalizedMovement = normalizeHistoricalOddsMovement(
    input.oddsMovement,
  );
  const sharpSnapshot = normalizedMovement[input.sharpProvider];
  const softSnapshot = normalizedMovement[input.softProvider];
  const sharpTicks = normalizeHistoricalTicks(sharpSnapshot);
  const softTicks = normalizeHistoricalTicks(softSnapshot);
  const marketTypeEncoded =
    MARKET_TYPE_ORDINAL[input.marketType as AtomMarketType];
  const providerCount = Object.keys(normalizedMovement).length;
  const sharpDirection = computeHistoricalDirection(sharpTicks);
  const softDirection = computeHistoricalDirection(softTicks);
  const recoveredVigPct = computeHistoricalVigPct(
    input.sharpOdds,
    input.sharpTrueProb,
  );
  const hoursSinceLineOpened = computeHistoricalHoursSinceLineOpened(
    input.firstSeenAt,
    sharpTicks,
  );
  const numMarketsSameEvent = Math.max(1, input.numMarketsSameEvent ?? 1);

  if (!input.oddsMovement || providerCount === 0) {
    pushReason(reasons, "missing_odds_movement");
  }
  if (
    !Number.isFinite(input.sharpTrueProb) ||
    input.sharpTrueProb <= 0 ||
    input.sharpTrueProb >= 1
  ) {
    pushReason(reasons, "invalid_true_prob");
  }
  if (!Number.isFinite(input.softOdds) || input.softOdds <= 1) {
    pushReason(reasons, "invalid_soft_odds");
  }
  if (marketTypeEncoded == null) {
    pushReason(reasons, "invalid_market_type");
  }
  if (!sharpSnapshot) {
    pushReason(reasons, "missing_sharp_snapshot");
  }
  if (!softSnapshot) {
    pushReason(reasons, "missing_soft_snapshot");
  }
  if (
    sharpSnapshot &&
    (!sharpSnapshot.openingOdds || sharpSnapshot.openingOdds <= 0)
  ) {
    pushReason(reasons, "missing_sharp_opening_odds");
  }
  if (sharpSnapshot && sharpTicks.length === 0) {
    pushReason(reasons, "missing_sharp_sparkline");
  }
  if (softSnapshot && softTicks.length === 0) {
    pushReason(reasons, "missing_soft_sparkline");
  }
  if (!Number.isFinite(recoveredVigPct)) {
    pushReason(reasons, "missing_vig_pct");
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }

  const adjustedSoftOdds = adjustOddsForCommission(
    input.softOdds,
    input.softCommissionPct,
  );
  const sharpSoftSpread = input.softOdds - 1 / input.sharpTrueProb;
  const rawFeatures: number[] = [
    input.sharpTrueProb,
    input.softOdds,
    adjustedSoftOdds,
    sharpSnapshot?.totalTicks ?? 0,
    differenceInMinutes(
      toDate(input.eventStartTime),
      toDate(input.firstSeenAt),
    ),
    sharpSnapshot ? computeHistoricalMovementPct(sharpSnapshot, sharpTicks) : 0,
    softSnapshot ? computeHistoricalMovementPct(softSnapshot, softTicks) : 0,
    computeHistoricalSteamMove(sharpTicks),
    computeHistoricalSteamMove(softTicks),
    encodeDirection(
      sharpDirection > 0 ? "up" : sharpDirection < 0 ? "down" : "stable",
    ),
    encodeDirection(
      softDirection > 0 ? "up" : softDirection < 0 ? "down" : "stable",
    ),
    computeConvergenceRateFromTicks(sharpTicks, softTicks),
    computeHistoricalTickVelocity(softTicks),
    providerCount,
    sharpSnapshot?.openingOdds ?? 0,
    marketTypeEncoded,
    isAsianLine(input.familyLine),
    recoveredVigPct,
    getCompetitionTier(input.competition ?? ""),
    hoursSinceLineOpened,
    Number.isFinite(sharpSoftSpread) ? sharpSoftSpread : 0,
    numMarketsSameEvent,
  ];

  if (rawFeatures.length !== FEATURE_COUNT) {
    return { ok: false, reasons: ["wrong_feature_length"] };
  }
  if (rawFeatures.some((value) => !Number.isFinite(value))) {
    return { ok: false, reasons: ["non_finite_feature"] };
  }

  return {
    ok: true,
    features: rawFeatures.map(roundFeatureValue),
  };
}

export function extractFeatures(
  vb: ValueBet,
  numMarketsInEvent?: number,
): number[] {
  const eId = vb.eventId;
  const fId = vb.familyId;
  const aId = vb.atomId;

  const sharpHistory = getAtomHistory(eId, fId, aId, vb.sharpProvider);
  const sharpMovement = getMovementSummary(eId, fId, aId, vb.sharpProvider);
  const softMovement = getMovementSummary(eId, fId, aId, vb.softProvider);
  const family = getFamily(fId);
  const event = getEvent(eId);
  const vigData = getCachedVigData(eId, fId);

  let timeToKickoffMin = 0;
  if (event?.startTime) {
    timeToKickoffMin = differenceInMinutes(event.startTime, new Date());
  }

  let tickVelocity = 0;
  const softTicks = getOrderedTicks(eId, fId, aId, vb.softProvider);
  if (softTicks.length >= 2) {
    const first = softTicks[0];
    const last = softTicks[softTicks.length - 1];
    const spanMs = last.timestamp - first.timestamp;
    if (spanMs > 0) {
      tickVelocity = (softTicks.length / spanMs) * 60_000;
    }
  }

  const marketTypeEncoded =
    family != null
      ? (MARKET_TYPE_ORDINAL[family.market_type as AtomMarketType] ?? 0)
      : 0;

  let isAsianLineFeature = 0;
  if (family?.line != null) {
    const line = family.line;
    if ((line * 4) % 1 === 0 && line % 0.5 !== 0) {
      isAsianLineFeature = 1;
    }
  }

  let hoursSinceLineOpened = 0;
  const sharpOpenTs = sharpHistory?.openingTimestamp;
  if (sharpOpenTs != null && sharpOpenTs > 0) {
    hoursSinceLineOpened = (Date.now() - sharpOpenTs) / (1000 * 60 * 60);
  }
  hoursSinceLineOpened = Math.max(0, hoursSinceLineOpened);

  const sharpSoftSpread = vb.softOdds - 1 / vb.trueProb;
  const safeSharpSoftSpread = Number.isFinite(sharpSoftSpread)
    ? sharpSoftSpread
    : 0;
  const safeMarketCount = Math.max(1, numMarketsInEvent ?? 1);

  const features: number[] = [
    vb.trueProb,
    vb.softOdds,
    vb.adjustedSoftOdds,
    sharpHistory?.totalTicks ?? 0,
    timeToKickoffMin,
    sharpMovement?.changePct ?? 0,
    softMovement?.changePct ?? 0,
    detectSteamMove(eId, fId, aId, vb.sharpProvider) != null ? 1 : 0,
    detectSteamMove(eId, fId, aId, vb.softProvider) != null ? 1 : 0,
    encodeDirection(sharpMovement?.direction),
    encodeDirection(softMovement?.direction),
    computeConvergenceRate(eId, fId, aId, vb.sharpProvider, vb.softProvider),
    tickVelocity,
    getAllOddsForAtom(eId, fId, aId).size,
    sharpHistory?.openingOdds ?? 0,
    marketTypeEncoded,
    isAsianLineFeature,
    vigData?.vigPct ?? 0,
    getCompetitionTier(event?.competition ?? ""),
    hoursSinceLineOpened,
    safeSharpSoftSpread,
    safeMarketCount,
  ];

  return features.map(roundFeatureValue);
}

export function isFeatureWarm(features: number[]): boolean {
  const tickCount = features[3] ?? 0;
  return tickCount >= ML_WARMUP_MIN_TICKS;
}
