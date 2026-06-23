
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

const GROUP_MARKER_RE =
  /\b(?:group|grupo|gruppe|gruppo|girone|gironi|conference)\s*-?\s*([a-z0-9]+)\b/i;

function normalizeMarker(token: string): string {
  const lower = token.toLowerCase();
  if (ROMAN_TO_ARABIC[lower]) return ROMAN_TO_ARABIC[lower];
  if (WORD_TO_ARABIC[lower]) return WORD_TO_ARABIC[lower];
  return lower;
}

export function extractGroupMarker(name: string): string | null {
  const m = name.match(GROUP_MARKER_RE);
  if (!m) return null;
  return normalizeMarker(m[1]);
}

export function hasGroupConflict(nameA: string, nameB: string): boolean {
  const a = extractGroupMarker(nameA);
  const b = extractGroupMarker(nameB);
  if (a === null && b === null) return false;
  return a !== b;
}
