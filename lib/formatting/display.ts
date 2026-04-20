/**
 * Team Name & Competition Name Formatting
 *
 * Provides human-readable labels for:
 * - Team names (e.g., "Man Utd" → "Manchester United")
 * - Competition names (e.g., "eng.1" → "English Premier League")
 * - Event titles (e.g., "Man Utd vs Liverpool · English Premier League")
 *
 * These functions apply the alias system (learned via the diagnostics panel)
 * and fall back to reasonable title-casing when no alias exists.
 */

import {
  applyTeamAlias as _applyTeamAlias,
  applyCompetitionAlias as _applyCompetitionAlias,
  normalize as _normalize,
  normalizeCompetition as _normalizeCompetition,
  preNormalizeEvent as _preNormalizeEvent,
  preNormalizeAll as _preNormalizeAll,
  type PreNormalizedNames,
} from "@/lib/matching/normalize";

// Re-export alias functions so consumers can import from one place
export {
  _applyTeamAlias as applyTeamAlias,
  _applyCompetitionAlias as applyCompetitionAlias,
  _normalize as normalize,
  _normalizeCompetition as normalizeCompetition,
  _preNormalizeEvent as preNormalizeEvent,
  _preNormalizeAll as preNormalizeAll,
};
export type { PreNormalizedNames };

// ---------------------------------------------------------------------------
// Team Name Formatting
// ---------------------------------------------------------------------------

/**
 * Format a team name for human-readable display.
 *
 * 1. Applies alias mapping (e.g., "Man Utd" → "Manchester United")
 * 2. Falls back to title-casing if no alias exists
 *
 * @param name Raw team name from API/database
 * @returns Human-readable team name
 */
export function formatTeamName(name: string): string {
  if (!name) return "—";
  // Try alias first
  const aliased = _applyTeamAlias(name);
  const normalized = _normalize(name);
  if (aliased && aliased !== normalized) {
    return aliased
      .split(" ")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }
  // Fallback: title-case the original name
  return titleCase(name);
}

// ---------------------------------------------------------------------------
// Competition Name Formatting
// ---------------------------------------------------------------------------

/**
 * Format a competition name for human-readable display.
 *
 * 1. Applies alias mapping (e.g., "eng.1" → "English Premier League")
 * 2. Falls back to title-casing if no alias exists
 *
 * @param name Raw competition name from API/database
 * @returns Human-readable competition name
 */
export function formatCompetitionName(name: string): string {
  if (!name || name.toLowerCase() === "unknown") return "—";
  // Try alias first
  const aliased = _applyCompetitionAlias(name);
  const normalized = _normalizeCompetition(name);
  if (aliased && aliased !== normalized) {
    return aliased
      .split(" ")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }
  // Fallback: title-case the original name
  return titleCase(name);
}

// ---------------------------------------------------------------------------
// Event Title Formatting
// ---------------------------------------------------------------------------

/**
 * Format a full event title for display.
 *
 * @param homeTeam Raw home team name
 * @param awayTeam Raw away team name
 * @param competition Raw competition name
 * @returns Formatted event title, e.g. "Manchester United vs Liverpool · English Premier League"
 */
export function formatEventTitle(
  homeTeam: string,
  awayTeam: string,
  competition?: string | null,
): string {
  const home = formatTeamName(homeTeam);
  const away = formatTeamName(awayTeam);
  const comp = competition ? formatCompetitionName(competition) : null;
  return comp ? `${home} vs ${away} · ${comp}` : `${home} vs ${away}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Title-case a string, handling hyphens and apostrophes gracefully.
 */
function titleCase(s: string): string {
  return s
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => {
      // Preserve acronyms like "FC", "U21", "W"
      if (/^[A-Z0-9]+$/.test(word)) return word;
      // Handle apostrophes: "o'neill" → "O'Neill"
      if (word.includes("'")) {
        return word
          .split("'")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join("'");
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}
