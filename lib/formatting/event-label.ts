/**
 * Shared string helpers for rendering an event (or a pair) as human-readable
 * text. Centralizes the "A vs B" / "A vs B ↔ C vs D" format used across the
 * UI, toasts, logs, and the Gemini prompt so they stay consistent.
 */

export interface EventLabelSide {
  homeTeam: string;
  awayTeam: string;
}

/** "Home vs Away" — one side of a pair. */
export function eventLabel(e: EventLabelSide): string {
  return `${e.homeTeam} vs ${e.awayTeam}`;
}

/**
 * Two sides of a pair, collapsed to one label when the teams are textually
 * identical. Returned object splits sideA / sideB so callers can render them
 * as separate truncatable lines OR join them with " ↔ " as a single string.
 */
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

/**
 * Single-line representation of a pair. Returns "A vs B" when both sides are
 * textually identical, otherwise "A vs B ↔ C vs D".
 */
export function pairLabel(a: EventLabelSide, b: EventLabelSide): string {
  const { sideA, sideB } = pairLabelSides(a, b);
  return sideB ? `${sideA} ↔ ${sideB}` : sideA;
}

/**
 * "Home vs Away | Competition | YYYY-MM-DD HHmmZ" — the dense one-line format
 * used inside the Gemini prompt so the model sees all disambiguating fields.
 */
export function eventPromptLine(e: {
  homeTeam: string;
  awayTeam: string;
  competition: string;
  startTime: Date | string;
}): string {
  const iso = new Date(e.startTime).toISOString();
  return `${e.homeTeam} vs ${e.awayTeam} | ${e.competition} | ${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
}
