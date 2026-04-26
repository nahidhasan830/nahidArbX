/**
 * NineWickets Exchange Provider Mapping
 *
 * Static lookup tables for mapping NineWickets Exchange markets to atom IDs.
 * Exchange markets are always Full Time.
 *
 * NineWickets Exchange Data Structure:
 * - marketType: "MATCH_ODDS" | "OVER_UNDER_05" | "OVER_UNDER_15" | "OVER_UNDER_25"
 * - selections[].runnerName: Team name for 1X2, "Over/Under X.X" for totals
 * - selections[].availableToBack[0].price: best back odds
 *
 * IMPORTANT: sortPriority is NOT reliable for home/away identification.
 * We use runnerName matching against known team names instead.
 */

import { getFamilyIdByAtom } from "../registry";
import type { NormalizedOddsEntry, ProviderKey } from "../types";
import { bestSim as compareTwoStrings } from "@/lib/matching/string-sim";

// ============================================
// Constants
// ============================================

const DRAW_KEYWORDS = ["draw", "the draw", "x"];
const SIMILARITY_THRESHOLD = 0.5; // Minimum similarity to consider a match

// ============================================
// Totals Mapping (marketType based)
// ============================================

const TOTALS_ATOMS: Record<string, { over: string; under: string }> = {
  OVER_UNDER_05: { over: "ft_total_over_0_5", under: "ft_total_under_0_5" },
  OVER_UNDER_15: { over: "ft_total_over_1_5", under: "ft_total_under_1_5" },
  OVER_UNDER_25: { over: "ft_total_over_2_5", under: "ft_total_under_2_5" },
};

// ============================================
// Helper Functions
// ============================================

/**
 * Extract over/under direction from runner name
 */
function getDirection(runnerName: string): "over" | "under" | null {
  const lower = runnerName.toLowerCase();
  if (lower.includes("over")) return "over";
  if (lower.includes("under")) return "under";
  return null;
}

/**
 * Check if runner name represents a draw
 */
function isDraw(runnerName: string): boolean {
  const lower = runnerName.toLowerCase().trim();
  return DRAW_KEYWORDS.some((kw) => lower === kw || lower.includes(kw));
}

/**
 * Normalize team name for comparison
 */
function normalize(name: string): string {
  return name.toLowerCase().trim();
}

/**
 * Identify if runnerName matches home team, away team, or draw
 */
function identifyOutcome(
  runnerName: string,
  homeTeam: string,
  awayTeam: string,
): "home" | "away" | "draw" | null {
  // Check for draw first
  if (isDraw(runnerName)) {
    return "draw";
  }

  const runner = normalize(runnerName);
  const home = normalize(homeTeam);
  const away = normalize(awayTeam);

  // Calculate similarity scores
  const homeScore = compareTwoStrings(runner, home);
  const awayScore = compareTwoStrings(runner, away);

  // Pick the best match if above threshold
  if (homeScore >= SIMILARITY_THRESHOLD && homeScore > awayScore) {
    return "home";
  }
  if (awayScore >= SIMILARITY_THRESHOLD && awayScore > homeScore) {
    return "away";
  }

  // Fallback: check if runner contains team name or vice versa
  if (runner.includes(home) || home.includes(runner)) {
    return "home";
  }
  if (runner.includes(away) || away.includes(runner)) {
    return "away";
  }

  return null;
}

// ============================================
// Main Mapping Function
// ============================================

/**
 * Map a NineWickets Exchange selection to an atom ID.
 * Uses team name matching for MATCH_ODDS instead of sortPriority.
 *
 * @param marketType - Exchange market type
 * @param runnerName - Runner name (team name for 1X2, "Over/Under" for totals)
 * @param homeTeam - Known home team name
 * @param awayTeam - Known away team name
 * @returns atom_id or null if unmapped
 */
export function mapExchangeToAtom(
  marketType: string,
  runnerName: string,
  homeTeam: string,
  awayTeam: string,
): string | null {
  switch (marketType) {
    case "MATCH_ODDS": {
      const outcome = identifyOutcome(runnerName, homeTeam, awayTeam);
      if (!outcome) return null;

      switch (outcome) {
        case "home":
          return "ft_home_win";
        case "away":
          return "ft_away_win";
        case "draw":
          return "ft_draw";
      }
      return null;
    }

    case "OVER_UNDER_05":
    case "OVER_UNDER_15":
    case "OVER_UNDER_25": {
      const mapping = TOTALS_ATOMS[marketType];
      if (!mapping) return null;

      const direction = getDirection(runnerName);
      if (!direction) return null;

      return direction === "over" ? mapping.over : mapping.under;
    }

    default:
      return null;
  }
}

// ============================================
// Exchange Types
// ============================================

export interface ExchangeSelection {
  selectionId: number;
  runnerName: string;
  sortPriority: number;
  status: number;
  availableToBack?: Array<{ price: number; size: number }>;
  availableToLay?: Array<{ price: number; size: number }>;
}

export interface ExchangeMarket {
  eventId: number;
  marketId: string;
  marketType: string;
  marketName: string;
  status: number;
  selections?: ExchangeSelection[];
}

// ============================================
// Extraction Function
// ============================================

/**
 * Extract normalized odds entries from a NineWickets Exchange market.
 *
 * @param market - Exchange market object
 * @param eventId - Normalized event ID (e.g., "ninewickets-12345")
 * @param homeTeam - Home team name for matching
 * @param awayTeam - Away team name for matching
 * @returns Array of normalized odds entries
 */
export function extractExchangeOdds(
  market: ExchangeMarket,
  eventId: string,
  homeTeam: string,
  awayTeam: string,
): NormalizedOddsEntry[] {
  const entries: NormalizedOddsEntry[] = [];

  if (!market.selections || market.selections.length === 0) {
    return entries;
  }

  const provider: ProviderKey = "ninewickets-exchange";
  const timestamp = Date.now();

  for (const selection of market.selections) {
    const backPrices = selection.availableToBack;
    if (!backPrices || backPrices.length === 0) continue;

    const odds = backPrices[0].price;
    if (odds <= 1) continue;

    const atomId = mapExchangeToAtom(
      market.marketType,
      selection.runnerName,
      homeTeam,
      awayTeam,
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
      odds,
      timestamp,
    });
  }

  return entries;
}
