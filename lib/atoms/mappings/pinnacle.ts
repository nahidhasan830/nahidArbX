/**
 * Pinnacle Provider Mapping
 *
 * Static lookup tables for mapping Pinnacle markets to atom IDs.
 * No runtime normalization - pure deterministic mapping.
 *
 * Pinnacle Data Structure:
 * - marketType: "MONEYLINE" | "TOTAL_POINTS" | "SPREAD" | "TEAM_TOTAL_POINTS"
 * - periodType: "Regular" | "FT" | "HT" | "1H" | "2H" | "Corners"
 * - handicap: line value (e.g., 2.5 for totals, -0.5 for spread)
 * - side: "HOME" | "AWAY" | "DRAW" (outcome side)
 * - direction: "OVER" | "UNDER" (for totals)
 */

import { getFamilyIdByAtom } from "../registry";
import { bufferUnmappedMarket } from "../unmapped-buffer";
import type { NormalizedOddsEntry, ProviderKey } from "../types";

// ============================================
// Period Normalization
// ============================================

type NormalizedPeriod = "ft" | "1h" | "corners" | "bookings" | null;

function normalizePeriod(periodType: string): NormalizedPeriod {
  switch (periodType) {
    case "Regular":
    case "FT":
      return "ft";
    case "HT":
    case "1H":
      return "1h";
    case "Corners":
      return "corners";
    case "Bookings":
      return "bookings";
    // Skip 2H (not in atoms.json)
    default:
      return null;
  }
}

// ============================================
// Match Result Mapping
// ============================================

const MATCH_RESULT_ATOMS: Record<string, Record<string, string>> = {
  ft: {
    home: "ft_home_win",
    away: "ft_away_win",
    draw: "ft_draw",
  },
  "1h": {
    home: "1h_home_win",
    away: "1h_away_win",
    draw: "1h_draw",
  },
};

// ============================================
// Totals Mapping (Goals)
// ============================================

// Key format: "ft|0.5" or "1h|1.5"
const TOTALS_ATOMS: Record<string, { over: string; under: string }> = {
  // Full Time - Half-goal lines
  "ft|0.5": { over: "ft_total_over_0_5", under: "ft_total_under_0_5" },
  "ft|1.5": { over: "ft_total_over_1_5", under: "ft_total_under_1_5" },
  "ft|2.5": { over: "ft_total_over_2_5", under: "ft_total_under_2_5" },
  "ft|3.5": { over: "ft_total_over_3_5", under: "ft_total_under_3_5" },
  "ft|6.25": { over: "ft_total_over_6_25", under: "ft_total_under_6_25" },
  "ft|6.5": { over: "ft_total_over_6_5", under: "ft_total_under_6_5" },
  "ft|6.75": { over: "ft_total_over_6_75", under: "ft_total_under_6_75" },
  "ft|7": { over: "ft_total_over_7", under: "ft_total_under_7" },
  "ft|7.25": { over: "ft_total_over_7_25", under: "ft_total_under_7_25" },
  "ft|7.5": { over: "ft_total_over_7_5", under: "ft_total_under_7_5" },
  "ft|7.75": { over: "ft_total_over_7_75", under: "ft_total_under_7_75" },
  "ft|8": { over: "ft_total_over_8", under: "ft_total_under_8" },
  "ft|8.25": { over: "ft_total_over_8_25", under: "ft_total_under_8_25" },
  "ft|8.5": { over: "ft_total_over_8_5", under: "ft_total_under_8_5" },
  // Full Time - Quarter-goal lines (split settlement)
  "ft|0.75": { over: "ft_total_over_0_75", under: "ft_total_under_0_75" },
  "ft|1.25": { over: "ft_total_over_1_25", under: "ft_total_under_1_25" },
  "ft|1.75": { over: "ft_total_over_1_75", under: "ft_total_under_1_75" },
  "ft|2.25": { over: "ft_total_over_2_25", under: "ft_total_under_2_25" },
  "ft|2.75": { over: "ft_total_over_2_75", under: "ft_total_under_2_75" },
  "ft|3.25": { over: "ft_total_over_3_25", under: "ft_total_under_3_25" },
  "ft|3.75": { over: "ft_total_over_3_75", under: "ft_total_under_3_75" },
  "ft|4.25": { over: "ft_total_over_4_25", under: "ft_total_under_4_25" },
  "ft|4.75": { over: "ft_total_over_4_75", under: "ft_total_under_4_75" },
  "ft|5.25": { over: "ft_total_over_5_25", under: "ft_total_under_5_25" },
  "ft|5.75": { over: "ft_total_over_5_75", under: "ft_total_under_5_75" },
  // Full Time - Whole number lines
  "ft|1": { over: "ft_total_over_1", under: "ft_total_under_1" },
  "ft|2": { over: "ft_total_over_2", under: "ft_total_under_2" },
  "ft|3": { over: "ft_total_over_3", under: "ft_total_under_3" },
  "ft|4": { over: "ft_total_over_4", under: "ft_total_under_4" },
  "ft|5": { over: "ft_total_over_5", under: "ft_total_under_5" },
  "ft|6": { over: "ft_total_over_6", under: "ft_total_under_6" },
  // First Half
  "1h|0.5": { over: "1h_total_over_0_5", under: "1h_total_under_0_5" },
  "1h|2.25": { over: "1h_total_over_2_25", under: "1h_total_under_2_25" },
  "1h|2.5": { over: "1h_total_over_2_5", under: "1h_total_under_2_5" },
  "1h|2.75": { over: "1h_total_over_2_75", under: "1h_total_under_2_75" },
  "1h|3": { over: "1h_total_over_3", under: "1h_total_under_3" },
  "1h|3.25": { over: "1h_total_over_3_25", under: "1h_total_under_3_25" },
  "1h|3.5": { over: "1h_total_over_3_5", under: "1h_total_under_3_5" },
};

// ============================================
// Asian Handicap Mapping
// ============================================

// Key format: "ft|-0.5" or "1h|0"
// Value: { home: atom for home team, away: atom for away team }
const AH_ATOMS: Record<string, { home: string; away: string }> = {
  // Full Time - Negative lines (home giving)
  "ft|-3": { home: "ft_home_ah_m3", away: "ft_away_ah_p3" },
  "ft|-2.75": { home: "ft_home_ah_m2_75", away: "ft_away_ah_p2_75" },
  "ft|-2.5": { home: "ft_home_ah_m2_5", away: "ft_away_ah_p2_5" },
  "ft|-2.25": { home: "ft_home_ah_m2_25", away: "ft_away_ah_p2_25" },
  "ft|-2": { home: "ft_home_ah_m2", away: "ft_away_ah_p2" },
  "ft|-1.75": { home: "ft_home_ah_m1_75", away: "ft_away_ah_p1_75" },
  "ft|-1.5": { home: "ft_home_ah_m1_5", away: "ft_away_ah_p1_5" },
  "ft|-1.25": { home: "ft_home_ah_m1_25", away: "ft_away_ah_p1_25" },
  "ft|-1": { home: "ft_home_ah_m1", away: "ft_away_ah_p1" },
  "ft|-0.75": { home: "ft_home_ah_m0_75", away: "ft_away_ah_p0_75" },
  "ft|-0.5": { home: "ft_home_ah_m0_5", away: "ft_away_ah_p0_5" },
  "ft|-3.25": { home: "ft_home_ah_m3_25", away: "ft_away_ah_p3_25" },
  "ft|-3.5": { home: "ft_home_ah_m3_5", away: "ft_away_ah_p3_5" },
  "ft|-3.75": { home: "ft_home_ah_m3_75", away: "ft_away_ah_p3_75" },
  "ft|-4": { home: "ft_home_ah_m4", away: "ft_away_ah_p4" },
  "ft|-4.25": { home: "ft_home_ah_m4_25", away: "ft_away_ah_p4_25" },
  "ft|-4.5": { home: "ft_home_ah_m4_5", away: "ft_away_ah_p4_5" },
  "ft|-0.25": { home: "ft_home_ah_m0_25", away: "ft_away_ah_p0_25" },
  "ft|0": { home: "ft_home_ah_0", away: "ft_away_ah_0" },
  // Full Time - Positive lines (home receiving)
  "ft|0.25": { home: "ft_home_ah_p0_25", away: "ft_away_ah_m0_25" },
  "ft|0.5": { home: "ft_home_ah_p0_5", away: "ft_away_ah_m0_5" },
  "ft|0.75": { home: "ft_home_ah_p0_75", away: "ft_away_ah_m0_75" },
  "ft|1": { home: "ft_home_ah_p1", away: "ft_away_ah_m1" },
  "ft|1.25": { home: "ft_home_ah_p1_25", away: "ft_away_ah_m1_25" },
  "ft|1.5": { home: "ft_home_ah_p1_5", away: "ft_away_ah_m1_5" },
  "ft|1.75": { home: "ft_home_ah_p1_75", away: "ft_away_ah_m1_75" },
  "ft|2": { home: "ft_home_ah_p2", away: "ft_away_ah_m2" },
  "ft|2.25": { home: "ft_home_ah_p2_25", away: "ft_away_ah_m2_25" },
  "ft|2.5": { home: "ft_home_ah_p2_5", away: "ft_away_ah_m2_5" },
  "ft|2.75": { home: "ft_home_ah_p2_75", away: "ft_away_ah_m2_75" },
  "ft|3": { home: "ft_home_ah_p3", away: "ft_away_ah_m3" },
  "ft|3.25": { home: "ft_home_ah_p3_25", away: "ft_away_ah_m3_25" },
  "ft|3.5": { home: "ft_home_ah_p3_5", away: "ft_away_ah_m3_5" },
  "ft|3.75": { home: "ft_home_ah_p3_75", away: "ft_away_ah_m3_75" },
  "ft|4": { home: "ft_home_ah_p4", away: "ft_away_ah_m4" },
  "ft|4.25": { home: "ft_home_ah_p4_25", away: "ft_away_ah_m4_25" },
  "ft|4.5": { home: "ft_home_ah_p4_5", away: "ft_away_ah_m4_5" },
  // First Half
  "1h|-1.5": { home: "1h_home_ah_m1_5", away: "1h_away_ah_p1_5" },
  "1h|-1.25": { home: "1h_home_ah_m1_25", away: "1h_away_ah_p1_25" },
  "1h|-1": { home: "1h_home_ah_m1", away: "1h_away_ah_p1" },
  "1h|-0.75": { home: "1h_home_ah_m0_75", away: "1h_away_ah_p0_75" },
  "1h|-0.5": { home: "1h_home_ah_m0_5", away: "1h_away_ah_p0_5" },
  "1h|-0.25": { home: "1h_home_ah_m0_25", away: "1h_away_ah_p0_25" },
  "1h|0": { home: "1h_home_ah_0", away: "1h_away_ah_0" },
  "1h|0.25": { home: "1h_home_ah_p0_25", away: "1h_away_ah_m0_25" },
  "1h|0.5": { home: "1h_home_ah_p0_5", away: "1h_away_ah_m0_5" },
  "1h|0.75": { home: "1h_home_ah_p0_75", away: "1h_away_ah_m0_75" },
  "1h|1": { home: "1h_home_ah_p1", away: "1h_away_ah_m1" },
  "1h|1.25": { home: "1h_home_ah_p1_25", away: "1h_away_ah_m1_25" },
  "1h|1.5": { home: "1h_home_ah_p1_5", away: "1h_away_ah_m1_5" },
};

// ============================================
// Team Totals Mapping
// ============================================

// Key format: "ft|home|0.5" or "ft|away|1.5"
const TEAM_TOTALS_ATOMS: Record<string, { over: string; under: string }> = {
  // Home Team - Full Time
  "ft|home|0.5": { over: "ft_home_over_0_5", under: "ft_home_under_0_5" },
  "ft|home|1.5": { over: "ft_home_over_1_5", under: "ft_home_under_1_5" },
  "ft|home|2.5": { over: "ft_home_over_2_5", under: "ft_home_under_2_5" },
  "ft|home|3.5": { over: "ft_home_over_3_5", under: "ft_home_under_3_5" },
  "ft|home|4.5": { over: "ft_home_over_4_5", under: "ft_home_under_4_5" },
  "ft|home|5.5": { over: "ft_home_over_5_5", under: "ft_home_under_5_5" },
  // Away Team - Full Time
  "ft|away|0.5": { over: "ft_away_over_0_5", under: "ft_away_under_0_5" },
  "ft|away|1.5": { over: "ft_away_over_1_5", under: "ft_away_under_1_5" },
  "ft|away|2.5": { over: "ft_away_over_2_5", under: "ft_away_under_2_5" },
  "ft|away|3.5": { over: "ft_away_over_3_5", under: "ft_away_under_3_5" },
  "ft|away|4.5": { over: "ft_away_over_4_5", under: "ft_away_under_4_5" },
  "ft|away|5.5": { over: "ft_away_over_5_5", under: "ft_away_under_5_5" },
  // Home Team - First Half
  "1h|home|0.5": { over: "1h_home_over_0_5", under: "1h_home_under_0_5" },
  "1h|home|1.5": { over: "1h_home_over_1_5", under: "1h_home_under_1_5" },
  "1h|home|2.5": { over: "1h_home_over_2_5", under: "1h_home_under_2_5" },
  // Away Team - First Half
  "1h|away|0.5": { over: "1h_away_over_0_5", under: "1h_away_under_0_5" },
  "1h|away|1.5": { over: "1h_away_over_1_5", under: "1h_away_under_1_5" },
  "1h|away|2.5": { over: "1h_away_over_2_5", under: "1h_away_under_2_5" },
};

// ============================================
// Corners Totals Mapping
// ============================================

const CORNERS_TOTALS_ATOMS: Record<string, { over: string; under: string }> = {
  // Full Time
  "ft|5": { over: "ft_corners_over_5", under: "ft_corners_under_5" },
  "ft|5.5": { over: "ft_corners_over_5_5", under: "ft_corners_under_5_5" },
  "ft|6": { over: "ft_corners_over_6", under: "ft_corners_under_6" },
  "ft|6.5": { over: "ft_corners_over_6_5", under: "ft_corners_under_6_5" },
  "ft|7": { over: "ft_corners_over_7", under: "ft_corners_under_7" },
  "ft|7.5": { over: "ft_corners_over_7_5", under: "ft_corners_under_7_5" },
  "ft|8": { over: "ft_corners_over_8", under: "ft_corners_under_8" },
  "ft|8.5": { over: "ft_corners_over_8_5", under: "ft_corners_under_8_5" },
  "ft|9": { over: "ft_corners_over_9", under: "ft_corners_under_9" },
  "ft|9.5": { over: "ft_corners_over_9_5", under: "ft_corners_under_9_5" },
  "ft|10": { over: "ft_corners_over_10", under: "ft_corners_under_10" },
  "ft|10.5": { over: "ft_corners_over_10_5", under: "ft_corners_under_10_5" },
  "ft|11": { over: "ft_corners_over_11", under: "ft_corners_under_11" },
  "ft|11.5": { over: "ft_corners_over_11_5", under: "ft_corners_under_11_5" },
  "ft|12": { over: "ft_corners_over_12", under: "ft_corners_under_12" },
  "ft|12.5": { over: "ft_corners_over_12_5", under: "ft_corners_under_12_5" },
  "ft|13": { over: "ft_corners_over_13", under: "ft_corners_under_13" },
  "ft|13.5": { over: "ft_corners_over_13_5", under: "ft_corners_under_13_5" },
  // First Half
  "1h|3.5": { over: "1h_corners_over_3_5", under: "1h_corners_under_3_5" },
  "1h|4.5": { over: "1h_corners_over_4_5", under: "1h_corners_under_4_5" },
  "1h|5.5": { over: "1h_corners_over_5_5", under: "1h_corners_under_5_5" },
};

// ============================================
// Corners Handicap Mapping
// ============================================

const CORNERS_AH_ATOMS: Record<number, { home: string; away: string }> = {
  [-8.5]: { home: "ft_corners_home_ah_m8_5", away: "ft_corners_away_ah_p8_5" },
  [-8]: { home: "ft_corners_home_ah_m8", away: "ft_corners_away_ah_p8" },
  [-7.5]: { home: "ft_corners_home_ah_m7_5", away: "ft_corners_away_ah_p7_5" },
  [-7]: { home: "ft_corners_home_ah_m7", away: "ft_corners_away_ah_p7" },
  [-6.5]: { home: "ft_corners_home_ah_m6_5", away: "ft_corners_away_ah_p6_5" },
  [-6]: { home: "ft_corners_home_ah_m6", away: "ft_corners_away_ah_p6" },
  [-5.5]: { home: "ft_corners_home_ah_m5_5", away: "ft_corners_away_ah_p5_5" },
  [-5]: { home: "ft_corners_home_ah_m5", away: "ft_corners_away_ah_p5" },
  [-4.5]: { home: "ft_corners_home_ah_m4_5", away: "ft_corners_away_ah_p4_5" },
  [-4]: { home: "ft_corners_home_ah_m4", away: "ft_corners_away_ah_p4" },
  [-3.5]: { home: "ft_corners_home_ah_m3_5", away: "ft_corners_away_ah_p3_5" },
  [-3]: { home: "ft_corners_home_ah_m3", away: "ft_corners_away_ah_p3" },
  [-2.5]: { home: "ft_corners_home_ah_m2_5", away: "ft_corners_away_ah_p2_5" },
  [-2]: { home: "ft_corners_home_ah_m2", away: "ft_corners_away_ah_p2" },
  [-1.5]: { home: "ft_corners_home_ah_m1_5", away: "ft_corners_away_ah_p1_5" },
  [-1]: { home: "ft_corners_home_ah_m1", away: "ft_corners_away_ah_p1" },
  [-0.5]: { home: "ft_corners_home_ah_m0_5", away: "ft_corners_away_ah_p0_5" },
  [0]: { home: "ft_corners_home_ah_0", away: "ft_corners_away_ah_0" },
  [0.5]: { home: "ft_corners_home_ah_p0_5", away: "ft_corners_away_ah_m0_5" },
  [1]: { home: "ft_corners_home_ah_p1", away: "ft_corners_away_ah_m1" },
  [1.5]: { home: "ft_corners_home_ah_p1_5", away: "ft_corners_away_ah_m1_5" },
  [2]: { home: "ft_corners_home_ah_p2", away: "ft_corners_away_ah_m2" },
  [2.5]: { home: "ft_corners_home_ah_p2_5", away: "ft_corners_away_ah_m2_5" },
  [3]: { home: "ft_corners_home_ah_p3", away: "ft_corners_away_ah_m3" },
  [3.5]: { home: "ft_corners_home_ah_p3_5", away: "ft_corners_away_ah_m3_5" },
  [4]: { home: "ft_corners_home_ah_p4", away: "ft_corners_away_ah_m4" },
  [4.5]: { home: "ft_corners_home_ah_p4_5", away: "ft_corners_away_ah_m4_5" },
  [5]: { home: "ft_corners_home_ah_p5", away: "ft_corners_away_ah_m5" },
  [5.5]: { home: "ft_corners_home_ah_p5_5", away: "ft_corners_away_ah_m5_5" },
  [6]: { home: "ft_corners_home_ah_p6", away: "ft_corners_away_ah_m6" },
  [6.5]: { home: "ft_corners_home_ah_p6_5", away: "ft_corners_away_ah_m6_5" },

  [7]: { home: "ft_corners_home_ah_p7", away: "ft_corners_away_ah_m7" },
  [7.5]: { home: "ft_corners_home_ah_p7_5", away: "ft_corners_away_ah_m7_5" },
  [8]: { home: "ft_corners_home_ah_p8", away: "ft_corners_away_ah_m8" },
  [8.5]: { home: "ft_corners_home_ah_p8_5", away: "ft_corners_away_ah_m8_5" },};

// ============================================
// Corners Team Totals Mapping
// ============================================

const CORNERS_TEAM_TOTALS_ATOMS: Record<
  string,
  { over: string; under: string }
> = {
  "home|1": {
    over: "ft_home_corners_over_1",
    under: "ft_home_corners_under_1",
  },
  "home|1.5": {
    over: "ft_home_corners_over_1_5",
    under: "ft_home_corners_under_1_5",
  },
  "home|2": {
    over: "ft_home_corners_over_2",
    under: "ft_home_corners_under_2",
  },
  "home|2.5": {
    over: "ft_home_corners_over_2_5",
    under: "ft_home_corners_under_2_5",
  },
  "home|3": {
    over: "ft_home_corners_over_3",
    under: "ft_home_corners_under_3",
  },
  "home|3.5": {
    over: "ft_home_corners_over_3_5",
    under: "ft_home_corners_under_3_5",
  },
  "home|4": {
    over: "ft_home_corners_over_4",
    under: "ft_home_corners_under_4",
  },
  "home|4.5": {
    over: "ft_home_corners_over_4_5",
    under: "ft_home_corners_under_4_5",
  },
  "home|5": {
    over: "ft_home_corners_over_5",
    under: "ft_home_corners_under_5",
  },
  "home|5.5": {
    over: "ft_home_corners_over_5_5",
    under: "ft_home_corners_under_5_5",
  },
  "home|6": {
    over: "ft_home_corners_over_6",
    under: "ft_home_corners_under_6",
  },
  "home|6.5": {
    over: "ft_home_corners_over_6_5",
    under: "ft_home_corners_under_6_5",
  },
  "home|7": {
    over: "ft_home_corners_over_7",
    under: "ft_home_corners_under_7",
  },
  "home|7.5": {
    over: "ft_home_corners_over_7_5",
    under: "ft_home_corners_under_7_5",
  },
  "home|8": {
    over: "ft_home_corners_over_8",
    under: "ft_home_corners_under_8",
  },
  "home|8.5": {
    over: "ft_home_corners_over_8_5",
    under: "ft_home_corners_under_8_5",
  },
  "away|1": {
    over: "ft_away_corners_over_1",
    under: "ft_away_corners_under_1",
  },
  "away|1.5": {
    over: "ft_away_corners_over_1_5",
    under: "ft_away_corners_under_1_5",
  },
  "away|2": {
    over: "ft_away_corners_over_2",
    under: "ft_away_corners_under_2",
  },
  "away|2.5": {
    over: "ft_away_corners_over_2_5",
    under: "ft_away_corners_under_2_5",
  },
  "away|3": {
    over: "ft_away_corners_over_3",
    under: "ft_away_corners_under_3",
  },
  "away|3.5": {
    over: "ft_away_corners_over_3_5",
    under: "ft_away_corners_under_3_5",
  },
  "away|4": {
    over: "ft_away_corners_over_4",
    under: "ft_away_corners_under_4",
  },
  "away|4.5": {
    over: "ft_away_corners_over_4_5",
    under: "ft_away_corners_under_4_5",
  },
  "away|5": {
    over: "ft_away_corners_over_5",
    under: "ft_away_corners_under_5",
  },
  "away|5.5": {
    over: "ft_away_corners_over_5_5",
    under: "ft_away_corners_under_5_5",
  },
  "away|6": {
    over: "ft_away_corners_over_6",
    under: "ft_away_corners_under_6",
  },
  "away|6.5": {
    over: "ft_away_corners_over_6_5",
    under: "ft_away_corners_under_6_5",
  },
  "away|7": {
    over: "ft_away_corners_over_7",
    under: "ft_away_corners_under_7",
  },
  "away|7.5": {
    over: "ft_away_corners_over_7_5",
    under: "ft_away_corners_under_7_5",
  },
  "away|8": {
    over: "ft_away_corners_over_8",
    under: "ft_away_corners_under_8",
  },
  "away|8.5": {
    over: "ft_away_corners_over_8_5",
    under: "ft_away_corners_under_8_5",
  },
};

// ============================================
// Bookings Totals Mapping
// ============================================

const BOOKINGS_TOTALS_ATOMS: Record<number, { over: string; under: string }> = {
  2.5: { over: "ft_bookings_over_2_5", under: "ft_bookings_under_2_5" },
  3: { over: "ft_bookings_over_3", under: "ft_bookings_under_3" },
  3.5: { over: "ft_bookings_over_3_5", under: "ft_bookings_under_3_5" },
  4: { over: "ft_bookings_over_4", under: "ft_bookings_under_4" },
  4.5: { over: "ft_bookings_over_4_5", under: "ft_bookings_under_4_5" },
  5: { over: "ft_bookings_over_5", under: "ft_bookings_under_5" },
  5.5: { over: "ft_bookings_over_5_5", under: "ft_bookings_under_5_5" },
};

// ============================================
// Bookings Handicap Mapping
// ============================================

const BOOKINGS_AH_ATOMS: Record<number, { home: string; away: string }> = {
  [-1]: { home: "ft_bookings_home_ah_m1", away: "ft_bookings_away_ah_p1" },
  [-0.5]: {
    home: "ft_bookings_home_ah_m0_5",
    away: "ft_bookings_away_ah_p0_5",
  },
  [0]: { home: "ft_bookings_home_ah_0", away: "ft_bookings_away_ah_0" },
  [0.5]: { home: "ft_bookings_home_ah_p0_5", away: "ft_bookings_away_ah_m0_5" },
  [1]: { home: "ft_bookings_home_ah_p1", away: "ft_bookings_away_ah_m1" },
};

// ============================================
// Main Mapping Function
// ============================================

/**
 * Map a single Pinnacle outcome to an atom ID.
 *
 * @param marketType - Pinnacle market type (MONEYLINE, TOTAL_POINTS, etc.)
 * @param periodType - Pinnacle period type (Regular, FT, HT, 1H, etc.)
 * @param handicap - Line value (for totals and spreads)
 * @param side - Outcome side (HOME, AWAY, DRAW)
 * @param direction - Outcome direction (OVER, UNDER)
 * @param marketSide - Market-level side for team totals (HOME, AWAY)
 * @param halfIndicator - Half indicator (0=main/FT, 1=1H for TEAM_TOTAL_POINTS)
 * @returns atom_id or null if unmapped
 */
export function mapPinnacleToAtom(
  marketType: string,
  periodType: string,
  handicap: number,
  side: string,
  direction: string,
  marketSide?: string,
  halfIndicator?: number,
): string | null {
  const period = normalizePeriod(periodType);
  if (!period) return null;

  const sideLower = side.toLowerCase();
  const dirLower = direction.toLowerCase();

  // Handle Corners period separately
  if (period === "corners") {
    // Treat halfIndicator=1 as 1H for corners, otherwise FT
    const timeScope = halfIndicator === 1 ? "1h" : "ft";
    
    switch (marketType) {
      case "TOTAL_POINTS": {
        const key = `${timeScope}|${handicap}`;
        const mapping = CORNERS_TOTALS_ATOMS[key];
        if (!mapping) return null;
        if (dirLower === "over") return mapping.over;
        if (dirLower === "under") return mapping.under;
        return null;
      }

      case "SPREAD": {
        if (timeScope !== "ft") return null; // We only map FT corner spreads
        const mapping = CORNERS_AH_ATOMS[handicap];
        if (!mapping) return null;
        if (sideLower === "home") return mapping.home;
        if (sideLower === "away") return mapping.away;
        return null;
      }

      case "TEAM_TOTAL_POINTS": {
        const teamSide = (marketSide || "").toLowerCase();
        if (teamSide !== "home" && teamSide !== "away") return null;
        const key = `${teamSide}|${handicap}`;
        const mapping = CORNERS_TEAM_TOTALS_ATOMS[key];
        if (!mapping) return null;
        if (dirLower === "over") return mapping.over;
        if (dirLower === "under") return mapping.under;
        return null;
      }

      default:
        return null;
    }
  }

  // Handle Bookings period separately
  if (period === "bookings") {
    switch (marketType) {
      case "TOTAL_POINTS": {
        const mapping = BOOKINGS_TOTALS_ATOMS[handicap];
        if (!mapping) return null;
        if (dirLower === "over") return mapping.over;
        if (dirLower === "under") return mapping.under;
        return null;
      }

      case "SPREAD": {
        const mapping = BOOKINGS_AH_ATOMS[handicap];
        if (!mapping) return null;
        if (sideLower === "home") return mapping.home;
        if (sideLower === "away") return mapping.away;
        return null;
      }

      default:
        return null;
    }
  }

  // Handle Regular/1H periods
  switch (marketType) {
    case "MONEYLINE": {
      const periodMap = MATCH_RESULT_ATOMS[period];
      if (!periodMap) return null;
      return periodMap[sideLower] || null;
    }

    case "TOTAL_POINTS": {
      const key = `${period}|${handicap}`;
      const mapping = TOTALS_ATOMS[key];
      if (!mapping) return null;
      if (dirLower === "over") return mapping.over;
      if (dirLower === "under") return mapping.under;
      return null;
    }

    case "SPREAD": {
      const key = `${period}|${handicap}`;
      const mapping = AH_ATOMS[key];
      if (!mapping) return null;
      if (sideLower === "home") return mapping.home;
      if (sideLower === "away") return mapping.away;
      return null;
    }

    case "TEAM_TOTAL_POINTS": {
      const teamSide = (marketSide || "").toLowerCase();
      if (teamSide !== "home" && teamSide !== "away") return null;
      // For TEAM_TOTAL_POINTS, halfIndicator encodes the time scope
      // (periodType is always "Regular" for both FT and 1H):
      //   halfIndicator=0 → Full Time,  halfIndicator=1 → 1st Half
      const ttPeriod = halfIndicator === 1 ? "1h" : (period ?? "ft");
      const key = `${ttPeriod}|${teamSide}|${handicap}`;
      const mapping = TEAM_TOTALS_ATOMS[key];
      if (!mapping) return null;
      if (dirLower === "over") return mapping.over;
      if (dirLower === "under") return mapping.under;
      return null;
    }

    default:
      return null;
  }
}

// ============================================
// Pinnacle Market Tuple Types
// ============================================

export type PinnacleOutcomeTuple = [
  odds: number | null,
  handicap: number | null,
  side: string,
  direction: string,
  originalOdds: number | null,
];

export type PinnacleMarketTuple = [
  periodId: number,
  halfIndicator: number,
  marketId: number,
  unknown3: number,
  marketType: string,
  unknown5: boolean,
  maxStake: number,
  unknown7: number,
  unknown8: number,
  eventId: number,
  periodType: string,
  score: number,
  outcomes: PinnacleOutcomeTuple[],
  handicap: number,
  identifier: string,
  side: string,
  status: string,
  fullIdentifier: string,
  timestamp: number,
];

// ============================================
// Live Score Context for Handicap Adjustment
// ============================================

/**
 * Score context for live handicap adjustment.
 * When provided, SPREAD (Asian Handicap) lines are adjusted from
 * "running ball" (from now) to "full match" semantics.
 */
export interface ScoreContext {
  homeScore: number;
  awayScore: number;
}

/**
 * Corners score context for live corners handicap adjustment.
 * When provided, corners SPREAD lines are adjusted similarly.
 */
export interface CornersScoreContext {
  homeCorners: number;
  awayCorners: number;
}

// ============================================
// Extraction Function
// ============================================

/**
 * Extract normalized odds entries from a Pinnacle market tuple.
 *
 * @param market - Raw Pinnacle market tuple (19 elements)
 * @param eventId - Normalized event ID (e.g., "pinnacle-12345")
 * @param score - Optional live score for handicap adjustment
 * @param cornersScore - Optional corners score for corners handicap adjustment
 * @returns Array of normalized odds entries
 *
 * Live Handicap Adjustment:
 * Pinnacle uses "running ball" handicaps for live events - the line applies
 * from the current moment forward, ignoring the current score.
 * Other providers (NW-SB) use "full match" handicaps - the line applies to
 * the entire match result.
 *
 * To make them comparable, we adjust Pinnacle's SPREAD lines:
 *   fullMatchLine = runningBallLine - (homeScore - awayScore)
 *
 * Example (Score 0-1, away leading):
 *   Pinnacle Home +0.5 (running) → +0.5 - (0-1) = +0.5 + 1 = Home +1.5 (full match)
 * Example (Score 1-0, home leading):
 *   Pinnacle Home -0.5 (running) → -0.5 - (1-0) = -0.5 - 1 = Home -1.5 (full match)
 *
 * The same adjustment applies to corners handicaps when cornersScore is provided.
 */
export function extractPinnacleOdds(
  market: PinnacleMarketTuple,
  eventId: string,
  score?: ScoreContext,
  cornersScore?: CornersScoreContext,
): NormalizedOddsEntry[] {
  const entries: NormalizedOddsEntry[] = [];

  const halfIndicator = market[1];
  const marketType = market[4];
  const periodType = market[10];
  const outcomes = market[12];
  const handicap = market[13];
  const marketSide = market[15]; // For TEAM_TOTAL_POINTS
  const status = market[16];
  const timestamp = market[18];

  // Skip non-open markets
  if (status !== "OPEN") {
    return entries;
  }

  // Skip alternative line markets (halfIndicator=1 means alternative market).
  // Main markets have halfIndicator=0 and higher max stakes.
  // Exception: TEAM_TOTAL_POINTS — halfIndicator encodes the time scope:
  //   0 → Full Time team totals
  //   1 → 1st Half team totals
  // Both carry periodType "Regular", so we override the period below.
  if (halfIndicator !== 0 && marketType !== "TEAM_TOTAL_POINTS") {
    return entries;
  }

  // Adjust handicap for live SPREAD markets (running ball → full match)
  // Formula: fullMatchLine = runningBallLine - (homeScore - awayScore)
  // Example: Running +0.5 at score 0-1 → +0.5 - (0-1) = +0.5 + 1 = +1.5 full match
  let adjustedHandicap = handicap;
  if (marketType === "SPREAD") {
    const period = normalizePeriod(periodType);

    // Corners SPREAD adjustment
    if (period === "corners" && cornersScore) {
      const cornersDiff = cornersScore.homeCorners - cornersScore.awayCorners;
      adjustedHandicap = handicap - cornersDiff;
    }
    // Goals SPREAD adjustment (Regular/FT/HT periods)
    else if (score && (period === "ft" || period === "1h")) {
      const scoreDiff = score.homeScore - score.awayScore;
      adjustedHandicap = handicap - scoreDiff;
    }
  }

  const provider: ProviderKey = "pinnacle";

  for (const outcome of outcomes) {
    const [odds, , side, direction] = outcome;

    // Skip null or invalid odds
    if (odds === null || odds <= 1) continue;

    const atomId = mapPinnacleToAtom(
      marketType,
      periodType,
      adjustedHandicap, // Use adjusted line for SPREAD, original for others
      side,
      direction,
      marketSide,
      halfIndicator,
    );

    if (!atomId) {
      // Harvest unmapped market for diagnostics
      bufferUnmappedMarket({
        provider: "pinnacle",
        rawMarketKey: `${marketType}:${periodType}:${adjustedHandicap}:${side}:${direction}`,
        rawMarketName: `${marketType} / ${periodType} / ${side || direction}`,
        samplePayload: {
          marketType,
          periodType,
          handicap: adjustedHandicap,
          side,
          direction,
          marketSide,
          halfIndicator,
          odds,
        },
      });
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
      odds,
      timestamp,
    });
  }

  return entries;
}
