
import atomsData from "@/lib/atoms/atoms.json";

const TIME_SCOPE_LABELS: Record<string, string> = {
  ft: "", // Full Time - omit for cleaner display
  "1h": "1H",
  "2h": "2H",
};

export const MARKET_TYPE_LABELS: Record<string, string> = {
  MATCH_RESULT: "Match Result",
  MATCH_ODDS: "Match Result",
  TOTAL_GOALS: "Total Goals",
  ASIAN_HANDICAP: "Handicap",
  EUROPEAN_HANDICAP: "European Handicap",
  BTTS: "Both Teams To Score",
  BOTH_TEAMS_TO_SCORE: "Both Teams To Score",
  DNB: "Draw No Bet",
  DRAW_NO_BET: "Draw No Bet",
  HOME_TEAM_TOTAL: "Home Total",
  AWAY_TEAM_TOTAL: "Away Total",
  CORNERS: "Corners",
  CORNERS_HANDICAP: "Corners Handicap",
  CORNERS_EUROPEAN_HANDICAP: "Corners European Handicap",
  HOME_CORNERS_TOTAL: "Home Corners",
  AWAY_CORNERS_TOTAL: "Away Corners",
  BOOKINGS: "Bookings",
  BOOKINGS_HANDICAP: "Bookings Handicap",
  ODD_EVEN_GOALS: "Odd/Even Goals",
  CLEAN_SHEET: "Clean Sheet",
  WIN_TO_NIL: "Win To Nil",
  TO_SCORE: "To Score",
  MONEYLINE: "Moneyline",
  SPREAD: "Point Spread",
  TOTAL_POINTS: "Total Points",
  TEAM_TOTAL_POINTS: "Team Total",
  OVER_UNDER: "Over/Under",
  DOUBLE_CHANCE: "Double Chance",
  CORRECT_SCORE: "Correct Score",
  HALF_TIME_FULL_TIME: "HT/FT",
};

export function formatMarketType(marketType: string): string {
  if (MARKET_TYPE_LABELS[marketType]) {
    return MARKET_TYPE_LABELS[marketType];
  }
  if (/^[A-Z0-9_]+$/.test(marketType)) {
    return marketType
      .split("_")
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
  }
  return marketType;
}

export function formatTimeScope(scope: string | null): string | null {
  if (!scope) return null;
  const s = scope.toUpperCase();
  if (s === "FT") return null;
  const map: Record<string, string> = {
    HT: "Half-time",
    "1H": "1st Half",
    "2H": "2nd Half",
    T1: "1st Half",
    T2: "2nd Half",
    P1: "1st Period",
    P2: "2nd Period",
    P3: "3rd Period",
    Q1: "1st Quarter",
    Q2: "2nd Quarter",
    Q3: "3rd Quarter",
    Q4: "4th Quarter",
    OT: "Overtime",
    ET: "Extra Time",
  };
  return map[s] ?? s;
}

function detectSpecializedHandicap(parts: string[]): string | null {
  if (parts.includes("corners")) return "corners";
  if (parts.includes("bookings")) return "bookings";
  return null;
}

function extractLineFromParts(parts: string[]): string | null {
  if (parts.length === 0) return null;

  const first = parts[0];

  if (first.startsWith("m") || first.startsWith("p")) {
    const sign = first.startsWith("m") ? "-" : "+";
    const allParts = [first.slice(1), ...parts.slice(1)];
    const value = allParts.join(".");
    return `${sign}${value}`;
  }

  if (/^\d/.test(first)) {
    return parts.join(".");
  }

  return null;
}

export function formatFamilyLabel(familyId: string): string {
  const parts = familyId.split("_");
  if (parts.length === 0) return familyId;

  const timeScope = parts[0].toLowerCase();
  const timeScopeLabel = TIME_SCOPE_LABELS[timeScope] ?? "";
  const meaningful = parts.slice(1);

  if (meaningful.length === 0) return familyId;

  const joined = meaningful.join("_").toLowerCase();

  if (joined === "match_result" || joined.includes("match_result")) {
    return timeScopeLabel ? `${timeScopeLabel} Match Result` : "Match Result";
  }

  if (joined === "btts" || joined.startsWith("btts")) {
    return timeScopeLabel
      ? `${timeScopeLabel} Both Teams To Score`
      : "Both Teams To Score";
  }

  if (joined === "dnb" || joined.startsWith("dnb")) {
    return timeScopeLabel ? `${timeScopeLabel} Draw No Bet` : "Draw No Bet";
  }

  if (meaningful[0] === "ah") {
    const lineParts = meaningful.slice(1);
    const line = extractLineFromParts(lineParts);
    const label = line ? `Handicap ${line}` : "Handicap";
    return timeScopeLabel ? `${timeScopeLabel} ${label}` : label;
  }

  if (meaningful[0] === "eh") {
    const lineParts = meaningful.slice(1);
    const line = extractLineFromParts(lineParts);
    const label = line ? `European Handicap ${line}` : "European Handicap";
    return timeScopeLabel ? `${timeScopeLabel} ${label}` : label;
  }

  if (meaningful[0] === "total") {
    const lineParts = meaningful.slice(1);
    const line = extractLineFromParts(lineParts);
    const label = line ? `Total Goals ${line}` : "Total Goals";
    return timeScopeLabel ? `${timeScopeLabel} ${label}` : label;
  }

  if (meaningful[0] === "corners" && meaningful[1] === "ah") {
    const lineParts = meaningful.slice(2);
    const line = extractLineFromParts(lineParts);
    const label = line ? `Corners Handicap ${line}` : "Corners Handicap";
    return timeScopeLabel ? `${timeScopeLabel} ${label}` : label;
  }

  if (meaningful[0] === "corners") {
    const lineParts = meaningful.slice(1);
    const line = extractLineFromParts(lineParts);
    const label = line ? `Corners ${line}` : "Corners";
    return timeScopeLabel ? `${timeScopeLabel} ${label}` : label;
  }

  if (meaningful[0] === "bookings" && meaningful[1] === "ah") {
    const lineParts = meaningful.slice(2);
    const line = extractLineFromParts(lineParts);
    const label = line ? `Bookings Handicap ${line}` : "Bookings Handicap";
    return timeScopeLabel ? `${timeScopeLabel} ${label}` : label;
  }

  if (meaningful[0] === "bookings") {
    const lineParts = meaningful.slice(1);
    const line = extractLineFromParts(lineParts);
    const label = line ? `Bookings ${line}` : "Bookings";
    return timeScopeLabel ? `${timeScopeLabel} ${label}` : label;
  }

  if (
    (meaningful[0] === "home" || meaningful[0] === "away") &&
    meaningful[1] === "total"
  ) {
    const team = meaningful[0].charAt(0).toUpperCase() + meaningful[0].slice(1);
    const lineParts = meaningful.slice(2);
    const line = extractLineFromParts(lineParts);
    const label = line ? `${team} Total ${line}` : `${team} Total`;
    return timeScopeLabel ? `${timeScopeLabel} ${label}` : label;
  }

  if (joined === "odd_even" || joined.includes("odd_even")) {
    return timeScopeLabel
      ? `${timeScopeLabel} Odd/Even Goals`
      : "Odd/Even Goals";
  }

  if (joined.includes("clean_sheet")) {
    return timeScopeLabel ? `${timeScopeLabel} Clean Sheet` : "Clean Sheet";
  }

  if (joined.includes("win_to_nil")) {
    return timeScopeLabel ? `${timeScopeLabel} Win To Nil` : "Win To Nil";
  }

  const fallback = meaningful
    .join(" ")
    .replace(/(\d) (\d)/g, "$1.$2")
    .replace(/\b(\w)/g, (c) => c.toUpperCase());

  return timeScopeLabel ? `${timeScopeLabel} ${fallback}` : fallback;
}

export function formatAtomLabel(atomId: string): string {
  const parts = atomId.split("_");
  const meaningful = parts.slice(1);

  if (meaningful.length === 0) return atomId;

  const specializedHC = detectSpecializedHandicap(meaningful);
  if (specializedHC && meaningful.includes("ah")) {
    const teamIdx = meaningful.findIndex((p) => p === "home" || p === "away");
    const lineIdx = meaningful.findIndex(
      (p) => p.startsWith("m") || p.startsWith("p"),
    );
    if (teamIdx !== -1 && lineIdx !== -1) {
      const team = meaningful[teamIdx];
      const lineParts = meaningful.slice(lineIdx);
      const line = extractLineFromParts(lineParts);
      if (line) {
        return `${team.charAt(0).toUpperCase() + team.slice(1)} ${line}`;
      }
    }
  }

  if (meaningful.includes("ah")) {
    const team = meaningful[0];
    const lineIdx = meaningful.findIndex(
      (p) => p.startsWith("m") || p.startsWith("p"),
    );
    if (lineIdx !== -1) {
      const lineParts = meaningful.slice(lineIdx);
      const line = extractLineFromParts(lineParts);
      if (line) {
        return `${team.charAt(0).toUpperCase() + team.slice(1)} ${line}`;
      }
    }
  }

  if (meaningful.includes("eh")) {
    const team = meaningful[0];
    const ehIdx = meaningful.indexOf("eh");
    if (ehIdx !== -1 && ehIdx + 1 < meaningful.length) {
      const lineParts = meaningful.slice(ehIdx + 1);
      const line = extractLineFromParts(lineParts);
      if (line) {
        return `${team.charAt(0).toUpperCase() + team.slice(1)} ${line}`;
      }
    }
    return `${team.charAt(0).toUpperCase() + team.slice(1)}`;
  }

  if (meaningful.includes("over") || meaningful.includes("under")) {
    const action = meaningful.includes("over") ? "Over" : "Under";
    const lineIdx = meaningful.findIndex((p) => /^\d/.test(p));
    if (lineIdx !== -1) {
      const lineParts = meaningful.slice(lineIdx);
      const line = lineParts.join(".");
      return `${action} ${line}`;
    }
    return action;
  }

  if (meaningful.includes("win")) {
    const team = meaningful[0];
    return `${team.charAt(0).toUpperCase() + team.slice(1)} Win`;
  }
  if (meaningful.includes("draw")) {
    return "Draw";
  }

  if (meaningful.includes("btts")) {
    const answer = meaningful[meaningful.length - 1];
    return answer.charAt(0).toUpperCase() + answer.slice(1);
  }

  if (meaningful.includes("dnb")) {
    const team = meaningful[meaningful.length - 1];
    return team.charAt(0).toUpperCase() + team.slice(1);
  }

  if (meaningful.includes("odd")) {
    return "Odd";
  }
  if (meaningful.includes("even")) {
    return "Even";
  }

  return meaningful
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}


export interface MarketOption {
  value: string;
  label: string;
}

const _cachedMarketOptions: MarketOption[] = (() => {
  const seen = new Set<string>();
  const families = atomsData.families as Record<
    string,
    { market_type: string }
  >;
  for (const fam of Object.values(families)) {
    seen.add(fam.market_type);
  }
  return Array.from(seen)
    .sort((a, b) => formatMarketType(a).localeCompare(formatMarketType(b)))
    .map((mt) => ({ value: mt, label: formatMarketType(mt) }));
})();

export function getMarketOptions(): MarketOption[] {
  return _cachedMarketOptions;
}
