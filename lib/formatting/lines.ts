
export function formatLine(line: number): string {
  return String(line).replace(".", "_");
}

export function formatHandicapLine(line: number): string {
  if (line === 0) return "0";
  const prefix = line < 0 ? "m" : "p";
  const absLine = Math.abs(line).toString().replace(".", "_");
  return `${prefix}${absLine}`;
}

export function extractLine(marketName: string): number | null {
  const match = marketName.match(/([+-]?\d+\.?\d*)\s*$/);
  if (!match) return null;
  return Math.abs(parseFloat(match[1]));
}

export function extractSignedLine(marketName: string): number | null {
  const match = marketName.match(/([+-]?\d+\.?\d*)\s*$/);
  if (!match) return null;
  return parseFloat(match[1]);
}
