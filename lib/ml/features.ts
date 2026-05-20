/**
 * ML Feature Extractor
 *
 * Extracts a 25-dimensional feature vector from a ValueBet and the
 * in-memory odds stores. Feature order is contractual — it must match
 * the Python training pipeline's `feature_names.py` exactly.
 *
 * All values are rounded to 4 decimal places to prevent HOT-busting
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
import { computeConvergenceRate } from "@/lib/ml/convergence";
import { getCompetitionTier } from "@/lib/ml/competition-enrichment";
import { ML_WARMUP_MIN_TICKS } from "@/lib/shared/constants";
import { differenceInMinutes } from "date-fns";
import type { AtomMarketType } from "@/lib/atoms/types";
export {
  FEATURE_NAMES,
  FEATURE_COUNT,
  FEATURE_VERSION,
  FEATURE_NAMES_HASH,
} from "@/lib/ml/feature-contract";

// ============================================
// Market type ordinal encoding
// ============================================

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

// ============================================
// Direction encoding
// ============================================

function encodeDirection(dir: "up" | "down" | "stable" | undefined): number {
  if (dir === "up") return 1;
  if (dir === "down") return -1;
  return 0;
}

// ============================================
// Feature Extraction
// ============================================

/**
 * Extract a 25-element feature vector from a ValueBet.
 *
 * All values default to 0 for null/undefined sources.
 * All values rounded to 4 decimal places.
 */
export function extractFeatures(
  vb: ValueBet,
  numMarketsInEvent?: number,
): number[] {
  const eId = vb.eventId;
  const fId = vb.familyId;
  const aId = vb.atomId;

  // Pre-fetch shared data
  const sharpHistory = getAtomHistory(eId, fId, aId, vb.sharpProvider);
  const sharpMovement = getMovementSummary(eId, fId, aId, vb.sharpProvider);
  const softMovement = getMovementSummary(eId, fId, aId, vb.softProvider);
  const family = getFamily(fId);
  const event = getEvent(eId);
  const vigData = getCachedVigData(eId, fId);

  // Feature 7: time to kickoff
  let timeToKickoffMin = 0;
  if (event?.startTime) {
    timeToKickoffMin = differenceInMinutes(event.startTime, new Date());
  }

  // Feature 15: tick velocity (ticks per minute)
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

  // Feature 18: market type encoding
  const marketTypeEncoded =
    family != null
      ? (MARKET_TYPE_ORDINAL[family.market_type as AtomMarketType] ?? 0)
      : 0;

  // Feature 19: is asian line
  let isAsianLine = 0;
  if (family?.line != null) {
    const line = family.line;
    if ((line * 4) % 1 === 0 && line % 0.5 !== 0) {
      isAsianLine = 1;
    }
  }

  // Feature 22: hours_since_line_opened
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
    /* 0  ev_pct            */ vb.evPct,
    /* 1  sharp_true_prob   */ vb.trueProb,
    /* 2  soft_odds         */ vb.softOdds,
    /* 3  adjusted_soft_odds */ vb.adjustedSoftOdds,
    /* 4  implied_prob_gap  */ vb.trueProb - 1 / vb.softOdds,
    /* 5  tick_count        */ sharpHistory?.totalTicks ?? 0,
    /* 6  time_to_kickoff   */ timeToKickoffMin,
    /* 7  movement_pct_sharp */ sharpMovement?.changePct ?? 0,
    /* 8  movement_pct_soft */ softMovement?.changePct ?? 0,
    /* 9  steam_move_sharp  */ detectSteamMove(
      eId,
      fId,
      aId,
      vb.sharpProvider,
    ) != null
      ? 1
      : 0,
    /* 10 steam_move_soft   */ detectSteamMove(
      eId,
      fId,
      aId,
      vb.softProvider,
    ) != null
      ? 1
      : 0,
    /* 11 sharp_direction   */ encodeDirection(sharpMovement?.direction),
    /* 12 soft_direction    */ encodeDirection(softMovement?.direction),
    /* 13 convergence_rate  */ computeConvergenceRate(
      eId,
      fId,
      aId,
      vb.sharpProvider,
      vb.softProvider,
    ),
    /* 14 tick_velocity     */ tickVelocity,
    /* 15 provider_count    */ getAllOddsForAtom(eId, fId, aId).size,
    /* 16 opening_sharp_odds */ sharpHistory?.openingOdds ?? 0,
    /* 17 market_type_encoded */ marketTypeEncoded,
    /* 18 is_asian_line     */ isAsianLine,
    /* 19 kelly_fraction_raw */ vb.kellyFraction,
    /* 20 vig_pct           */ vigData?.vigPct ?? 0,
    /* 21 competition_tier  */ getCompetitionTier(event?.competition ?? ""),
    /* 22 hours_since_line_opened */ hoursSinceLineOpened,
    /* 23 sharp_soft_spread */ safeSharpSoftSpread,
    /* 24 num_markets_same_event */ safeMarketCount,
  ];

  // Round all values to 4 decimal places to prevent HOT-busting float drift
  return features.map((v) => {
    const safe = Number.isFinite(v) ? v : 0;
    return Math.round(safe * 10000) / 10000;
  });
}

// ============================================
// Warmup Quality Gate
// ============================================

/**
 * Check whether the history-dependent features for a bet are warm enough
 * to produce a trustworthy ML score.
 *
 * After an engine restart, odds history starts cold — tick_count,
 * movement, steam, convergence, tick_velocity, opening sharp odds, and
 * hours_since_line_opened are all zero or near-zero. Scoring such
 * features produces misleading confidence. This function lets callers
 * know when to suppress ML scoring.
 *
 * Returns true when the sharp-provider tick count meets the minimum
 * warmup threshold (ML_WARMUP_MIN_TICKS). The threshold is intentionally
 * low (3) because even partial history is better than none once
 * opening odds have been observed.
 */
export function isFeatureWarm(features: number[]): boolean {
  // Feature index 5 = tick_count (sharp provider)
  const tickCount = features[5] ?? 0;
  return tickCount >= ML_WARMUP_MIN_TICKS;
}
