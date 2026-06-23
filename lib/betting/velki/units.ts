
export const VELKI_AMOUNT_SCALE = 100;

export function toBDT(value: number): number;
export function toBDT(value: number | null): number | null;
export function toBDT(value: number | undefined): number | undefined;
export function toBDT(
  value: number | null | undefined,
): number | null | undefined {
  if (value === null || value === undefined) return value;
  return value * VELKI_AMOUNT_SCALE;
}

export function toBDTFromString(value: string): number {
  const parsed = parseFloat(value);
  if (Number.isNaN(parsed)) return NaN;
  return parsed * VELKI_AMOUNT_SCALE;
}
