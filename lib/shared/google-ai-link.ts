
import { format, isValid, parseISO } from "date-fns";

export interface BetGradeDescriptor {
  homeTeam: string;
  awayTeam: string;
  competition?: string | null;
  eventStartTime: string | Date;
  marketType: string;
  timeScope?: "FT" | "1H" | "2H" | string;
  familyLine?: number | null;
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
      ? parseISO(bet.eventStartTime)
      : bet.eventStartTime;

  const dateTimeClause = isValid(kickoff)
    ? format(kickoff, "yyyy-MM-dd HH:mm")
    : String(bet.eventStartTime);

  const query = [
    `${bet.homeTeam} vs ${bet.awayTeam}${bet.competition ? ` ${bet.competition}` : ""} ${dateTimeClause}`,
    `Kickoff: ${dateTimeClause}.`,
    `Bet: ${bet.marketType}, ${scopeLabel(bet.timeScope)}, line ${bet.familyLine ?? "N/A"}, pick ${bet.atomLabel}.`,
    `Task: verify the official match status and relevant score first, then calculate the bet result.`,
    `Use full-time score for full time bets, first-half score for first half bets, and second-half score for second half bets.`,
    `Rules: MATCH_RESULT wins only when the picked home/draw/away result matches the score; totals compare goals to the line; handicap markets apply the line to the picked side; exact whole-line pushes are VOID; quarter lines can be HALF_WON or HALF_LOST.`,
    `If the match is not final or the score cannot be verified, return PENDING.`,
    `Output order: Score/status, Calculation, then a final line exactly as "Result: WON|HALF_WON|LOST|HALF_LOST|VOID|PENDING".`,
  ].join("\n");

  const params = new URLSearchParams({
    q: query,
    udm: "50",
    aep: "1",
    hl: "en",
  });
  return `https://www.google.com/search?${params.toString()}`;
}
