
import { format, isValid, parseISO } from "date-fns";

export interface EventLabelSide {
  homeTeam: string;
  awayTeam: string;
}

export function eventLabel(e: EventLabelSide): string {
  return `${e.homeTeam} vs ${e.awayTeam}`;
}

export function pairLabelSides(
  a: EventLabelSide,
  b: EventLabelSide,
): { sideA: string; sideB?: string } {
  const sa = eventLabel(a);
  const sb = eventLabel(b);
  return {
    sideA: sa,
    sideB: sa.toLowerCase() === sb.toLowerCase() ? undefined : sb,
  };
}

export function pairLabel(a: EventLabelSide, b: EventLabelSide): string {
  const { sideA, sideB } = pairLabelSides(a, b);
  return sideB ? `${sideA} ↔ ${sideB}` : sideA;
}

export function eventPromptLine(e: {
  homeTeam: string;
  awayTeam: string;
  competition: string;
  startTime: Date | string;
}): string {
  const kickoff =
    e.startTime instanceof Date ? e.startTime : parseISO(e.startTime);
  const kickoffText = isValid(kickoff)
    ? format(kickoff, "yyyy-MM-dd HH:mm")
    : String(e.startTime);
  return `${e.homeTeam} vs ${e.awayTeam} | ${e.competition} | ${kickoffText}`;
}
