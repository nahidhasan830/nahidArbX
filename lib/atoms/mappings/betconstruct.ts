/**
 * BetConstruct Provider Mapping
 *
 * Static lookup tables for mapping BetConstruct markets to atom IDs.
 *
 * BetConstruct Market Data Structure:
 * - market.type: "P1XP2", "OverUnder", "BothTeamsToScore", "AsianHandicap", etc.
 * - market.display_key: "WINNER" for match result
 * - market.base: line value for OverUnder/Asian Handicap (e.g., 2.5, -0.5)
 * - event.type_1: selection type ("W1", "W2", "X", "Over", "Under", "Yes", "No")
 * - event.name: display name
 * - event.price: decimal odds
 *
 * Supported Market Types:
 * - P1XP2 (Match Result)
 * - HalfTimeResult (1H Match Result)
 * - SecondHalfResult (2H Match Result)
 * - OverUnder (FT Total Goals)
 * - HalfTimeOverUnder (1H Total Goals)
 * - 2ndHalfTotalOver/Under (2H Total Goals)
 * - BothTeamsToScore (FT BTTS)
 * - 1stHalfBothTeamsToScore (1H BTTS)
 * - AsianHandicap (FT Asian Handicap)
 * - HalfTimeAsianHandicap (1H Asian Handicap)
 * - 1X12X2 (Double Chance)
 * - DrawNoBet (Draw No Bet)
 * - Team1OverUnder (Home Team Total)
 * - Team2OverUnder (Away Team Total)
 * - CornersOverUnder (Corners Total)
 * - 1stHalfCornersOver/Under (1H Corners Total)
 * - CornerHandicap (Corners Asian Handicap)
 */

import { getFamilyIdByAtom } from "../registry";
import { formatLine } from "../../formatting/lines";
import type { NormalizedOddsEntry, ProviderKey } from "../types";
import type { BCMarket, BCEvent } from "../../adapters/betconstruct/client";

// ============================================
// Match Result Mapping (P1XP2 / WINNER)
// ============================================

const MATCH_RESULT_ATOMS: Record<string, string> = {
  W1: "ft_home_win",
  X: "ft_draw",
  W2: "ft_away_win",
};

// ============================================
// Half Time Result Mapping
// ============================================

const HALF_TIME_RESULT_ATOMS: Record<string, string> = {
  W1: "1h_home_win",
  X: "1h_draw",
  W2: "1h_away_win",
};

// ============================================
// Second Half Result Mapping
// ============================================

const SECOND_HALF_RESULT_ATOMS: Record<string, string> = {
  W1: "2h_home_win",
  X: "2h_draw",
  W2: "2h_away_win",
};

// ============================================
// Totals Mapping (OverUnder with base)
// ============================================

// Supported total lines for FT
const SUPPORTED_FT_TOTAL_LINES = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5];

// Supported total lines for 1H/2H
const SUPPORTED_HALF_TOTAL_LINES = [0.5, 1.5, 2.5];

function getTotalsAtom(
  base: number,
  direction: "over" | "under",
  scope: "ft" | "1h" | "2h" = "ft",
): string | null {
  const supportedLines =
    scope === "ft" ? SUPPORTED_FT_TOTAL_LINES : SUPPORTED_HALF_TOTAL_LINES;
  if (!supportedLines.includes(base)) return null;
  const line = formatLine(base);
  return `${scope}_total_${direction}_${line}`;
}

// ============================================
// Team Totals Mapping (Home/Away Over/Under)
// ============================================

// Supported team total lines
const SUPPORTED_TEAM_TOTAL_LINES = [0.5, 1.5, 2.5, 3.5];

function getTeamTotalsAtom(
  base: number,
  direction: "over" | "under",
  team: "home" | "away",
): string | null {
  if (!SUPPORTED_TEAM_TOTAL_LINES.includes(base)) return null;
  const line = formatLine(base);
  return `ft_${team}_${direction}_${line}`;
}

// ============================================
// BTTS Mapping (BothTeamsToScore)
// ============================================

const BTTS_ATOMS: Record<string, string> = {
  Yes: "ft_btts_yes",
  No: "ft_btts_no",
};

const BTTS_1H_ATOMS: Record<string, string> = {
  Yes: "1h_btts_yes",
  No: "1h_btts_no",
};

// ============================================
// Asian Handicap Mapping
// ============================================

// Supported Asian Handicap lines (FT)
const SUPPORTED_FT_AH_LINES = [
  -3, -2.5, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3,
];

// Supported Asian Handicap lines (1H)
const SUPPORTED_1H_AH_LINES = [-1.5, -1, -0.5, 0, 0.5, 1, 1.5];

function getAsianHandicapAtom(
  base: number,
  isHome: boolean,
  scope: "ft" | "1h" = "ft",
): string | null {
  const supportedLines =
    scope === "ft" ? SUPPORTED_FT_AH_LINES : SUPPORTED_1H_AH_LINES;
  if (!supportedLines.includes(base)) return null;

  const absLine = Math.abs(base);
  const line = formatLine(absLine);
  // Use 'm' for minus and 'p' for plus to match atoms.json format
  const sign = base >= 0 ? "p" : "m";
  const team = isHome ? "home" : "away";

  return `${scope}_${team}_ah_${sign}${line}`;
}

// ============================================
// Draw No Bet Mapping
// ============================================

const DNB_ATOMS: Record<string, string> = {
  W1: "ft_dnb_home",
  Home: "ft_dnb_home",
  W2: "ft_dnb_away",
  Away: "ft_dnb_away",
};

// ============================================
// Double Chance Mapping (1X12X2)
// ============================================

const DOUBLE_CHANCE_ATOMS: Record<string, string> = {
  "1X": "ft_dc_1x",
  "12": "ft_dc_12",
  X2: "ft_dc_x2",
};

// ============================================
// Corners Over/Under Mapping
// ============================================

// Supported corners total lines (FT)
const SUPPORTED_FT_CORNERS_LINES = [
  5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13,
  13.5,
];

// Supported corners total lines (1H)
const SUPPORTED_1H_CORNERS_LINES = [3.5, 4.5, 5.5];

function getCornersAtom(
  base: number,
  direction: "over" | "under",
  scope: "ft" | "1h" = "ft",
): string | null {
  const supportedLines =
    scope === "ft" ? SUPPORTED_FT_CORNERS_LINES : SUPPORTED_1H_CORNERS_LINES;
  if (!supportedLines.includes(base)) return null;
  const line = formatLine(base);
  return `${scope}_corners_${direction}_${line}`;
}

// ============================================
// Corners Asian Handicap Mapping
// ============================================

// Supported corners handicap lines
const SUPPORTED_CORNERS_AH_LINES = [
  -6.5, -6, -5.5, -5, -4.5, -4, -3.5, -3, -2.5, -2, -1.5, -1, -0.5, 0, 0.5, 1,
  1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5,
];

function getCornersHandicapAtom(base: number, isHome: boolean): string | null {
  if (!SUPPORTED_CORNERS_AH_LINES.includes(base)) return null;

  const absLine = Math.abs(base);
  const line = formatLine(absLine);
  const sign = base >= 0 ? "p" : "m";
  const team = isHome ? "home" : "away";

  // Use event.base directly - it already has the correct sign per team
  return `ft_corners_${team}_ah_${sign}${line}`;
}

// ============================================
// Main Mapping Function
// ============================================

/**
 * Map a BetConstruct selection to an atom ID.
 *
 * @param marketType - BetConstruct market type (e.g., "P1XP2", "OverUnder")
 * @param selectionType - Selection type_1 (e.g., "W1", "Over", "Yes")
 * @param selectionName - Selection display name
 * @param base - Line value for handicap/total markets
 * @param displayKey - Market display_key (e.g., "WINNER")
 * @returns atom_id or null if unmapped
 */
export function mapBetConstructToAtom(
  marketType: string,
  selectionType: string,
  selectionName: string,
  base?: number,
  displayKey?: string,
): string | null {
  switch (marketType) {
    // =============================================
    // MATCH RESULT MARKETS
    // =============================================

    // Match Result (Full Time 1X2)
    case "P1XP2": {
      // Only map WINNER display_key (not corner winner, etc.)
      if (displayKey && displayKey !== "WINNER") return null;
      return MATCH_RESULT_ATOMS[selectionType] || null;
    }

    // Half Time Result
    case "HalfTimeResult": {
      return HALF_TIME_RESULT_ATOMS[selectionType] || null;
    }

    // Second Half Result
    case "SecondHalfResult": {
      return SECOND_HALF_RESULT_ATOMS[selectionType] || null;
    }

    // =============================================
    // TOTAL GOALS MARKETS
    // =============================================

    // Over/Under Totals (Full Time)
    case "OverUnder": {
      if (base === undefined) return null;
      const direction = getOverUnderDirection(selectionType, selectionName);
      if (!direction) return null;
      return getTotalsAtom(base, direction, "ft");
    }

    // Half Time Over/Under
    case "HalfTimeOverUnder": {
      if (base === undefined) return null;
      const direction = getOverUnderDirection(selectionType, selectionName);
      if (!direction) return null;
      return getTotalsAtom(base, direction, "1h");
    }

    // Second Half Over/Under
    case "2ndHalfTotalOver/Under": {
      if (base === undefined) return null;
      const direction = getOverUnderDirection(selectionType, selectionName);
      if (!direction) return null;
      return getTotalsAtom(base, direction, "2h");
    }

    // =============================================
    // TEAM TOTALS MARKETS
    // =============================================

    // Home Team Total
    case "Team1OverUnder": {
      if (base === undefined) return null;
      const direction = getOverUnderDirection(selectionType, selectionName);
      if (!direction) return null;
      return getTeamTotalsAtom(base, direction, "home");
    }

    // Away Team Total
    case "Team2OverUnder": {
      if (base === undefined) return null;
      const direction = getOverUnderDirection(selectionType, selectionName);
      if (!direction) return null;
      return getTeamTotalsAtom(base, direction, "away");
    }

    // =============================================
    // BTTS MARKETS
    // =============================================

    // Both Teams To Score (Full Time)
    case "BothTeamsToScore": {
      return BTTS_ATOMS[selectionName] || BTTS_ATOMS[selectionType] || null;
    }

    // Both Teams To Score (1st Half)
    case "1stHalfBothTeamsToScore": {
      return (
        BTTS_1H_ATOMS[selectionName] || BTTS_1H_ATOMS[selectionType] || null
      );
    }

    // =============================================
    // ASIAN HANDICAP MARKETS
    // =============================================

    // Asian Handicap (Full Time)
    case "AsianHandicap": {
      if (base === undefined) return null;
      const isHome = isHomeSelection(selectionType, selectionName);
      const isAway = isAwaySelection(selectionType, selectionName);

      if (isHome) return getAsianHandicapAtom(base, true, "ft");
      if (isAway) return getAsianHandicapAtom(base, false, "ft"); // Use event.base directly
      return null;
    }

    // Asian Handicap (1st Half)
    case "HalfTimeAsianHandicap": {
      if (base === undefined) return null;
      const isHome = isHomeSelection(selectionType, selectionName);
      const isAway = isAwaySelection(selectionType, selectionName);

      if (isHome) return getAsianHandicapAtom(base, true, "1h");
      if (isAway) return getAsianHandicapAtom(base, false, "1h"); // Use event.base directly
      return null;
    }

    // =============================================
    // OTHER MATCH MARKETS
    // =============================================

    // Draw No Bet
    case "DrawNoBet": {
      return DNB_ATOMS[selectionType] || DNB_ATOMS[selectionName] || null;
    }

    // Double Chance
    case "1X12X2": {
      return (
        DOUBLE_CHANCE_ATOMS[selectionType] ||
        DOUBLE_CHANCE_ATOMS[selectionName] ||
        null
      );
    }

    // =============================================
    // CORNERS MARKETS
    // =============================================

    // Corners Over/Under (Full Time)
    case "CornersOverUnder": {
      if (base === undefined) return null;
      const direction = getOverUnderDirection(selectionType, selectionName);
      if (!direction) return null;
      return getCornersAtom(base, direction, "ft");
    }

    // Corners Over/Under (1st Half)
    case "1stHalfCornersOver/Under": {
      if (base === undefined) return null;
      const direction = getOverUnderDirection(selectionType, selectionName);
      if (!direction) return null;
      return getCornersAtom(base, direction, "1h");
    }

    // Corner Handicap (Asian)
    case "CornerHandicap": {
      if (base === undefined) return null;
      const isHome = isHomeSelection(selectionType, selectionName);
      const isAway = isAwaySelection(selectionType, selectionName);

      if (isHome) return getCornersHandicapAtom(base, true);
      if (isAway) return getCornersHandicapAtom(base, false); // Use event.base directly
      return null;
    }

    default:
      return null;
  }
}

// ============================================
// Selection Detection Helpers
// ============================================

function getOverUnderDirection(
  selectionType: string,
  selectionName: string,
): "over" | "under" | null {
  const isOver =
    selectionType === "Over" || selectionName.toLowerCase().includes("over");
  const isUnder =
    selectionType === "Under" || selectionName.toLowerCase().includes("under");

  if (isOver) return "over";
  if (isUnder) return "under";
  return null;
}

function isHomeSelection(
  selectionType: string,
  selectionName: string,
): boolean {
  return (
    selectionType === "W1" ||
    selectionType === "Home" ||
    selectionName.toLowerCase().includes("home") ||
    selectionType === "1"
  );
}

function isAwaySelection(
  selectionType: string,
  selectionName: string,
): boolean {
  return (
    selectionType === "W2" ||
    selectionType === "Away" ||
    selectionName.toLowerCase().includes("away") ||
    selectionType === "2"
  );
}

// ============================================
// Extraction Function
// ============================================

/**
 * Extract normalized odds entries from a BetConstruct market.
 *
 * @param market - BetConstruct market object
 * @param eventId - Normalized event ID (e.g., "betconstruct-12345")
 * @returns Array of normalized odds entries
 */
export function extractBetConstructOdds(
  market: BCMarket,
  eventId: string,
): NormalizedOddsEntry[] {
  const entries: NormalizedOddsEntry[] = [];

  if (!market.event || Object.keys(market.event).length === 0) {
    return entries;
  }

  const provider: ProviderKey = "betconstruct";
  const timestamp = Date.now();

  for (const selection of Object.values(market.event)) {
    const event = selection as BCEvent;

    // Skip invalid odds
    if (!event.price || event.price <= 1) continue;

    const atomId = mapBetConstructToAtom(
      market.type,
      event.type_1,
      event.name,
      event.base ?? market.base, // Prefer event.base for handicap markets
      market.display_key,
    );

    if (!atomId) {
      continue;
    }

    const familyId = getFamilyIdByAtom(atomId);
    if (!familyId) continue;

    entries.push({
      provider,
      event_id: eventId,
      family_id: familyId,
      atom_id: atomId,
      odds: event.price,
      timestamp,
    });
  }

  return entries;
}

// ============================================
// Market Type Classification
// ============================================

/**
 * List of all supported BetConstruct market types
 */
const SUPPORTED_MARKET_TYPES = [
  // Match Result
  "P1XP2",
  "HalfTimeResult",
  "SecondHalfResult",
  // Total Goals
  "OverUnder",
  "HalfTimeOverUnder",
  "2ndHalfTotalOver/Under",
  // Team Totals
  "Team1OverUnder",
  "Team2OverUnder",
  // BTTS
  "BothTeamsToScore",
  "1stHalfBothTeamsToScore",
  // Asian Handicap
  "AsianHandicap",
  "HalfTimeAsianHandicap",
  // Other
  "DrawNoBet",
  "1X12X2",
  // Corners
  "CornersOverUnder",
  "1stHalfCornersOver/Under",
  "CornerHandicap",
];

/**
 * Check if a market type is supported for atom mapping
 */
export function isSupportedMarketType(marketType: string): boolean {
  return SUPPORTED_MARKET_TYPES.includes(marketType);
}

/**
 * Get the family ID for a BetConstruct market type
 */
export function getMarketFamily(
  marketType: string,
  base?: number,
): string | null {
  switch (marketType) {
    // Match Result
    case "P1XP2":
      return "ft_match_result";
    case "HalfTimeResult":
      return "1h_match_result";
    case "SecondHalfResult":
      return "2h_match_result";

    // Total Goals
    case "OverUnder":
      if (base === undefined) return null;
      return `ft_total_${formatLine(base)}`;
    case "HalfTimeOverUnder":
      if (base === undefined) return null;
      return `1h_total_${formatLine(base)}`;
    case "2ndHalfTotalOver/Under":
      if (base === undefined) return null;
      return `2h_total_${formatLine(base)}`;

    // Team Totals
    case "Team1OverUnder":
      if (base === undefined) return null;
      return `ft_home_total_${formatLine(base)}`;
    case "Team2OverUnder":
      if (base === undefined) return null;
      return `ft_away_total_${formatLine(base)}`;

    // BTTS
    case "BothTeamsToScore":
      return "ft_btts";
    case "1stHalfBothTeamsToScore":
      return "1h_btts";

    // Asian Handicap
    case "AsianHandicap":
      if (base === undefined) return null;
      return `ft_ah_${base >= 0 ? "p" : "m"}${formatLine(Math.abs(base))}`;
    case "HalfTimeAsianHandicap":
      if (base === undefined) return null;
      return `1h_ah_${base >= 0 ? "p" : "m"}${formatLine(Math.abs(base))}`;

    // Other
    case "DrawNoBet":
      return "ft_dnb";
    case "1X12X2":
      return "ft_double_chance";

    // Corners
    case "CornersOverUnder":
      if (base === undefined) return null;
      return `ft_corners_${formatLine(base)}`;
    case "1stHalfCornersOver/Under":
      if (base === undefined) return null;
      return `1h_corners_${formatLine(base)}`;
    case "CornerHandicap":
      if (base === undefined) return null;
      return `ft_corners_ah_${base >= 0 ? "p" : "m"}${formatLine(Math.abs(base))}`;

    default:
      return null;
  }
}
