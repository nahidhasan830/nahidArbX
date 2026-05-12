export const MARKET_PHASES = ["pre_match", "in_play"] as const;

export type MarketPhase = (typeof MARKET_PHASES)[number];

export const DEFAULT_VALUE_DETECTION_PHASES: MarketPhase[] = ["pre_match"];
export const DEFAULT_BET_PLACEMENT_PHASES: MarketPhase[] = ["pre_match"];

const MARKET_PHASE_SET = new Set<string>(MARKET_PHASES);

export function normalizeMarketPhases(
  value: unknown,
  fallback: readonly MarketPhase[],
): MarketPhase[] {
  if (!Array.isArray(value)) return [...fallback];
  const phases = value.filter((phase): phase is MarketPhase =>
    MARKET_PHASE_SET.has(String(phase)),
  );
  return phases.length > 0 ? Array.from(new Set(phases)) : [...fallback];
}

export function getMarketPhase(
  eventStartTime: Date | string | number,
  nowMs = Date.now(),
): MarketPhase {
  const startMs =
    eventStartTime instanceof Date
      ? eventStartTime.getTime()
      : new Date(eventStartTime).getTime();
  return Number.isFinite(startMs) && startMs > nowMs ? "pre_match" : "in_play";
}

export function isMarketPhaseAllowed(
  eventStartTime: Date | string | number,
  phases: readonly MarketPhase[],
  nowMs = Date.now(),
): boolean {
  return phases.includes(getMarketPhase(eventStartTime, nowMs));
}

export function marketPhaseLabel(phase: MarketPhase): string {
  return phase === "pre_match" ? "Pre-Match" : "In Play";
}
