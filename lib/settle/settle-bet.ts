/**
 * Pure, deterministic bet settlement.
 *
 * Given a ValueBetRow + a MatchScore, returns an Outcome without any I/O.
 * This is the engine that replaces per-bet Gemini calls once a score is
 * known — the AI tiers above only need to answer "what was the score?",
 * never "did this bet win?".
 *
 * Returns `null` for markets we don't yet settle deterministically; callers
 * should fall through to the AI tier for those rows rather than guessing.
 */

import type { ValueBetRow } from "@/lib/bets-history/types";
import type { Outcome } from "../bets-history/types";
import type { MatchScore, SettleResult } from "./types";

type Leg = "home" | "away";

interface ScopeScore {
  home: number;
  away: number;
}

/** Extract (home, away) goals for the requested scope from a full MatchScore. */
const scopeOf = (
  score: MatchScore,
  scope: "FT" | "1H" | "2H",
): ScopeScore | null => {
  if (scope === "FT") return { home: score.ftHome, away: score.ftAway };
  if (scope === "1H") {
    if (score.htHome == null || score.htAway == null) return null;
    return { home: score.htHome, away: score.htAway };
  }
  // 2H = FT - HT
  if (score.htHome == null || score.htAway == null) return null;
  return {
    home: score.ftHome - score.htHome,
    away: score.ftAway - score.htAway,
  };
};

const fmt = (s: ScopeScore): string => `${s.home}-${s.away}`;

// ─── Over / Under ────────────────────────────────────────────────────────────

/**
 * Settle a single OU leg at an integer or half line.
 * Integer line → push (void) on exact total; half line → strict win/loss.
 */
const settleOuLeg = (
  total: number,
  line: number,
  side: "over" | "under",
): "won" | "lost" | "void" => {
  if (total > line) return side === "over" ? "won" : "lost";
  if (total < line) return side === "over" ? "lost" : "won";
  return "void";
};

// ─── Asian Handicap ──────────────────────────────────────────────────────────

/**
 * Settle a single AH leg at an integer or half line for `backed` team with
 * handicap `line` (negative favors opponent).
 *  handicappedDiff = (backed - opponent) + line
 *   > 0 win,  = 0 push (integer lines only), < 0 loss.
 */
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

// ─── Quarter-line splitter ───────────────────────────────────────────────────

/**
 * Fold two leg verdicts (each of win/loss/void) into a bet-level Outcome.
 * Quarter lines split stake 50/50 across two adjacent whole/half lines,
 * so valid combinations are:
 *   both win → won
 *   both loss → lost
 *   win + push → half_won
 *   loss + push → half_lost
 * A split that yields one win and one loss is mathematically impossible
 * for quarter lines — if we see it, treat as void rather than silently
 * returning a wrong outcome.
 */
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

/** For an OU quarter line X.25, split to [X, X.5]. For X.75, split to [X.5, X+1]. */
const splitQuarterLine = (line: number): [number, number] => {
  const frac = +(line - Math.floor(line)).toFixed(2);
  if (Math.abs(frac - 0.25) < 1e-6)
    return [Math.floor(line), Math.floor(line) + 0.5];
  if (Math.abs(frac - 0.75) < 1e-6)
    return [Math.floor(line) + 0.5, Math.floor(line) + 1];
  // Not a quarter — caller shouldn't have called us; fall back to [line, line].
  return [line, line];
};

/** For an AH quarter line, same rule — but the sign is part of the line. */
const splitQuarterAhLine = (line: number): [number, number] => {
  const [a, b] = splitQuarterLine(Math.abs(line));
  return line < 0 ? [-a, -b] : [a, b];
};

const isQuarterLine = (line: number): boolean => {
  const frac = +(Math.abs(line) - Math.floor(Math.abs(line))).toFixed(2);
  return Math.abs(frac - 0.25) < 1e-6 || Math.abs(frac - 0.75) < 1e-6;
};

// ─── Atom-ID parsing ─────────────────────────────────────────────────────────
//
// Atoms look like:
//   {ft|1h|2h}_home_win | _draw | _away_win
//   {scope}_total_{over|under}_{line with _ for decimal}
//   {scope}_{home|away}_ah_{m|p}{line}
//   {scope}_btts_{yes|no}
//   {scope}_dnb_{home|away}
//   {scope}_dc_{1x|12|x2}
// We cross-check against marketType/familyLine to stay robust against
// whatever naming drift the JSON picks up later.

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

// ─── Terminal-state helpers ──────────────────────────────────────────────────

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

// ─── Main entry ──────────────────────────────────────────────────────────────

export function settleBet(row: ValueBetRow, score: MatchScore): SettleResult {
  // Hard-void states override all market logic.
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

  // ── MATCH_RESULT (1X2) ────────────────────────────────────────────────────
  if (row.marketType === "MATCH_RESULT") {
    const side = parseMatchResultSide(atomId);
    if (!side)
      return {
        outcome: "pending",
        scopeScore: fmt(scope),
        confidence: 0,
        reasoning: `Unrecognized MATCH_RESULT atom ${atomId}`,
        reason: "unknown-atom",
      };
    const realSide: Side =
      scope.home > scope.away
        ? "home"
        : scope.home < scope.away
          ? "away"
          : "draw";
    return {
      outcome: side === realSide ? "won" : "lost",
      scopeScore: fmt(scope),
      confidence: 1,
      reasoning: `1X2 ${side} vs result ${realSide} @ ${fmt(scope)}.`,
      reason: "resolved",
    };
  }

  // ── TOTAL_GOALS (OU) ──────────────────────────────────────────────────────
  if (row.marketType === "OVER_UNDER" || row.marketType === "TOTAL_GOALS") {
    const side = parseOverUnder(atomId);
    if (!side || row.familyLine == null)
      return {
        outcome: "pending",
        scopeScore: fmt(scope),
        confidence: 0,
        reasoning: `Unrecognized OU atom ${atomId} or missing line`,
        reason: "unknown-atom",
      };
    const line = row.familyLine;
    const total = scope.home + scope.away;
    if (isQuarterLine(line)) {
      const [a, b] = splitQuarterLine(line);
      const outcome = foldLegs(
        settleOuLeg(total, a, side),
        settleOuLeg(total, b, side),
      );
      return {
        outcome,
        scopeScore: fmt(scope),
        confidence: 1,
        reasoning: `OU ${side} ${line} split [${a}, ${b}] on total ${total}.`,
        reason: "resolved",
      };
    }
    const verdict = settleOuLeg(total, line, side);
    const mapped: Outcome =
      verdict === "won" ? "won" : verdict === "lost" ? "lost" : "void";
    return {
      outcome: mapped,
      scopeScore: fmt(scope),
      confidence: 1,
      reasoning: `OU ${side} ${line} on total ${total}.`,
      reason: "resolved",
    };
  }

  // ── ASIAN_HANDICAP ────────────────────────────────────────────────────────
  if (row.marketType === "ASIAN_HANDICAP") {
    const backed = parseAhBacked(atomId);
    if (!backed || row.familyLine == null)
      return {
        outcome: "pending",
        scopeScore: fmt(scope),
        confidence: 0,
        reasoning: `Unrecognized AH atom ${atomId} or missing line`,
        reason: "unknown-atom",
      };
    const line = row.familyLine;
    if (isQuarterLine(line)) {
      const [a, b] = splitQuarterAhLine(line);
      const outcome = foldLegs(
        settleAhLeg(scope, backed, a),
        settleAhLeg(scope, backed, b),
      );
      return {
        outcome,
        scopeScore: fmt(scope),
        confidence: 1,
        reasoning: `AH ${backed} ${line} split [${a}, ${b}] on ${fmt(scope)}.`,
        reason: "resolved",
      };
    }
    const verdict = settleAhLeg(scope, backed, line);
    const mapped: Outcome =
      verdict === "won" ? "won" : verdict === "lost" ? "lost" : "void";
    return {
      outcome: mapped,
      scopeScore: fmt(scope),
      confidence: 1,
      reasoning: `AH ${backed} ${line} on ${fmt(scope)}.`,
      reason: "resolved",
    };
  }

  // ── BTTS ──────────────────────────────────────────────────────────────────
  if (row.marketType === "BTTS") {
    const pick = parseBtts(atomId);
    if (!pick)
      return {
        outcome: "pending",
        scopeScore: fmt(scope),
        confidence: 0,
        reasoning: `Unrecognized BTTS atom ${atomId}`,
        reason: "unknown-atom",
      };
    const both = scope.home > 0 && scope.away > 0;
    const won = pick === "yes" ? both : !both;
    return {
      outcome: won ? "won" : "lost",
      scopeScore: fmt(scope),
      confidence: 1,
      reasoning: `BTTS ${pick} on ${fmt(scope)}.`,
      reason: "resolved",
    };
  }

  // ── DNB (Draw No Bet) — AH +0 for backed leg ──────────────────────────────
  if (row.marketType === "DNB") {
    const backed = parseDnbBacked(atomId);
    if (!backed)
      return {
        outcome: "pending",
        scopeScore: fmt(scope),
        confidence: 0,
        reasoning: `Unrecognized DNB atom ${atomId}`,
        reason: "unknown-atom",
      };
    const verdict = settleAhLeg(scope, backed, 0);
    const mapped: Outcome =
      verdict === "won" ? "won" : verdict === "lost" ? "lost" : "void";
    return {
      outcome: mapped,
      scopeScore: fmt(scope),
      confidence: 1,
      reasoning: `DNB ${backed} on ${fmt(scope)}.`,
      reason: "resolved",
    };
  }

  // ── HOME_TEAM_TOTAL / AWAY_TEAM_TOTAL ─────────────────────────────────────
  //
  // Per-team over/under. Atom IDs are `ft_home_{over|under}_X` or
  // `ft_away_{over|under}_X`. Line comes from `row.familyLine`. Only FT
  // scope exists for these in our atom tree.
  if (
    row.marketType === "HOME_TEAM_TOTAL" ||
    row.marketType === "AWAY_TEAM_TOTAL"
  ) {
    const side = parseOverUnder(atomId);
    if (!side || row.familyLine == null)
      return {
        outcome: "pending",
        scopeScore: fmt(scope),
        confidence: 0,
        reasoning: `Unrecognized team-total atom ${atomId} or missing line`,
        reason: "unknown-atom",
      };
    const teamGoals =
      row.marketType === "HOME_TEAM_TOTAL" ? scope.home : scope.away;
    const line = row.familyLine;
    if (isQuarterLine(line)) {
      const [a, b] = splitQuarterLine(line);
      const outcome = foldLegs(
        settleOuLeg(teamGoals, a, side),
        settleOuLeg(teamGoals, b, side),
      );
      return {
        outcome,
        scopeScore: fmt(scope),
        confidence: 1,
        reasoning: `${row.marketType} ${side} ${line} split on team goals ${teamGoals}.`,
        reason: "resolved",
      };
    }
    const verdict = settleOuLeg(teamGoals, line, side);
    const mapped: Outcome =
      verdict === "won" ? "won" : verdict === "lost" ? "lost" : "void";
    return {
      outcome: mapped,
      scopeScore: fmt(scope),
      confidence: 1,
      reasoning: `${row.marketType} ${side} ${line} on team goals ${teamGoals}.`,
      reason: "resolved",
    };
  }

  // ── DOUBLE_CHANCE ─────────────────────────────────────────────────────────
  if (row.marketType === "DOUBLE_CHANCE") {
    const combo = parseDcCombo(atomId);
    if (!combo)
      return {
        outcome: "pending",
        scopeScore: fmt(scope),
        confidence: 0,
        reasoning: `Unrecognized DC atom ${atomId}`,
        reason: "unknown-atom",
      };
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
    return {
      outcome: won ? "won" : "lost",
      scopeScore: fmt(scope),
      confidence: 1,
      reasoning: `DC ${combo} vs ${realSide} @ ${fmt(scope)}.`,
      reason: "resolved",
    };
  }

  // ── CORNERS / HOME_CORNERS_TOTAL / AWAY_CORNERS_TOTAL ────────────────────
  //
  // Corners only settle when the score source provided corner counts
  // (SofaScore /statistics endpoint). When the score lacks corners,
  // return pending-with-reason rather than guessing.
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
    if (!side || row.familyLine == null) {
      return {
        outcome: "pending",
        scopeScore: fmt(scope),
        confidence: 0,
        reasoning: `Unrecognized corners atom ${atomId} or missing line`,
        reason: "unknown-atom",
      };
    }
    const cornerTotal =
      row.marketType === "CORNERS"
        ? score.cornersHome + score.cornersAway
        : row.marketType === "HOME_CORNERS_TOTAL"
          ? score.cornersHome
          : score.cornersAway;
    const line = row.familyLine;
    const label = `${row.marketType} ${side} ${line} on corners ${score.cornersHome}-${score.cornersAway}`;
    if (isQuarterLine(line)) {
      const [a, b] = splitQuarterLine(line);
      return {
        outcome: foldLegs(
          settleOuLeg(cornerTotal, a, side),
          settleOuLeg(cornerTotal, b, side),
        ),
        scopeScore: fmt(scope),
        confidence: 1,
        reasoning: `${label} split [${a}, ${b}]`,
        reason: "resolved",
      };
    }
    const verdict = settleOuLeg(cornerTotal, line, side);
    const mapped: Outcome =
      verdict === "won" ? "won" : verdict === "lost" ? "lost" : "void";
    return {
      outcome: mapped,
      scopeScore: fmt(scope),
      confidence: 1,
      reasoning: label,
      reason: "resolved",
    };
  }

  // Unsupported (yet): cards, bookings, odd/even, clean-sheet,
  // win-to-nil, to-score, European handicap.
  return unsupported(
    `Market ${row.marketType} not yet settled deterministically — falling through to AI tier.`,
  );
}
