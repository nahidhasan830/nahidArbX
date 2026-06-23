
import { getFamilyIdByAtom } from "../registry";
import { formatLine } from "../../formatting/lines";
import type { NormalizedOddsEntry, ProviderKey } from "../types";
import type { BCMarket, BCEvent } from "../../adapters/betconstruct/client";


const MATCH_RESULT_ATOMS: Record<string, string> = {
  W1: "ft_home_win",
  X: "ft_draw",
  W2: "ft_away_win",
};


const HALF_TIME_RESULT_ATOMS: Record<string, string> = {
  W1: "1h_home_win",
  X: "1h_draw",
  W2: "1h_away_win",
};


const SECOND_HALF_RESULT_ATOMS: Record<string, string> = {
  W1: "2h_home_win",
  X: "2h_draw",
  W2: "2h_away_win",
};


const SUPPORTED_FT_TOTAL_LINES = [
  0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0, 3.25, 3.5, 3.75,
  4.0, 4.25, 4.5, 4.75, 5.0, 5.25, 5.5, 5.75, 6.0, 6.25, 6.5, 6.75, 7.0, 7.25,
  7.5, 7.75, 8.0, 8.25, 8.5,
];

const SUPPORTED_HALF_TOTAL_LINES = [
  0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0, 3.25, 3.5,
];

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


const SUPPORTED_TEAM_TOTAL_LINES = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5];

function getTeamTotalsAtom(
  base: number,
  direction: "over" | "under",
  team: "home" | "away",
): string | null {
  if (!SUPPORTED_TEAM_TOTAL_LINES.includes(base)) return null;
  const line = formatLine(base);
  return `ft_${team}_${direction}_${line}`;
}


const BTTS_ATOMS: Record<string, string> = {
  Yes: "ft_btts_yes",
  No: "ft_btts_no",
};

const BTTS_1H_ATOMS: Record<string, string> = {
  Yes: "1h_btts_yes",
  No: "1h_btts_no",
};


const SUPPORTED_FT_AH_LINES = [
  -4.5, -4.25, -4, -3.75, -3.5, -3.25, -3, -2.75, -2.5, -2.25, -2, -1.75, -1.5,
  -1.25, -1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2,
  2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4, 4.25, 4.5,
];

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
  const sign = base >= 0 ? "p" : "m";
  const team = isHome ? "home" : "away";

  return `${scope}_${team}_ah_${sign}${line}`;
}


const DNB_ATOMS: Record<string, string> = {
  W1: "ft_dnb_home",
  Home: "ft_dnb_home",
  W2: "ft_dnb_away",
  Away: "ft_dnb_away",
};


const DOUBLE_CHANCE_ATOMS: Record<string, string> = {
  "1X": "ft_dc_1x",
  "12": "ft_dc_12",
  X2: "ft_dc_x2",
};


const SUPPORTED_FT_CORNERS_LINES = [
  5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13,
  13.5,
];

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


const SUPPORTED_CORNERS_AH_LINES = [
  -8.5, -8, -7.5, -7, -6.5, -6, -5.5, -5, -4.5, -4, -3.5, -3, -2.5, -2, -1.5,
  -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8,
  8.5,
];

function getCornersHandicapAtom(base: number, isHome: boolean): string | null {
  if (!SUPPORTED_CORNERS_AH_LINES.includes(base)) return null;

  const absLine = Math.abs(base);
  const line = formatLine(absLine);
  const sign = base >= 0 ? "p" : "m";
  const team = isHome ? "home" : "away";

  return `ft_corners_${team}_ah_${sign}${line}`;
}


const SUPPORTED_TEAM_CORNERS_LINES = [
  1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5,
];

function getCornersTeamTotalAtom(
  base: number,
  direction: "over" | "under",
  isHome: boolean,
  scope: "ft" | "1h" = "ft",
): string | null {
  if (!SUPPORTED_TEAM_CORNERS_LINES.includes(base)) return null;
  const line = formatLine(base);
  const team = isHome ? "home" : "away";
  return `${scope}_${team}_corners_${direction}_${line}`;
}


export function mapBetConstructToAtom(
  marketType: string,
  selectionType: string,
  selectionName: string,
  base?: number,
  displayKey?: string,
): string | null {
  switch (marketType) {

    case "P1XP2": {
      if (displayKey && displayKey !== "WINNER") return null;
      return MATCH_RESULT_ATOMS[selectionType] || null;
    }

    case "HalfTimeResult": {
      return HALF_TIME_RESULT_ATOMS[selectionType] || null;
    }

    case "SecondHalfResult": {
      return SECOND_HALF_RESULT_ATOMS[selectionType] || null;
    }


    case "OverUnder": {
      if (base === undefined) return null;
      const direction = getOverUnderDirection(selectionType, selectionName);
      if (!direction) return null;
      return getTotalsAtom(base, direction, "ft");
    }

    case "HalfTimeOverUnder": {
      if (base === undefined) return null;
      const direction = getOverUnderDirection(selectionType, selectionName);
      if (!direction) return null;
      return getTotalsAtom(base, direction, "1h");
    }

    case "2ndHalfTotalOver/Under": {
      if (base === undefined) return null;
      const direction = getOverUnderDirection(selectionType, selectionName);
      if (!direction) return null;
      return getTotalsAtom(base, direction, "2h");
    }


    case "Team1OverUnder": {
      if (base === undefined) return null;
      const direction = getOverUnderDirection(selectionType, selectionName);
      if (!direction) return null;
      return getTeamTotalsAtom(base, direction, "home");
    }

    case "Team2OverUnder": {
      if (base === undefined) return null;
      const direction = getOverUnderDirection(selectionType, selectionName);
      if (!direction) return null;
      return getTeamTotalsAtom(base, direction, "away");
    }


    case "BothTeamsToScore": {
      return BTTS_ATOMS[selectionName] || BTTS_ATOMS[selectionType] || null;
    }

    case "1stHalfBothTeamsToScore": {
      return (
        BTTS_1H_ATOMS[selectionName] || BTTS_1H_ATOMS[selectionType] || null
      );
    }


    case "AsianHandicap": {
      if (base === undefined) return null;
      const isHome = isHomeSelection(selectionType, selectionName);
      const isAway = isAwaySelection(selectionType, selectionName);

      if (isHome) return getAsianHandicapAtom(base, true, "ft");
      if (isAway) return getAsianHandicapAtom(base, false, "ft");
      return null;
    }

    case "HalfTimeAsianHandicap": {
      if (base === undefined) return null;
      const isHome = isHomeSelection(selectionType, selectionName);
      const isAway = isAwaySelection(selectionType, selectionName);

      if (isHome) return getAsianHandicapAtom(base, true, "1h");
      if (isAway) return getAsianHandicapAtom(base, false, "1h");
      return null;
    }


    case "DrawNoBet": {
      return DNB_ATOMS[selectionType] || DNB_ATOMS[selectionName] || null;
    }

    case "1X12X2": {
      return (
        DOUBLE_CHANCE_ATOMS[selectionType] ||
        DOUBLE_CHANCE_ATOMS[selectionName] ||
        null
      );
    }


    case "CornersTotalHome": {
      if (base === undefined || !displayKey) return null;
      const direction = getOverUnderDirection(selectionType, selectionName);
      if (!direction) return null;
      if (displayKey.includes("1ST HALF")) {
        return getCornersTeamTotalAtom(base, direction, true, "1h");
      }
      return getCornersTeamTotalAtom(base, direction, true, "ft");
    }

    case "CornersTotalAway": {
      if (base === undefined || !displayKey) return null;
      const direction = getOverUnderDirection(selectionType, selectionName);
      if (!direction) return null;
      if (displayKey.includes("1ST HALF")) {
        return getCornersTeamTotalAtom(base, direction, false, "1h");
      }
      return getCornersTeamTotalAtom(base, direction, false, "ft");
    }

    case "CornersOverUnder": {
      if (base === undefined) return null;
      const direction = getOverUnderDirection(selectionType, selectionName);
      if (!direction) return null;
      return getCornersAtom(base, direction, "ft");
    }

    case "1stHalfCornersOver/Under": {
      if (base === undefined) return null;
      const direction = getOverUnderDirection(selectionType, selectionName);
      if (!direction) return null;
      return getCornersAtom(base, direction, "1h");
    }

    case "CornerHandicap": {
      if (base === undefined) return null;
      const isHome = isHomeSelection(selectionType, selectionName);
      const isAway = isAwaySelection(selectionType, selectionName);

      if (isHome) return getCornersHandicapAtom(base, true);
      if (isAway) return getCornersHandicapAtom(base, false);
      return null;
    }

    default:
      return null;
  }
}


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

    if (!event.price || event.price <= 1) continue;

    const atomId = mapBetConstructToAtom(
      market.type,
      event.type_1,
      event.name,
      event.base ?? market.base, // Prefer event.base for handicap markets
      market.display_key,
    );

    if (!atomId) continue;

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


const SUPPORTED_MARKET_TYPES = [
  "P1XP2",
  "HalfTimeResult",
  "SecondHalfResult",
  "OverUnder",
  "HalfTimeOverUnder",
  "2ndHalfTotalOver/Under",
  "Team1OverUnder",
  "Team2OverUnder",
  "BothTeamsToScore",
  "1stHalfBothTeamsToScore",
  "AsianHandicap",
  "HalfTimeAsianHandicap",
  "DrawNoBet",
  "1X12X2",
  "CornersOverUnder",
  "1stHalfCornersOver/Under",
  "CornerHandicap",
];

export function isSupportedMarketType(marketType: string): boolean {
  return SUPPORTED_MARKET_TYPES.includes(marketType);
}

export function getMarketFamily(
  marketType: string,
  base?: number,
): string | null {
  switch (marketType) {
    case "P1XP2":
      return "ft_match_result";
    case "HalfTimeResult":
      return "1h_match_result";
    case "SecondHalfResult":
      return "2h_match_result";

    case "OverUnder":
      if (base === undefined) return null;
      return `ft_total_${formatLine(base)}`;
    case "HalfTimeOverUnder":
      if (base === undefined) return null;
      return `1h_total_${formatLine(base)}`;
    case "2ndHalfTotalOver/Under":
      if (base === undefined) return null;
      return `2h_total_${formatLine(base)}`;

    case "Team1OverUnder":
      if (base === undefined) return null;
      return `ft_home_total_${formatLine(base)}`;
    case "Team2OverUnder":
      if (base === undefined) return null;
      return `ft_away_total_${formatLine(base)}`;

    case "BothTeamsToScore":
      return "ft_btts";
    case "1stHalfBothTeamsToScore":
      return "1h_btts";

    case "AsianHandicap":
      if (base === undefined) return null;
      return `ft_ah_${base >= 0 ? "p" : "m"}${formatLine(Math.abs(base))}`;
    case "HalfTimeAsianHandicap":
      if (base === undefined) return null;
      return `1h_ah_${base >= 0 ? "p" : "m"}${formatLine(Math.abs(base))}`;

    case "DrawNoBet":
      return "ft_dnb";
    case "1X12X2":
      return "ft_double_chance";

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
