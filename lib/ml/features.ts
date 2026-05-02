/**
 * ML Feature Extractor
 *
 * Extracts a 23-dimensional feature vector from a ValueBet and the
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
import { getProviderCommission } from "@/lib/providers/registry";
import { getEvent } from "@/lib/store";
import { computeConvergenceRate } from "@/lib/ml/convergence";
import { differenceInMinutes } from "date-fns";
import type { AtomMarketType } from "@/lib/atoms/types";

// ============================================
// Feature Names — contractual ordering
// ============================================

export const FEATURE_NAMES: string[] = [
  "ev_pct",                // 0
  "sharp_true_prob",       // 1
  "soft_odds",             // 2
  "adjusted_soft_odds",    // 3
  "implied_prob_gap",      // 4
  "soft_odds_age_ms",      // 5
  "tick_count",            // 6
  "time_to_kickoff_min",   // 7
  "movement_pct_sharp",    // 8
  "movement_pct_soft",     // 9
  "steam_move_sharp",      // 10
  "steam_move_soft",       // 11
  "sharp_direction",       // 12
  "soft_direction",        // 13
  "convergence_rate",      // 14
  "tick_velocity",         // 15
  "provider_count",        // 16
  "opening_sharp_odds",    // 17
  "market_type_encoded",   // 18
  "is_asian_line",         // 19
  "commission_pct",        // 20
  "kelly_fraction_raw",    // 21
  "vig_pct",               // 22
];

export const FEATURE_COUNT = 23;

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
 * Extract a 23-element feature vector from a ValueBet.
 *
 * All values default to 0 for null/undefined sources.
 * All values rounded to 4 decimal places.
 */
export function extractFeatures(vb: ValueBet): number[] {
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

  const features: number[] = [
    /* 0  ev_pct            */ vb.evPct,
    /* 1  sharp_true_prob   */ vb.trueProb,
    /* 2  soft_odds         */ vb.softOdds,
    /* 3  adjusted_soft_odds */ vb.adjustedSoftOdds,
    /* 4  implied_prob_gap  */ vb.trueProb - 1 / vb.softOdds,
    /* 5  soft_odds_age_ms  */ Date.now() - vb.timestamp,
    /* 6  tick_count        */ sharpHistory?.totalTicks ?? 0,
    /* 7  time_to_kickoff   */ timeToKickoffMin,
    /* 8  movement_pct_sharp */ sharpMovement?.changePct ?? 0,
    /* 9  movement_pct_soft */ softMovement?.changePct ?? 0,
    /* 10 steam_move_sharp  */ detectSteamMove(eId, fId, aId, vb.sharpProvider) != null ? 1 : 0,
    /* 11 steam_move_soft   */ detectSteamMove(eId, fId, aId, vb.softProvider) != null ? 1 : 0,
    /* 12 sharp_direction   */ encodeDirection(sharpMovement?.direction),
    /* 13 soft_direction    */ encodeDirection(softMovement?.direction),
    /* 14 convergence_rate  */ computeConvergenceRate(eId, fId, aId, vb.sharpProvider, vb.softProvider),
    /* 15 tick_velocity     */ tickVelocity,
    /* 16 provider_count    */ getAllOddsForAtom(eId, fId, aId).size,
    /* 17 opening_sharp_odds */ sharpHistory?.openingOdds ?? 0,
    /* 18 market_type_encoded */ marketTypeEncoded,
    /* 19 is_asian_line     */ isAsianLine,
    /* 20 commission_pct    */ getProviderCommission(vb.softProvider),
    /* 21 kelly_fraction_raw */ vb.kellyFraction,
    /* 22 vig_pct           */ vigData?.vigPct ?? 0,
  ];

  // Round all values to 4 decimal places to prevent HOT-busting float drift
  return features.map((v) => Math.round((v ?? 0) * 10000) / 10000);
}
