

export const SETTLED_OUTCOMES = [
  "won",
  "half_won",
  "lost",
  "half_lost",
  "void",
] as const;

export const POSITIVE_OUTCOMES = ["won", "half_won"] as const;

export const EXCLUDED_OUTCOMES = ["void"] as const;

export const NEGATIVE_OUTCOMES = ["lost", "half_lost"] as const;

export type SettledOutcome = (typeof SETTLED_OUTCOMES)[number];
export type TrainingLabel = "positive" | "negative";
export type ExampleType =
  | "settled_detected"
  | "placed_settled"
  | "shadow_scored";


export function deriveLabel(outcome: string): TrainingLabel | null {
  if ((POSITIVE_OUTCOMES as readonly string[]).includes(outcome))
    return "positive";
  if ((NEGATIVE_OUTCOMES as readonly string[]).includes(outcome))
    return "negative";
  return null;
}


export function computeUnitReturn(
  outcome: string,
  softOdds: number,
  commissionPct: number,
): number | null {
  const b = (softOdds - 1) * (1 - commissionPct / 100);

  switch (outcome) {
    case "won":
      return b;
    case "half_won":
      return b * 0.5;
    case "lost":
      return -1;
    case "half_lost":
      return -0.5;
    default:
      return null;
  }
}


const HALF_OUTCOME_WEIGHT = 0.5;
const MIN_SAMPLE_WEIGHT = 0.1;
const MAX_SAMPLE_WEIGHT = 10.0;

export function deriveSampleWeight(
  outcome: string,
  unitReturn: number | null,
): number {
  let weight = Math.abs(unitReturn ?? 0);
  if (!Number.isFinite(weight) || weight <= 0) {
    weight = 1.0;
  }
  if (outcome === "half_won" || outcome === "half_lost") {
    weight *= HALF_OUTCOME_WEIGHT;
  }
  return Math.min(MAX_SAMPLE_WEIGHT, Math.max(MIN_SAMPLE_WEIGHT, weight));
}


export const EXAMPLE_TYPE_PRECEDENCE: Record<ExampleType, number> = {
  placed_settled: 4,
  settled_detected: 3,
  shadow_scored: 2,
};

export function shouldReplaceExample(
  existing: ExampleType,
  candidate: ExampleType,
): boolean {
  return EXAMPLE_TYPE_PRECEDENCE[candidate] > EXAMPLE_TYPE_PRECEDENCE[existing];
}
