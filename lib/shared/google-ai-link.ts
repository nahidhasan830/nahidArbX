/**
 * Build a Google AI Mode search URL for grading a specific bet.
 *
 * Uses `udm=50` (AI Mode) + `aep=1` so the grounded answer renders
 * directly. The generated prompt includes the match, market, and
 * scoring rules so the model returns a deterministic one-of-N outcome
 * label at the end — used by the settlement tier 4 learner, the /value
 * bets modal, Telegram notifications, etc.
 *
 * This is the single source of truth for the grade URL across the app.
 * Callers pass a neutral descriptor so the util stays decoupled from
 * DB schemas, notification types, or UI components.
 */

export interface BetGradeDescriptor {
  homeTeam: string;
  awayTeam: string;
  competition?: string | null;
  /** ISO8601 string or Date. */
  eventStartTime: string | Date;
  /** Normalized family market type, e.g. "OVER_UNDER", "MATCH_ODDS". */
  marketType: string;
  /** Market scope — "FT" (default) / "1H" / "2H". */
  timeScope?: "FT" | "1H" | "2H" | string;
  /** Line value for handicap / total markets, if any. */
  familyLine?: number | null;
  /** Human-readable selection label: "Home", "Over 2.5", "Yes", etc. */
  atomLabel: string;
}

const scopeLabel = (scope?: string): string => {
  if (scope === "1H") return "first half only";
  if (scope === "2H") return "second half only";
  return "full time";
};

export function buildBetGradeUrl(bet: BetGradeDescriptor): string {
  const kickoff =
    typeof bet.eventStartTime === "string"
      ? new Date(bet.eventStartTime)
      : bet.eventStartTime;
  const date = kickoff.toISOString().slice(0, 10);
  const time = kickoff.toISOString().slice(11, 16);
  const query = [
    `Grade bet for match: ${bet.homeTeam} vs ${bet.awayTeam} ${bet.competition ? `(${bet.competition})` : ""} on ${date} ${time} UTC.`,
    `Bet: ${bet.marketType} (${scopeLabel(bet.timeScope)}), Line: ${bet.familyLine ?? "N/A"}, Pick: ${bet.atomLabel}.`,
    `Rules:`,
    `- Over/Under: Total goals > Line = OVER wins, < Line = UNDER. Exact hits (e.g. 3.0) = VOID.`,
    `- Quarter lines (e.g. 2.25): Split stake (HALF_WON / HALF_LOST).`,
    `Task:`,
    `1. Find FT score.`,
    `2. Explain step-by-step calculation.`,
    `3. End with a line containing EXACTLY ONE of: WON, HALF_WON, LOST, HALF_LOST, VOID, PENDING.`,
  ].join("\n");

  const params = new URLSearchParams({
    q: query,
    udm: "50",
    aep: "1",
    hl: "en",
  });
  return `https://www.google.com/search?${params.toString()}`;
}
