
import type { ValueBetRow } from "@/lib/bets-history/types";
import type { Outcome } from "../bets-history/types";
import type { MatchScore, SettleResult } from "./types";

type Leg = "home" | "away";

interface ScopeScore {
  home: number;
  away: number;
}

const scopeOf = (
  score: MatchScore,
  scope: "FT" | "1H" | "2H",
): ScopeScore | null => {
  if (scope === "FT") return { home: score.ftHome, away: score.ftAway };
  if (scope === "1H") {
    if (score.htHome == null || score.htAway == null) return null;
    return { home: score.htHome, away: score.htAway };
  }
  if (score.htHome == null || score.htAway == null) return null;
  return {
    home: score.ftHome - score.htHome,
    away: score.ftAway - score.htAway,
  };
};

const fmt = (s: ScopeScore): string => `${s.home}-${s.away}`;


const settleOuLeg = (
  total: number,
  line: number,
  side: "over" | "under",
): "won" | "lost" | "void" => {
  if (total > line) return side === "over" ? "won" : "lost";
  if (total < line) return side === "over" ? "lost" : "won";
  return "void";
};


const settleAhLeg = (
  score: ScopeScore,
  backed: Leg,
  line: number,
): "won" | "lost" | "void" => {
  const diff =
    backed === "home"
      ? score.home - score.away + line
      : score.away - score.home + line;
  if (diff > 0) return "won";
  if (diff < 0) return "lost";
  return "void";
};


const foldLegs = (
  a: "won" | "lost" | "void",
  b: "won" | "lost" | "void",
): Outcome => {
  if (a === "won" && b === "won") return "won";
  if (a === "lost" && b === "lost") return "lost";
  if ((a === "won" && b === "void") || (a === "void" && b === "won"))
    return "half_won";
  if ((a === "lost" && b === "void") || (a === "void" && b === "lost"))
    return "half_lost";
  if (a === "void" && b === "void") return "void";
  return "void";
};

const splitQuarterLine = (line: number): [number, number] => {
  const frac = +(line - Math.floor(line)).toFixed(2);
  if (Math.abs(frac - 0.25) < 1e-6)
    return [Math.floor(line), Math.floor(line) + 0.5];
  if (Math.abs(frac - 0.75) < 1e-6)
    return [Math.floor(line) + 0.5, Math.floor(line) + 1];
  return [line, line];
};

const splitQuarterAhLine = (line: number): [number, number] => {
  const [a, b] = splitQuarterLine(Math.abs(line));
  return line < 0 ? [-a, -b] : [a, b];
};

const isQuarterLine = (line: number): boolean => {
  const frac = +(Math.abs(line) - Math.floor(Math.abs(line))).toFixed(2);
  return Math.abs(frac - 0.25) < 1e-6 || Math.abs(frac - 0.75) < 1e-6;
};


type Side = "home" | "away" | "draw";

const parseOverUnder = (atomId: string): "over" | "under" | null => {
  if (atomId.includes("_over_") || atomId.endsWith("_over")) return "over";
  if (atomId.includes("_under_") || atomId.endsWith("_under")) return "under";
  return null;
};

const parseMatchResultSide = (atomId: string): Side | null => {
  if (atomId.endsWith("_home_win")) return "home";
  if (atomId.endsWith("_away_win")) return "away";
  if (atomId.endsWith("_draw")) return "draw";
  return null;
};

const parseAhBacked = (atomId: string): Leg | null => {
  if (atomId.includes("_home_ah_")) return "home";
  if (atomId.includes("_away_ah_")) return "away";
  return null;
};

const parseDnbBacked = (atomId: string): Leg | null => {
  if (atomId.endsWith("_dnb_home")) return "home";
  if (atomId.endsWith("_dnb_away")) return "away";
  return null;
};

type DcCombo = "1x" | "12" | "x2";
const parseDcCombo = (atomId: string): DcCombo | null => {
  if (atomId.endsWith("_dc_1x")) return "1x";
  if (atomId.endsWith("_dc_12")) return "12";
  if (atomId.endsWith("_dc_x2")) return "x2";
  return null;
};

const parseBtts = (atomId: string): "yes" | "no" | null => {
  if (atomId.endsWith("_btts_yes")) return "yes";
  if (atomId.endsWith("_btts_no")) return "no";
  return null;
};

const parseEhSide = (atomId: string): Side | null => {
  if (atomId.includes("_home_eh_")) return "home";
  if (atomId.includes("_away_eh_")) return "away";
  if (atomId.includes("_draw_eh_")) return "draw";
  return parseMatchResultSide(atomId);
};


const voidResult = (
  scope: ScopeScore | null,
  reason: SettleResult["reason"],
  note: string,
): SettleResult => ({
  outcome: "void",
  scopeScore: scope ? fmt(scope) : "",
  confidence: 1,
  reasoning: note,
  reason,
});

const unsupported = (note: string): SettleResult => ({
  outcome: "pending",
  scopeScore: "",
  confidence: 0,
  reasoning: note,
  reason: "unsupported-market",
});

const unknownAtom = (
  market: string,
  atomId: string,
  scope: ScopeScore,
): SettleResult => ({
  outcome: "pending",
  scopeScore: fmt(scope),
  confidence: 0,
  reasoning: `Unrecognized ${market} atom ${atomId}`,
  reason: "unknown-atom",
});

const missingLine = (
  market: string,
  atomId: string,
  scope: ScopeScore,
): SettleResult => ({
  outcome: "pending",
  scopeScore: fmt(scope),
  confidence: 0,
  reasoning: `Unrecognized ${market} atom ${atomId} or missing line`,
  reason: "unknown-atom",
});

const resolved = (
  outcome: Outcome,
  scope: ScopeScore,
  reasoning: string,
): SettleResult => ({
  outcome,
  scopeScore: fmt(scope),
  confidence: 1,
  reasoning,
  reason: "resolved",
});


const settleOverUnder = (
  total: number,
  line: number,
  side: "over" | "under",
): Outcome => {
  if (isQuarterLine(line)) {
    const [a, b] = splitQuarterLine(line);
    return foldLegs(settleOuLeg(total, a, side), settleOuLeg(total, b, side));
  }
  const v = settleOuLeg(total, line, side);
  return v === "won" ? "won" : v === "lost" ? "lost" : "void";
};

const settleHandicap = (
  scope: ScopeScore,
  backed: Leg,
  line: number,
): Outcome => {
  const backedLine = backed === "home" ? line : -line;
  if (isQuarterLine(backedLine)) {
    const [a, b] = splitQuarterAhLine(backedLine);
    return foldLegs(
      settleAhLeg(scope, backed, a),
      settleAhLeg(scope, backed, b),
    );
  }
  const v = settleAhLeg(scope, backed, backedLine);
  return v === "won" ? "won" : v === "lost" ? "lost" : "void";
};

const settleMatchResult = (
  scope: ScopeScore,
  picked: Side,
  handicapHome = 0,
): Outcome => {
  const adjHome = scope.home + handicapHome;
  const adjAway = scope.away;
  const realSide: Side =
    adjHome > adjAway ? "home" : adjHome < adjAway ? "away" : "draw";
  return picked === realSide ? "won" : "lost";
};


export function settleBet(row: ValueBetRow, score: MatchScore): SettleResult {
  if (score.status === "ABD")
    return voidResult(null, "abandoned", "Match abandoned — stake returned.");
  if (score.status === "POSTPONED")
    return voidResult(null, "postponed", "Match postponed — stake voided.");

  const scopeKey = row.timeScope as "FT" | "1H" | "2H";
  const scope = scopeOf(score, scopeKey);
  if (!scope) {
    return {
      outcome: "pending",
      scopeScore: "",
      confidence: 0,
      reasoning: `HT score missing — cannot settle ${scopeKey} scope deterministically.`,
      reason: "missing-ht-score",
    };
  }

  const atomId = (row.atomId ?? "").toLowerCase();

  if (row.marketType === "MATCH_RESULT") {
    const side = parseMatchResultSide(atomId);
    if (!side) return unknownAtom("MATCH_RESULT", atomId, scope);
    const outcome = settleMatchResult(scope, side);
    const realSide: Side =
      scope.home > scope.away
        ? "home"
        : scope.home < scope.away
          ? "away"
          : "draw";
    return resolved(
      outcome,
      scope,
      `1X2 ${side} vs result ${realSide} @ ${fmt(scope)}.`,
    );
  }

  if (row.marketType === "OVER_UNDER" || row.marketType === "TOTAL_GOALS") {
    const side = parseOverUnder(atomId);
    if (!side || row.familyLine == null)
      return missingLine("OU", atomId, scope);
    const total = scope.home + scope.away;
    const outcome = settleOverUnder(total, row.familyLine, side);
    return resolved(
      outcome,
      scope,
      `OU ${side} ${row.familyLine} on total ${total}.`,
    );
  }

  if (row.marketType === "ASIAN_HANDICAP") {
    const backed = parseAhBacked(atomId);
    if (!backed || row.familyLine == null)
      return missingLine("AH", atomId, scope);
    const outcome = settleHandicap(scope, backed, row.familyLine);
    return resolved(
      outcome,
      scope,
      `AH ${backed} ${row.familyLine} on ${fmt(scope)}.`,
    );
  }

  if (row.marketType === "BTTS") {
    const pick = parseBtts(atomId);
    if (!pick) return unknownAtom("BTTS", atomId, scope);
    const both = scope.home > 0 && scope.away > 0;
    const won = pick === "yes" ? both : !both;
    return resolved(
      won ? "won" : "lost",
      scope,
      `BTTS ${pick} on ${fmt(scope)}.`,
    );
  }

  if (row.marketType === "DNB") {
    const backed = parseDnbBacked(atomId);
    if (!backed) return unknownAtom("DNB", atomId, scope);
    const outcome = settleHandicap(scope, backed, 0);
    return resolved(outcome, scope, `DNB ${backed} on ${fmt(scope)}.`);
  }

  if (
    row.marketType === "HOME_TEAM_TOTAL" ||
    row.marketType === "AWAY_TEAM_TOTAL"
  ) {
    const side = parseOverUnder(atomId);
    if (!side || row.familyLine == null)
      return missingLine("team-total", atomId, scope);
    const teamGoals =
      row.marketType === "HOME_TEAM_TOTAL" ? scope.home : scope.away;
    const outcome = settleOverUnder(teamGoals, row.familyLine, side);
    return resolved(
      outcome,
      scope,
      `${row.marketType} ${side} ${row.familyLine} on team goals ${teamGoals}.`,
    );
  }

  if (row.marketType === "DOUBLE_CHANCE") {
    const combo = parseDcCombo(atomId);
    if (!combo) return unknownAtom("DC", atomId, scope);
    const realSide: Side =
      scope.home > scope.away
        ? "home"
        : scope.home < scope.away
          ? "away"
          : "draw";
    const won =
      (combo === "1x" && (realSide === "home" || realSide === "draw")) ||
      (combo === "12" && (realSide === "home" || realSide === "away")) ||
      (combo === "x2" && (realSide === "away" || realSide === "draw"));
    return resolved(
      won ? "won" : "lost",
      scope,
      `DC ${combo} vs ${realSide} @ ${fmt(scope)}.`,
    );
  }

  if (row.marketType === "EUROPEAN_HANDICAP") {
    const side = parseEhSide(atomId);
    if (!side || row.familyLine == null)
      return missingLine("EUROPEAN_HANDICAP", atomId, scope);
    const outcome = settleMatchResult(scope, side, row.familyLine);
    return resolved(
      outcome,
      scope,
      `EH ${side} (handicap ${row.familyLine}) on ${fmt(scope)}.`,
    );
  }

  if (
    row.marketType === "CORNERS" ||
    row.marketType === "HOME_CORNERS_TOTAL" ||
    row.marketType === "AWAY_CORNERS_TOTAL"
  ) {
    if (score.cornersHome == null || score.cornersAway == null) {
      return {
        outcome: "pending",
        scopeScore: fmt(scope),
        confidence: 0,
        reasoning: `Corners not fetched for this match.`,
        reason: "missing-ht-score",
      };
    }
    if (row.timeScope !== "FT") {
      return unsupported(
        `Only FT corners are supported (${row.timeScope} scope requested).`,
      );
    }
    const side = parseOverUnder(atomId);
    if (!side || row.familyLine == null)
      return missingLine("corners", atomId, scope);
    const cornerTotal =
      row.marketType === "CORNERS"
        ? score.cornersHome + score.cornersAway
        : row.marketType === "HOME_CORNERS_TOTAL"
          ? score.cornersHome
          : score.cornersAway;
    const outcome = settleOverUnder(cornerTotal, row.familyLine, side);
    const label = `${row.marketType} ${side} ${row.familyLine} on corners ${score.cornersHome}-${score.cornersAway}`;
    return resolved(outcome, scope, label);
  }

  if (row.marketType === "CORNERS_HANDICAP") {
    if (score.cornersHome == null || score.cornersAway == null) {
      return {
        outcome: "pending",
        scopeScore: fmt(scope),
        confidence: 0,
        reasoning: `Corners not fetched for this match.`,
        reason: "missing-ht-score",
      };
    }
    if (row.timeScope !== "FT") {
      return unsupported(
        `Only FT corners handicap is supported (${row.timeScope} scope requested).`,
      );
    }
    const backed = parseAhBacked(atomId);
    if (!backed || row.familyLine == null)
      return missingLine("CORNERS_HANDICAP", atomId, scope);
    const cornerScope: ScopeScore = {
      home: score.cornersHome,
      away: score.cornersAway,
    };
    const outcome = settleHandicap(cornerScope, backed, row.familyLine);
    return resolved(
      outcome,
      scope,
      `CORNERS_HANDICAP ${backed} ${row.familyLine} on corners ${score.cornersHome}-${score.cornersAway}.`,
    );
  }

  if (row.marketType === "CORNERS_EUROPEAN_HANDICAP") {
    if (score.cornersHome == null || score.cornersAway == null) {
      return {
        outcome: "pending",
        scopeScore: fmt(scope),
        confidence: 0,
        reasoning: `Corners not fetched for this match.`,
        reason: "missing-ht-score",
      };
    }
    if (row.timeScope !== "FT") {
      return unsupported(
        `Only FT corners European handicap is supported (${row.timeScope} scope requested).`,
      );
    }
    const side = parseEhSide(atomId);
    if (!side || row.familyLine == null)
      return missingLine("CORNERS_EUROPEAN_HANDICAP", atomId, scope);
    const cornerScope: ScopeScore = {
      home: score.cornersHome,
      away: score.cornersAway,
    };
    const outcome = settleMatchResult(cornerScope, side, row.familyLine);
    return resolved(
      outcome,
      scope,
      `CORNERS_EH ${side} (handicap ${row.familyLine}) on corners ${score.cornersHome}-${score.cornersAway}.`,
    );
  }

  if (row.marketType === "BOOKINGS") {
    if (score.bookingsHome == null || score.bookingsAway == null) {
      return {
        outcome: "pending",
        scopeScore: fmt(scope),
        confidence: 0,
        reasoning: `Bookings (card counts) not fetched for this match.`,
        reason: "missing-ht-score",
      };
    }
    if (row.timeScope !== "FT") {
      return unsupported(
        `Only FT bookings are supported (${row.timeScope} scope requested).`,
      );
    }
    const side = parseOverUnder(atomId);
    if (!side || row.familyLine == null)
      return missingLine("bookings", atomId, scope);
    const bookingTotal = score.bookingsHome + score.bookingsAway;
    const outcome = settleOverUnder(bookingTotal, row.familyLine, side);
    const label = `BOOKINGS ${side} ${row.familyLine} on booking points ${score.bookingsHome}-${score.bookingsAway} (total ${bookingTotal})`;
    return resolved(outcome, scope, label);
  }

  if (row.marketType === "BOOKINGS_HANDICAP") {
    if (score.bookingsHome == null || score.bookingsAway == null) {
      return {
        outcome: "pending",
        scopeScore: fmt(scope),
        confidence: 0,
        reasoning: `Bookings (card counts) not fetched for this match.`,
        reason: "missing-ht-score",
      };
    }
    if (row.timeScope !== "FT") {
      return unsupported(
        `Only FT bookings handicap is supported (${row.timeScope} scope requested).`,
      );
    }
    const backed = parseAhBacked(atomId);
    if (!backed || row.familyLine == null)
      return missingLine("BOOKINGS_HANDICAP", atomId, scope);
    const bookingScope: ScopeScore = {
      home: score.bookingsHome,
      away: score.bookingsAway,
    };
    const outcome = settleHandicap(bookingScope, backed, row.familyLine);
    return resolved(
      outcome,
      scope,
      `BOOKINGS_HANDICAP ${backed} ${row.familyLine} on booking pts ${score.bookingsHome}-${score.bookingsAway}.`,
    );
  }

  return unsupported(
    `Market ${row.marketType} not yet settled deterministically — manual review required.`,
  );
}
