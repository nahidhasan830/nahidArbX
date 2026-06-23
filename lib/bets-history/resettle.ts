
import type { ValueBetRow, TimeScope } from "./types";

const SCOPE_READY_MS: Record<TimeScope, number> = {
  "1H": 55 * 60 * 1000,
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

  if (now < kickoff) {
    return {
      allowed: false,
      reason: "kickoff-not-reached",
      message: "Match hasn't started yet.",
    };
  }

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
    default:
      return source;
  }
}
