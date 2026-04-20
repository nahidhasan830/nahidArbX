/**
 * Group-Conflict Guard
 *
 * Many leagues are split into geographically distinct sub-divisions:
 * Serie C Girone A/B/C, Kakkonen Group A/B/C, Primera Federación Group 1/2,
 * III Liga Group I/II/III/IV, etc. Each group has different teams and is
 * effectively a separate competition for matching purposes.
 *
 * The harvester saw enough cross-group false positives (167+ for Serie C
 * alone) that "Serie C Group A" and "Serie C Group C" ended up aliased
 * together. This guard blocks that at the source.
 *
 * Rule: if one name carries a group marker and the other doesn't, OR
 * the markers differ, reject the alias — the names refer to different
 * competitions even if most of the surrounding text matches.
 */

const ROMAN_TO_ARABIC: Record<string, string> = {
  i: "1",
  ii: "2",
  iii: "3",
  iv: "4",
  v: "5",
  vi: "6",
  vii: "7",
  viii: "8",
  ix: "9",
  x: "10",
};

const WORD_TO_ARABIC: Record<string, string> = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
};

// Only true sub-group markers. NOT "division" — that's commonly a league
// name itself (e.g. Cyprus First Division), not a sub-division of one.
const GROUP_MARKER_RE =
  /\b(?:group|grupo|gruppe|gruppo|girone|gironi|conference)\s*-?\s*([a-z0-9]+)\b/i;

function normalizeMarker(token: string): string {
  const lower = token.toLowerCase();
  if (ROMAN_TO_ARABIC[lower]) return ROMAN_TO_ARABIC[lower];
  if (WORD_TO_ARABIC[lower]) return WORD_TO_ARABIC[lower];
  return lower;
}

/**
 * Extracts a normalized group marker ("a", "1", etc.) or null if absent.
 * Roman numerals and number-words are folded to digits so "group iii"
 * matches "group 3".
 */
export function extractGroupMarker(name: string): string | null {
  const m = name.match(GROUP_MARKER_RE);
  if (!m) return null;
  return normalizeMarker(m[1]);
}

/**
 * True if aliasing these two competition names would conflate distinct
 * sub-divisions. Covers two cases:
 *   1. Different groups: "Serie C Group A" ↔ "Serie C Group B"
 *   2. Ambiguous ↔ specific: "Serie C" ↔ "Serie C Group A"
 *      (the bare name could refer to any group — merging it into one
 *      specific group would mis-route matches from the others.)
 */
export function hasGroupConflict(nameA: string, nameB: string): boolean {
  const a = extractGroupMarker(nameA);
  const b = extractGroupMarker(nameB);
  if (a === null && b === null) return false;
  return a !== b;
}
