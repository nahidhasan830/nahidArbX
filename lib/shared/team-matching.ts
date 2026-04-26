/**
 * Shared Team Matching Utilities
 *
 * Centralized logic for matching selection names to team names.
 * Used by NineWickets adapters to correctly identify home/away outcomes.
 *
 * Key principle: Compare BOTH teams and pick the better match to avoid
 * false positives (e.g., "Asociacion Deportiva" matching "Deportivo Saprissa").
 */

import { bestSim } from "@/lib/matching/string-sim";

// Drop-in shim so the legacy `stringSimilarity.compareTwoStrings(...)`
// call sites keep their current shape.
const stringSimilarity = { compareTwoStrings: bestSim };

// ============================================
// Normalization Helpers
// ============================================

/**
 * Normalize a team name for matching:
 * - Convert to lowercase
 * - Remove accents/diacritics (ä→a, é→e, etc.)
 * - Normalize hyphens to spaces (Al-Ahli → Al Ahli)
 * - Remove common prefixes (FK, FC, PFC, etc.)
 */
function normalizeTeamName(name: string): string {
  return (
    name
      .toLowerCase()
      // Remove accents using Unicode normalization
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      // Normalize hyphens to spaces (fixes Al-Ahli vs Al Ahli mismatches)
      .replace(/-/g, " ")
      // Remove common club prefixes (at word boundaries)
      .replace(/^(fk|fc|pfc|afc|sc|sv|tsv|vfb|vfl|bsc|1\.)\s+/i, "")
      .trim()
  );
}

// ============================================
// Core Matching Functions
// ============================================

/**
 * Calculate match score between a selection name and team name.
 * Returns a score from 0 to 1, where higher is better match.
 */
export function getTeamMatchScore(
  selectionName: string,
  teamName: string,
): number {
  if (!selectionName || !teamName) return 0;

  // First try with normalized names (handles accents and prefixes)
  const selNorm = normalizeTeamName(selectionName);
  const teamNorm = normalizeTeamName(teamName);

  // Also keep original lowercase for fallback
  const selLower = selectionName.toLowerCase();
  const teamLower = teamName.toLowerCase();

  // Exact match (try both normalized and original)
  if (selNorm === teamNorm || selLower === teamLower) return 1.0;

  // Full substring match (one contains the other entirely)
  // Score based on coverage - longer matches get higher scores
  // This prevents "Al Ahli" (short) from scoring same as "Shabab Al Ahli Dubai" (long)
  const isSubstring =
    selNorm.includes(teamNorm) ||
    teamNorm.includes(selNorm) ||
    selLower.includes(teamLower) ||
    teamLower.includes(selLower);

  if (isSubstring) {
    // Calculate coverage: how much of the longer string is covered by the shorter
    const shorter = Math.min(teamNorm.length, selNorm.length);
    const longer = Math.max(teamNorm.length, selNorm.length);
    const coverage = shorter / longer;
    // Base score 0.8, bonus up to 0.15 based on coverage (max 0.95 for near-exact matches)
    return 0.8 + coverage * 0.15;
  }

  // Word-based matching: check if significant words match
  // Use normalized names for word matching (handles "Qabala" vs "FK Qäbälä")
  const selWords = selNorm.split(/\s+/).filter((w) => w.length > 2);
  const teamWords = teamNorm.split(/\s+/).filter((w) => w.length > 2);

  // Count matching words (exact word matches)
  let matchingWords = 0;
  for (const teamWord of teamWords) {
    if (
      selWords.some(
        (sw) =>
          sw === teamWord || sw.includes(teamWord) || teamWord.includes(sw),
      )
    ) {
      matchingWords++;
    }
  }

  // If most team words match, boost the score
  const wordMatchRatio =
    teamWords.length > 0 ? matchingWords / teamWords.length : 0;
  if (wordMatchRatio >= 0.5) {
    // At least half the words match - this is a good signal
    return Math.max(0.7, stringSimilarity.compareTwoStrings(selNorm, teamNorm));
  }

  // String similarity (Dice coefficient) - use normalized for better matching
  return stringSimilarity.compareTwoStrings(selNorm, teamNorm);
}

/**
 * Determine if selection matches home or away team.
 * Compares both and returns the better match to avoid false positives.
 *
 * @param selectionName - The selection/runner name from the provider
 * @param homeTeam - Home team name (source of truth, usually from Pinnacle)
 * @param awayTeam - Away team name (source of truth, usually from Pinnacle)
 * @returns "home" | "away" | null
 */
export function matchTeamSide(
  selectionName: string,
  homeTeam: string,
  awayTeam: string,
): "home" | "away" | null {
  const homeScore = getTeamMatchScore(selectionName, homeTeam);
  const awayScore = getTeamMatchScore(selectionName, awayTeam);

  // Require minimum threshold to avoid random matches
  const minThreshold = 0.25;

  // If neither matches well enough, return null
  if (homeScore < minThreshold && awayScore < minThreshold) {
    return null;
  }

  // Return the better match - since we compare BOTH teams,
  // the higher score wins even if scores are close
  if (homeScore > awayScore) return "home";
  if (awayScore > homeScore) return "away";

  // Scores are exactly equal (rare) - can't determine
  return null;
}

/**
 * Check if two team names refer to the same team.
 * Uses string similarity with a threshold.
 *
 * @deprecated Use matchTeamSide() for comparing selections to home/away.
 * This function is kept for backward compatibility but should be avoided
 * as it can produce false positives.
 */
export function isSameTeam(selectionName: string, teamName: string): boolean {
  if (!selectionName || !teamName) return false;
  const similarity = stringSimilarity.compareTwoStrings(
    selectionName.toLowerCase(),
    teamName.toLowerCase(),
  );
  return similarity >= 0.5;
}

// ============================================
// Team Name Parsing
// ============================================

/**
 * Parse team names from an event name string.
 * Handles common separators: " v ", " vs ", " - "
 *
 * @param eventName - Event name like "Team A v Team B"
 * @returns Parsed teams or null if parsing fails
 */
export function parseTeamsFromEventName(
  eventName: string,
): { home: string; away: string } | null {
  // Try common separators
  const separators = [/ v /i, / vs /i, / - /];

  for (const sep of separators) {
    const parts = eventName.split(sep);
    if (parts.length === 2) {
      return {
        home: parts[0].trim(),
        away: parts[1].trim(),
      };
    }
  }

  return null;
}
