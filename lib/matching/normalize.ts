/**
 * Shared Normalization Functions
 *
 * Single source of truth for team name and competition normalization.
 * Used by both matcher.ts and diagnostics/analyzer.ts.
 *
 * Pre-normalization: call `preNormalizeEvent()` once per event at the start
 * of matching, then pass the pre-normalized names to score computation.
 * This avoids re-normalizing the same strings on every O(n²) comparison.
 */

import type { NormalizedEvent } from "../types";
import { getTeamAliases, getCompetitionAliases } from "./aliases/store";

// ============================================
// Country Adjective → Noun Map
// ============================================

export const COUNTRY_ADJECTIVE_MAP: Record<string, string> = {
  english: "england",
  british: "england",
  scottish: "scotland",
  welsh: "wales",
  irish: "ireland",
  spanish: "spain",
  german: "germany",
  french: "france",
  italian: "italy",
  dutch: "netherlands",
  portuguese: "portugal",
  belgian: "belgium",
  austrian: "austria",
  swiss: "switzerland",
  turkish: "turkey",
  greek: "greece",
  polish: "poland",
  czech: "czech republic",
  russian: "russia",
  ukrainian: "ukraine",
  brazilian: "brazil",
  argentine: "argentina",
  mexican: "mexico",
  american: "usa",
  japanese: "japan",
  korean: "korea",
  chinese: "china",
  australian: "australia",
};

// Pre-compiled regex for each country adjective (avoid re-creating per call)
const ADJECTIVE_REGEXES = Object.entries(COUNTRY_ADJECTIVE_MAP).map(
  ([adj, noun]) => ({ regex: new RegExp(`\\b${adj}\\b`, "g"), noun }),
);

const ALL_COUNTRIES = [
  ...Object.values(COUNTRY_ADJECTIVE_MAP),
  ...Object.keys(COUNTRY_ADJECTIVE_MAP),
];
const COUNTRY_PREFIX_REGEXES = ALL_COUNTRIES.map(
  (country) => new RegExp(`^${country}\\s+`, "i"),
);

// ============================================
// Basic Normalization
// ============================================

/**
 * Common football-club prefixes/suffixes that carry no identity information.
 * Stripped as whole-word tokens at start or end only (never inside a word),
 * so "FC Barcelona" and "Chelsea FC" collapse to "barcelona" / "chelsea",
 * but "FCB" (where the letters are fused) is left intact for acronym-aware
 * handling elsewhere.
 */
const CLUB_TOKEN_STRIP_RE =
  /(^|\s)(fc|sc|cf|ac|as|ss|sv|us|aek|vfb|vfl|tsv|bk|if|kv|sk|sc|rc|rcd|psc|dsc)(?=$|\s)/g;

/**
 * Short-form expansions for common football-club words. Applied after basic
 * normalization so "Man Utd" / "Man Cty" / "Seattle Intl." all collapse to
 * their long forms, which is what the alias table and similarity scorer see.
 */
const SHORT_FORM_MAP: Array<[RegExp, string]> = [
  [/\butd\b/g, "united"],
  [/\bunt\b/g, "united"],
  [/\bcty\b/g, "city"],
  [/\bintl\b/g, "international"],
  [/\bathl\b/g, "athletic"],
  [/\batl\b/g, "atletico"],
  [/\bwnd\b/g, "wanderers"],
  [/\bwdrs\b/g, "wanderers"],
  [/\brvrs\b/g, "rovers"],
  [/\brgrs\b/g, "rangers"],
];

/**
 * Basic string normalization: lowercase, strip diacritics, remove
 * punctuation, expand common short forms, and strip common club-name
 * prefixes/suffixes (FC, SC, CF, AC, etc.) as whole-word tokens.
 *
 * The expand + strip passes run AFTER the lower/diacritic/punctuation pass
 * so "FC Barça", "Barça FC", "FC Barcelona", and "Barcelona FC" all settle
 * on "barcelona" (or "barca" for the short form). That turns a 0.6
 * similarity into ~1.0, which puts the pair above the auto-match threshold
 * without any AI or alias learning.
 */
export function normalize(s: string): string {
  let out = s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  for (const [re, replacement] of SHORT_FORM_MAP) {
    out = out.replace(re, replacement);
  }

  // Strip club-prefix/suffix tokens, then tidy whitespace. We do this twice
  // to handle names like "FC Barcelona FC" that have tokens at both ends.
  for (let i = 0; i < 2; i++) {
    out = out.replace(CLUB_TOKEN_STRIP_RE, "$1").replace(/\s+/g, " ").trim();
  }

  // Guard: never return an empty string — if stripping consumed everything
  // (e.g. "FC"), fall back to the basic-normalized original.
  if (!out) {
    return s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, "")
      .trim();
  }

  return out;
}

/**
 * Competition normalization with country adjective handling.
 * 1. Replace adjectives with nouns (English → England)
 * 2. Strip country prefixes (England FA Cup → FA Cup)
 */
export function normalizeCompetition(s: string): string {
  let result = normalize(s);

  for (const { regex, noun } of ADJECTIVE_REGEXES) {
    result = result.replace(regex, noun);
  }

  for (const prefixRegex of COUNTRY_PREFIX_REGEXES) {
    result = result.replace(prefixRegex, "");
  }

  return result.trim();
}

// ============================================
// Alias Application
// ============================================

/**
 * Apply team alias if one exists.
 */
export function applyTeamAlias(name: string): string {
  const normalized = normalize(name);
  const aliases = getTeamAliases();
  return aliases[normalized] || normalized;
}

/**
 * Apply competition alias if one exists.
 */
export function applyCompetitionAlias(name: string): string {
  const normalized = normalizeCompetition(name);
  const aliases = getCompetitionAliases();
  return aliases[normalized] || normalized;
}

// ============================================
// Pre-Normalization (computed once per event)
// ============================================

export interface PreNormalizedNames {
  home: string;
  away: string;
  competition: string;
}

/**
 * Pre-normalize an event's names. Call once per event before matching.
 * Returns the normalized+aliased home, away, and competition names.
 */
export function preNormalizeEvent(event: NormalizedEvent): PreNormalizedNames {
  return {
    home: applyTeamAlias(event.homeTeam),
    away: applyTeamAlias(event.awayTeam),
    competition: applyCompetitionAlias(event.competition),
  };
}

/**
 * Pre-normalize all events and return a lookup map.
 * Use this at the start of matchEvents to avoid per-comparison normalization.
 */
export function preNormalizeAll(
  events: NormalizedEvent[],
): Map<string, PreNormalizedNames> {
  const map = new Map<string, PreNormalizedNames>();
  for (const event of events) {
    map.set(event.id, preNormalizeEvent(event));
  }
  return map;
}
