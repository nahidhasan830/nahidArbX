/**
 * Line Formatting Utilities
 *
 * Shared functions for formatting betting lines (handicaps, totals, etc.)
 * Used across all provider mapping files.
 */

/**
 * Format a line number for use in atom IDs.
 * Replaces decimal points with underscores.
 *
 * @example formatLine(2.5) => "2_5"
 * @example formatLine(1) => "1"
 */
export function formatLine(line: number): string {
  return String(line).replace(".", "_");
}

/**
 * Format a handicap line with sign prefix for atom IDs.
 * Positive lines get 'p' prefix, negative get 'm' prefix.
 *
 * @example formatHandicapLine(1.5) => "p1_5"
 * @example formatHandicapLine(-0.5) => "m0_5"
 * @example formatHandicapLine(0) => "0"
 */
export function formatHandicapLine(line: number): string {
  if (line === 0) return "0";
  const prefix = line < 0 ? "m" : "p";
  const absLine = Math.abs(line).toString().replace(".", "_");
  return `${prefix}${absLine}`;
}

/**
 * Extract an unsigned line number from a market name string.
 * Returns the absolute value of the line.
 *
 * @example extractLine("Over 2.5 Goals") => 2.5
 * @example extractLine("Asian Handicap -1.5") => 1.5
 */
export function extractLine(marketName: string): number | null {
  const match = marketName.match(/([+-]?\d+\.?\d*)\s*$/);
  if (!match) return null;
  return Math.abs(parseFloat(match[1]));
}

/**
 * Extract a signed line number from a market name string.
 * Preserves the sign for handicap markets.
 *
 * @example extractSignedLine("Asian Handicap -1.5") => -1.5
 * @example extractSignedLine("Asian Handicap +0.5") => 0.5
 */
export function extractSignedLine(marketName: string): number | null {
  const match = marketName.match(/([+-]?\d+\.?\d*)\s*$/);
  if (!match) return null;
  return parseFloat(match[1]);
}
