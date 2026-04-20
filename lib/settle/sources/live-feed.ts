/**
 * Tier 1: read final scores straight from the in-memory live-score store
 * (Pinnacle WS + BC poller). Free — we're already paying for the feed.
 *
 * Only returns a result when the store shows a terminal state (FT/AET/PEN).
 * In-progress matches are deliberately filtered out: we don't want a 70'
 * scoreline to leak into settlement.
 */

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

/**
 * Extract a terminal-state score for one eventId, or null if the match
 * isn't finished (or isn't tracked by the live feeds at all).
 */
export const readLiveFeedScore = (eventId: string): MatchScore | null => {
  const entry = getMultiSourceScore(eventId);
  if (!entry || !entry.primary) return null;
  const display = getMultiSourceDisplayScore(eventId);
  if (!display) return null;
  if (!isTerminal(display.period)) return null;

  const primarySource = entry.primary.source;
  const source: ScoreSource =
    primarySource === "pinnacle" ? "pinnacle-ws" : "betconstruct";

  // Confidence: both feeds agreed → 0.98; one source only → 0.85.
  const agreed =
    entry.sources.pinnacle &&
    entry.sources.betconstruct &&
    !entry.hasDiscrepancy;
  const confidence = agreed ? 0.98 : 0.85;

  // Pinnacle's WS has no explicit HT field, but we snapshot the last
  // state=1 score when the match transitions into 2H — see
  // `lib/scores/store.ts::setLiveScore`. Fall back to whatever source
  // carries HT (pinnacle or betconstruct); if neither saw the first
  // half, return null and let the next tier fill it in.
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
