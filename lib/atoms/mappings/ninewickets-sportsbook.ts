/**
 * NineWickets Sportsbook Provider Mapping
 *
 * Dynamic mapping that matches API markets to our atoms registry.
 * Uses market name patterns to auto-detect market type, time scope, and line.
 *
 * Key patterns:
 * - Match Result, 1x2 → MATCH_RESULT
 * - Over/Under, Total Goals → TOTAL_GOALS
 * - Asian Handicap, Handicap → ASIAN_HANDICAP
 * - Both Teams To Score, BTTS → BTTS
 * - Draw No Bet → DNB
 * - Team Total Goals → HOME_TEAM_TOTAL / AWAY_TEAM_TOTAL
 * - Corners Total → CORNERS
 * - Clean Sheet → CLEAN_SHEET
 * - Win To Nil → WIN_TO_NIL
 * - Odd/Even → ODD_EVEN_GOALS
 */

import { getFamilyIdByAtom, isValidAtom } from "../registry";
import { matchTeamSide } from "../../shared/team-matching";
import {
  formatLine,
  formatHandicapLine,
  extractLine,
  extractSignedLine,
} from "../../formatting/lines";
import type {
  NormalizedOddsEntry,
  ProviderKey,
  TimeScope,
  AtomMarketType,
} from "../types";

// Re-export line utilities for backward compatibility
export { formatLine, formatHandicapLine, extractLine, extractSignedLine };

// ============================================
// Sportsbook Types
// ============================================

export interface SportsbookSelection {
  selectionName: string;
  odds: number;
  handicap: number;
  isActive: boolean;
  apiSiteSelectionId: string;
}

export interface SportsbookMarket {
  id: string;
  marketName: string;
  apiSiteMarketType: number;
  geniusSportsSelection?: SportsbookSelection[];
}

// ============================================
// Market Type Detection
// ============================================

interface DetectedMarket {
  marketType: AtomMarketType;
  timeScope: TimeScope;
  line?: number;
  signedLine?: number; // for handicap markets where sign matters
  isHomeTeam?: boolean; // for team-specific markets
  marketName?: string; // raw market name for team detection in CS/WTN
}

/**
 * Detect time scope from market name
 */
function detectTimeScope(marketName: string): TimeScope {
  const lower = marketName.toLowerCase();
  if (
    lower.includes("half-time") ||
    lower.includes("half time") ||
    lower.includes("1st half") ||
    lower.includes("first half")
  ) {
    return "1H";
  }
  if (lower.includes("second half") || lower.includes("2nd half")) {
    return "2H";
  }
  return "FT";
}

/**
 * Detect market type from market name.
 * Uses apiSiteMarketType to override time scope for known HT market types.
 */
function detectMarketType(
  marketName: string,
  apiSiteMarketType?: number,
): DetectedMarket | null {
  const lower = marketName
    .toLowerCase()
    .replace(/over\/under/g, "over / under");
  const line = extractLine(marketName);

  // Use apiSiteMarketType to detect Half-Time markets (more reliable than name patterns)
  let timeScope = detectTimeScope(marketName);
  if (
    apiSiteMarketType === SPORTSBOOK_MARKET_TYPES.HALF_TIME_TOTALS ||
    apiSiteMarketType === SPORTSBOOK_MARKET_TYPES.HALF_TIME_RESULT
  ) {
    timeScope = "1H";
  }

  // Skip combo markets (and, &) - too complex to map
  if (lower.includes(" and ") || lower.includes(" & ")) {
    return null;
  }

  // Match Result (1x2) - use exact match to avoid collision with "Rest of Match Result"
  if (
    lower === "match result" ||
    lower === "1x2" ||
    lower === "half time result" ||
    lower === "second half match result"
  ) {
    return { marketType: "MATCH_RESULT", timeScope };
  }

  // Both Teams To Score - use exact match to avoid collision with "Both Teams To Score 2 or More Goals"
  if (
    lower === "both teams to score" ||
    lower === "half time both teams to score" ||
    lower === "second half both teams to score"
  ) {
    return { marketType: "BTTS", timeScope };
  }

  // Double Chance - use exact match
  if (
    lower === "double chance" ||
    lower === "half time double chance" ||
    lower === "second half double chance"
  ) {
    return { marketType: "DOUBLE_CHANCE", timeScope };
  }

  // Draw No Bet - use exact match
  if (
    lower === "draw no bet" ||
    lower === "half time draw no bet" ||
    lower === "second half draw no bet"
  ) {
    return { marketType: "DNB", timeScope };
  }

  // Asian Handicap - use startsWith for exact pattern matching
  // NW-SB shows positive lines in market names (+0.5, +1.5)
  // Both NW-SB and Pinnacle: home GIVES handicap, away RECEIVES
  // Negate line to convert NW-SB's "+X" to our "-X" convention
  if (
    (lower.startsWith("asian handicap ") ||
      lower.startsWith("half time asian handicap ") ||
      lower.startsWith("second half asian handicap ")) &&
    line !== null
  ) {
    const extractedLine = extractSignedLine(marketName);
    const signedLine = extractedLine !== null ? -extractedLine : undefined;
    return { marketType: "ASIAN_HANDICAP", timeScope, line, signedLine };
  }

  // European Handicap (3-way): "Handicap With Tie -1", "Second Half Handicap -1"
  // NW-SB shows positive lines in market names (+1, +2)
  // Both NW-SB and Pinnacle: home GIVES handicap, away RECEIVES
  // Negate line to convert NW-SB's "+X" to our "-X" convention
  if (
    (lower.startsWith("handicap with tie ") ||
      lower.startsWith("half time handicap with tie ") ||
      lower.startsWith("second half handicap ")) &&
    line !== null
  ) {
    const extractedLine = extractSignedLine(marketName);
    const signedLine = extractedLine !== null ? -extractedLine : undefined;
    return { marketType: "EUROPEAN_HANDICAP", timeScope, line, signedLine };
  }

  // Team Total Corners (Over/Under) - must check BEFORE general corners
  // Pattern: "{TeamName} Team Total Corners Over/Under +X.X"
  // apiSiteMarketType: 10747
  if (
    lower.includes("team total corners") &&
    lower.includes("over / under") &&
    line !== null
  ) {
    return { marketType: "HOME_CORNERS_TOTAL", timeScope, line, marketName };
  }

  // Corners Total (Over/Under)
  if (
    (lower.includes("corner") || lower.includes("corners")) &&
    (lower.includes("over / under") || lower.includes("total"))
  ) {
    if (line !== null) {
      return { marketType: "CORNERS", timeScope, line };
    }
  }

  // Corners Handicap (3-way European style with Home/Tie/Away)
  // NW-SB shows positive lines, negate to convert to our convention
  // Both NW-SB and Pinnacle: home GIVES handicap, away RECEIVES
  if (
    (lower.includes("corner") || lower.includes("corners")) &&
    lower.includes("handicap") &&
    line !== null
  ) {
    const extractedLine = extractSignedLine(marketName);
    const signedLine = extractedLine !== null ? -extractedLine : undefined;
    return {
      marketType: "CORNERS_EUROPEAN_HANDICAP",
      timeScope,
      line,
      signedLine,
    };
  }

  // Team Total Goals - pattern: "{TeamName} Goals Over / Under {line}"
  // Excludes "total goals" (that's the match-total market, handled below)
  // Examples: "Arsenal Goals Over / Under 1.5", "Half Time Chelsea Goals Over / Under 0.5"
  if (
    lower.includes("goals over / under") &&
    !lower.includes("total goals") &&
    line !== null
  ) {
    // Pass marketName so we can match team later
    return { marketType: "HOME_TEAM_TOTAL", timeScope, line, marketName };
  }

  // Total Goals (Over/Under) - use startsWith for exact pattern matching
  if (
    (lower.startsWith("total goals over / under ") ||
      lower.startsWith("half time total goals over / under ") ||
      lower.startsWith("second half total goals over / under ")) &&
    line !== null
  ) {
    return { marketType: "TOTAL_GOALS", timeScope, line };
  }

  // Cards Total
  if (
    (lower.includes("card") || lower.includes("cards")) &&
    (lower.includes("over / under") || lower.includes("total")) &&
    line !== null
  ) {
    return { marketType: "CARDS", timeScope, line };
  }

  // Odd/Even Goals - use exact match
  if (
    lower === "odd or even total" ||
    lower === "half time odd or even total"
  ) {
    return { marketType: "ODD_EVEN_GOALS", timeScope };
  }

  // Clean Sheet
  if (lower.includes("clean sheet")) {
    return { marketType: "CLEAN_SHEET", timeScope, marketName };
  }

  // Win To Nil
  if (lower.includes("win to nil")) {
    return { marketType: "WIN_TO_NIL", timeScope, marketName };
  }

  return null;
}

// ============================================
// Team Name Matching
// ============================================

// Team matching functions are imported from shared module
// Re-export parseTeams as alias for backward compatibility
export { parseTeamsFromEventName as parseTeams } from "../../shared/team-matching";

// ============================================
// Atom ID Generation
// ============================================

/**
 * Generate atom ID for a selection
 */
function generateAtomId(
  detected: DetectedMarket,
  selectionName: string,
  homeTeam: string,
  awayTeam: string,
): string | null {
  const timePrefix = detected.timeScope.toLowerCase();
  let selection = selectionName.toLowerCase().trim();
  const lineStr = detected.line !== undefined ? formatLine(detected.line) : "";

  // Normalize "handicap tie" to "draw" for 3-way handicap markets
  if (selection === "handicap tie" || selection === "tie") {
    selection = "draw";
  }

  switch (detected.marketType) {
    case "MATCH_RESULT": {
      if (selection === "draw") return `${timePrefix}_draw`;
      // Compare both teams and pick the better match to avoid false positives
      const side = matchTeamSide(selectionName, homeTeam, awayTeam);
      if (side === "home") return `${timePrefix}_home_win`;
      if (side === "away") return `${timePrefix}_away_win`;
      return null;
    }

    case "TOTAL_GOALS": {
      if (!lineStr) return null;
      if (selection === "over") return `${timePrefix}_total_over_${lineStr}`;
      if (selection === "under") return `${timePrefix}_total_under_${lineStr}`;
      return null;
    }

    case "ASIAN_HANDICAP": {
      // Asian handicap atoms include sign: ft_home_ah_m0_25, ft_away_ah_p0_25
      const signedLine = detected.signedLine ?? detected.line;
      if (signedLine === undefined) return null;

      // Compare both teams and pick the better match
      // NW-SB uses same convention as Pinnacle: home gives, away receives
      // Line negation converts "+X" to "-X", selections map directly (no swap needed)
      const ahSide = matchTeamSide(selectionName, homeTeam, awayTeam);

      if (ahSide === "home") {
        const ahLine = formatHandicapLine(signedLine);
        return `${timePrefix}_home_ah_${ahLine}`;
      }
      if (ahSide === "away") {
        const ahLine = formatHandicapLine(-signedLine);
        return `${timePrefix}_away_ah_${ahLine}`;
      }
      return null;
    }

    case "EUROPEAN_HANDICAP": {
      const signedLine = detected.signedLine ?? detected.line;
      if (signedLine === undefined) return null;
      const ehLine = formatHandicapLine(signedLine);

      if (selection === "draw") {
        return `${timePrefix}_draw_eh_${ehLine}`;
      }
      // Compare both teams and pick the better match
      // NW-SB uses same convention: home gives, away receives (no swap needed)
      const ehSide = matchTeamSide(selectionName, homeTeam, awayTeam);

      if (ehSide === "home") return `${timePrefix}_home_eh_${ehLine}`;
      if (ehSide === "away") return `${timePrefix}_away_eh_${ehLine}`;
      return null;
    }

    case "BTTS": {
      if (selection === "yes") return `${timePrefix}_btts_yes`;
      if (selection === "no") return `${timePrefix}_btts_no`;
      return null;
    }

    case "DNB": {
      // Compare both teams and pick the better match
      const dnbSide = matchTeamSide(selectionName, homeTeam, awayTeam);
      if (dnbSide === "home") return `${timePrefix}_dnb_home`;
      if (dnbSide === "away") return `${timePrefix}_dnb_away`;
      return null;
    }

    case "DOUBLE_CHANCE": {
      // Double Chance: 1X (home or draw), 12 (home or away), X2 (draw or away)
      // Selection names: "Home or Draw", "Home or Away", "Draw or Away"
      // Also: "1X", "12", "X2"
      if (selection === "1x" || selection === "home or draw")
        return `${timePrefix}_dc_1x`;
      if (selection === "12" || selection === "home or away")
        return `${timePrefix}_dc_12`;
      if (selection === "x2" || selection === "draw or away")
        return `${timePrefix}_dc_x2`;
      return null;
    }

    case "CORNERS": {
      if (!lineStr) return null;
      if (selection === "over") return `${timePrefix}_corners_over_${lineStr}`;
      if (selection === "under")
        return `${timePrefix}_corners_under_${lineStr}`;
      return null;
    }

    case "CORNERS_HANDICAP": {
      // Corners handicap atoms also include sign (2-way Asian style)
      const signedLine = detected.signedLine ?? detected.line;
      if (signedLine === undefined) return null;

      // Compare both teams and pick the better match
      // NW-SB uses same convention: home gives, away receives (no swap needed)
      const cornersSide = matchTeamSide(selectionName, homeTeam, awayTeam);

      if (cornersSide === "home") {
        const ahLine = formatHandicapLine(signedLine);
        return `${timePrefix}_corners_home_ah_${ahLine}`;
      }
      if (cornersSide === "away") {
        const ahLine = formatHandicapLine(-signedLine);
        return `${timePrefix}_corners_away_ah_${ahLine}`;
      }
      return null;
    }

    case "CORNERS_EUROPEAN_HANDICAP": {
      // Corners European Handicap (3-way: home/draw/away)
      const signedLine = detected.signedLine ?? detected.line;
      if (signedLine === undefined) return null;
      const ehLine = formatHandicapLine(signedLine);

      // Handle "Handicap Tie" (already normalized to "draw")
      if (selection === "draw") {
        return `${timePrefix}_corners_draw_eh_${ehLine}`;
      }
      // Compare both teams and pick the better match
      const cornersEhSide = matchTeamSide(selectionName, homeTeam, awayTeam);

      if (cornersEhSide === "home")
        return `${timePrefix}_corners_home_eh_${ehLine}`;
      if (cornersEhSide === "away")
        return `${timePrefix}_corners_away_eh_${ehLine}`;
      return null;
    }

    case "HOME_TEAM_TOTAL":
    case "AWAY_TEAM_TOTAL": {
      // Team Total Goals - detect team from market name
      // Pattern: "{TeamName} Goals Over / Under {line}"
      if (!lineStr) return null;
      const ttMarket = (detected.marketName ?? "").toLowerCase();

      // Match team name against home/away teams
      let ttTeam: "home" | "away" | null = null;
      if (ttMarket.includes("home")) {
        ttTeam = "home";
      } else if (ttMarket.includes("away")) {
        ttTeam = "away";
      } else {
        // Extract team name from market (everything before " goals over")
        ttTeam = matchTeamSide(detected.marketName ?? "", homeTeam, awayTeam);
      }
      if (!ttTeam) return null;

      if (selection === "over")
        return `${timePrefix}_${ttTeam}_over_${lineStr}`;
      if (selection === "under")
        return `${timePrefix}_${ttTeam}_under_${lineStr}`;
      return null;
    }

    case "ODD_EVEN_GOALS": {
      if (selection === "odd") return `${timePrefix}_goals_odd`;
      if (selection === "even") return `${timePrefix}_goals_even`;
      return null;
    }

    case "CLEAN_SHEET": {
      // Detect team from market name (e.g., "Home Team Clean Sheet", "Brighton Clean Sheet")
      const csMarket = (detected.marketName ?? "").toLowerCase();
      let csTeam: "home" | "away" | null = null;
      if (csMarket.includes("home")) {
        csTeam = "home";
      } else if (csMarket.includes("away")) {
        csTeam = "away";
      } else {
        // Compare both teams and pick the better match
        csTeam = matchTeamSide(detected.marketName ?? "", homeTeam, awayTeam);
      }
      if (!csTeam) return null;
      if (selection === "yes") return `${timePrefix}_${csTeam}_cs_yes`;
      if (selection === "no") return `${timePrefix}_${csTeam}_cs_no`;
      return null;
    }

    case "WIN_TO_NIL": {
      // Detect team from market name (e.g., "Home Win To Nil", "Brighton Win To Nil")
      const wtnMarket = (detected.marketName ?? "").toLowerCase();
      let wtnTeam: "home" | "away" | null = null;
      if (wtnMarket.includes("home")) {
        wtnTeam = "home";
      } else if (wtnMarket.includes("away")) {
        wtnTeam = "away";
      } else {
        // Compare both teams and pick the better match
        wtnTeam = matchTeamSide(detected.marketName ?? "", homeTeam, awayTeam);
      }
      if (!wtnTeam) return null;
      if (selection === "yes") return `${timePrefix}_${wtnTeam}_wtn_yes`;
      if (selection === "no") return `${timePrefix}_${wtnTeam}_wtn_no`;
      return null;
    }

    case "CARDS": {
      if (!lineStr) return null;
      if (selection === "over") return `${timePrefix}_cards_over_${lineStr}`;
      if (selection === "under") return `${timePrefix}_cards_under_${lineStr}`;
      return null;
    }

    case "HOME_CORNERS_TOTAL":
    case "AWAY_CORNERS_TOTAL": {
      if (!lineStr) return null;
      const tcMarket = (detected.marketName ?? "").toLowerCase();

      let tcTeam: "home" | "away" | null = null;
      if (tcMarket.includes("home")) {
        tcTeam = "home";
      } else if (tcMarket.includes("away")) {
        tcTeam = "away";
      } else {
        tcTeam = matchTeamSide(detected.marketName ?? "", homeTeam, awayTeam);
      }
      if (!tcTeam) return null;

      if (selection === "over")
        return `${timePrefix}_${tcTeam}_corners_over_${lineStr}`;
      if (selection === "under")
        return `${timePrefix}_${tcTeam}_corners_under_${lineStr}`;
      return null;
    }

    default:
      return null;
  }
}

// ============================================
// Main Mapping Function
// ============================================

/**
 * Map a NineWickets Sportsbook selection to an atom ID.
 * Uses dynamic detection based on market name patterns.
 */
export function mapSportsbookToAtom(
  apiSiteMarketType: number,
  selectionName: string,
  marketName: string,
  homeTeam: string,
  awayTeam: string,
): string | null {
  // Detect market type from name, using apiSiteMarketType to identify HT markets
  const detected = detectMarketType(marketName, apiSiteMarketType);
  if (!detected) return null;

  // Generate atom ID
  const atomId = generateAtomId(detected, selectionName, homeTeam, awayTeam);
  if (!atomId) return null;

  // Verify atom exists in registry
  if (!isValidAtom(atomId)) {
    // Try without timeScope variations for FT markets
    if (detected.timeScope === "FT" && atomId.startsWith("ft_")) {
      // Atom doesn't exist, skip
      return null;
    }
    return null;
  }

  return atomId;
}

// ============================================
// Extraction Function
// ============================================

/**
 * Extract normalized odds entries from a NineWickets Sportsbook market.
 */
export function extractSportsbookOdds(
  market: SportsbookMarket,
  eventId: string,
  homeTeam: string,
  awayTeam: string,
): NormalizedOddsEntry[] {
  const entries: NormalizedOddsEntry[] = [];

  if (
    !market.geniusSportsSelection ||
    market.geniusSportsSelection.length === 0
  ) {
    return entries;
  }

  const provider: ProviderKey = "ninewickets-sportsbook";
  const timestamp = Date.now();

  for (const selection of market.geniusSportsSelection) {
    // Skip inactive selections
    if (!selection.isActive) continue;

    // Skip invalid odds
    if (selection.odds <= 1) continue;

    // Try static mapping first
    const atomId = mapSportsbookToAtom(
      market.apiSiteMarketType,
      selection.selectionName,
      market.marketName,
      homeTeam,
      awayTeam,
    );

    if (!atomId) {
      continue;
    }

    const familyId = getFamilyIdByAtom(atomId);
    if (!familyId) {
      continue;
    }

    entries.push({
      provider,
      event_id: eventId,
      family_id: familyId,
      atom_id: atomId,
      odds: selection.odds,
      timestamp,
    });
  }

  return entries;
}

// ============================================
// Legacy Market Type Constants (for reference)
// ============================================

export const SPORTSBOOK_MARKET_TYPES = {
  MATCH_RESULT: 2,
  HALF_TIME_RESULT: 6832,
  ASIAN_HANDICAP: 82,
  OVER_UNDER: 259,
  HALF_TIME_TOTALS: 7076,
  BTTS: 7079,
} as const;

// ============================================
// Alias-Based Atom Derivation
// ============================================

export type SportsbookMarketType =
  (typeof SPORTSBOOK_MARKET_TYPES)[keyof typeof SPORTSBOOK_MARKET_TYPES];
