/**
 * Helpers for the "Re-settle" UI action.
 *
 * Re-settle re-runs the deterministic waterfall on a row (with
 * `bypassCache: true`) so a row can be forced through the default
 * pipeline again — regardless of current outcome. Useful for:
 *   - bets whose score source later became available / corrected
 *   - bets mis-settled by a cached score we since improved
 *   - routine sanity checks
 *
 * The guard below is the UI-side safety net: never re-settle a match
 * that is still live unless the market targets a scope that has
 * already concluded (1H markets become resolvable at half-time).
 */

import type { ValueBetRow, TimeScope } from "./types";

/**
 * Seconds-of-buffer to add to the theoretical end of a scope before we
 * treat it as "resolvable". Matches should rarely exceed the buffer
 * even with extended stoppage time; re-settle is idempotent so a
 * later tick would fix an accidentally-early call anyway.
 */
const SCOPE_READY_MS: Record<TimeScope, number> = {
  // First half is ~45' + up to ~5' stoppage + ~15' HT break ≈ 60–65'
  // after kickoff. Use 55' as a conservative "first half is over".
  "1H": 55 * 60 * 1000,
  // Second half alone finishes with the match, so we just use the
  // full-match threshold.
  "2H": 2 * 60 * 60 * 1000 + 15 * 60 * 1000,
  FT: 2 * 60 * 60 * 1000 + 15 * 60 * 1000,
};

export type ResettleGateReason =
  | "ok"
  | "kickoff-not-reached"
  | "match-still-live";

export interface ResettleGate {
  allowed: boolean;
  reason: ResettleGateReason;
  message: string;
}

export function canResettle(
  row: Pick<ValueBetRow, "timeScope" | "eventStartTime" | "outcome">,
  now: number = Date.now(),
): ResettleGate {
  const kickoff = new Date(row.eventStartTime).getTime();

  // If the match hasn't started yet, re-settle is pointless and would
  // just burn a pipeline tick.
  if (now < kickoff) {
    return {
      allowed: false,
      reason: "kickoff-not-reached",
      message: "Match hasn't started yet.",
    };
  }

  // Once a bet is settled, the match is definitionally finished for
  // that bet's scope — re-settle is safe (it's just a verification).
  if (row.outcome !== "pending") {
    return {
      allowed: true,
      reason: "ok",
      message: "Verify already-settled bet.",
    };
  }

  const buffer =
    SCOPE_READY_MS[row.timeScope as TimeScope] ?? SCOPE_READY_MS.FT;
  if (now - kickoff < buffer) {
    const isHalf = row.timeScope === "1H";
    return {
      allowed: false,
      reason: "match-still-live",
      message: isHalf
        ? "First half not finished yet — try after half-time."
        : "Match is still live — wait until full time.",
    };
  }

  return { allowed: true, reason: "ok", message: "Safe to re-settle." };
}

/** Short label for the "Settled by" column (source from waterfall tier). */
export function prettySettledBy(source: string | null): string {
  if (!source) return "—";
  switch (source) {
    case "manual":
      return "Manual";
    case "espn":
      return "ESPN";
    case "api-football":
      return "API-Football";
    case "sofascore":
      return "SofaScore";
    case "pinnacle-ws":
      return "Pinnacle";
    case "betconstruct":
      return "BetConstruct";
    case "football-data":
      return "football-data";
    case "ai-search-hf":
      return "HF+Search";
    case "ai-search-groq":
      return "Groq+Search";
    case "url-context":
    case "gemini-batch":
    case "legacy-ai":
      return "AI (legacy)";
    default:
      return source;
  }
}
