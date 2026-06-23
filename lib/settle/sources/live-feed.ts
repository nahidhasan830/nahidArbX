
import {
  getMultiSourceScore,
  getMultiSourceDisplayScore,
} from "../../scores/multi-source-store";
import type { MatchScore, ScoreSource } from "../types";

const TERMINAL_PERIODS = new Set([
  "FT",
  "AET",
  "PEN",
  "ENDED",
  "FINISHED",
  "FULL TIME",
  "FULL-TIME",
]);

const isTerminal = (period: string | undefined): boolean => {
  if (!period) return false;
  return TERMINAL_PERIODS.has(period.toUpperCase().trim());
};

export const readLiveFeedScore = (eventId: string): MatchScore | null => {
  const entry = getMultiSourceScore(eventId);
  if (!entry || !entry.primary) return null;
  const display = getMultiSourceDisplayScore(eventId);
  if (!display) return null;
  if (!isTerminal(display.period)) return null;

  const primarySource = entry.primary.source;
  const source: ScoreSource =
    primarySource === "pinnacle" ? "pinnacle-ws" : "betconstruct";

  const agreed =
    entry.sources.pinnacle &&
    entry.sources.betconstruct &&
    !entry.hasDiscrepancy;
  const confidence = agreed ? 0.98 : 0.85;

  const htHome =
    entry.primary.htHome ??
    entry.sources.pinnacle?.htHome ??
    entry.sources.betconstruct?.htHome ??
    null;
  const htAway =
    entry.primary.htAway ??
    entry.sources.pinnacle?.htAway ??
    entry.sources.betconstruct?.htAway ??
    null;

  return {
    eventId,
    status: display.period.toUpperCase().startsWith("AET")
      ? "AET"
      : display.period.toUpperCase().startsWith("PEN")
        ? "PEN"
        : "FT",
    htHome,
    htAway,
    ftHome: display.home,
    ftAway: display.away,
    source,
    confidence,
  };
};
