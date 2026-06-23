
import type { ProviderKey } from "../providers/registry";
import { getProviderCommission } from "../providers/registry";
import {
  getRuntimeSoftProviders,
  getRuntimeSharpProviders,
} from "../providers/runtime-state";
import { getAllOddsForAtom, getFamiliesForEvent, parseDirtyKey } from "./store";
import { getFamily } from "./registry";
import {
  calculateTrueOddsForFamily,
  type TrueOddsResult,
  type FamilyTrueOdds,
} from "./vig-removal";
import {
  MIN_EV_PCT,
  KELLY_FRACTION,
  VALUE_TOTAL_STAKE,
  MAX_VALUE_ODDS_AGE_MS,
} from "../shared/constants";
import { adjustOddsForCommission } from "../shared/commission";


const valueCache = new Map<string, ValueBet[]>();

const vigCache = new Map<string, FamilyTrueOdds | null>();

let valueCacheWarmed = false;

export function resetValueCache(): void {
  valueCache.clear();
  vigCache.clear();
  valueCacheWarmed = false;
}

export function getCachedVigData(
  eventId: string,
  familyId: string,
): FamilyTrueOdds | null | undefined {
  return vigCache.get(`${eventId}|${familyId}`);
}

export function detectAllValueBetsIncremental(
  eventIds: string[],
  dirty: Set<string>,
  options: ValueDetectionOptions = {},
): ValueBet[] {
  const activeEvents = new Set(eventIds);

  if (!valueCacheWarmed) {
    valueCache.clear();
    vigCache.clear();
    for (const eventId of eventIds) {
      const families = getFamiliesForEvent(eventId);
      for (const familyId of families) {
        const key = `${eventId}|${familyId}`;
        const vbs = detectValueForFamily(eventId, familyId, options);
        valueCache.set(key, vbs);
        const sharpProviders = getRuntimeSharpProviders();
        if (sharpProviders.length > 0) {
          vigCache.set(
            key,
            calculateTrueOddsForFamily(eventId, familyId, sharpProviders[0]),
          );
        }
      }
    }
    valueCacheWarmed = true;
  } else {
    for (const key of valueCache.keys()) {
      const { eventId } = parseDirtyKey(key);
      if (!activeEvents.has(eventId)) {
        valueCache.delete(key);
        vigCache.delete(key);
      }
    }

    for (const dirtyKey of dirty) {
      const { eventId, familyId } = parseDirtyKey(dirtyKey);
      if (!activeEvents.has(eventId)) {
        valueCache.delete(dirtyKey);
        vigCache.delete(dirtyKey);
        continue;
      }
      valueCache.set(
        dirtyKey,
        detectValueForFamily(eventId, familyId, options),
      );
      const sharpProviders = getRuntimeSharpProviders();
      if (sharpProviders.length > 0) {
        vigCache.set(
          dirtyKey,
          calculateTrueOddsForFamily(eventId, familyId, sharpProviders[0]),
        );
      }
    }
  }

  const result: ValueBet[] = [];
  for (const [key, vbs] of valueCache) {
    const { eventId } = parseDirtyKey(key);
    if (activeEvents.has(eventId)) result.push(...vbs);
  }
  result.sort((a, b) => b.evPct - a.evPct);
  return result;
}


export interface ValueBet {
  id: string;
  eventId: string;
  familyId: string;
  atomId: string;

  sharpProvider: ProviderKey;
  sharpOdds: number;
  trueProb: number;
  trueOdds: number;

  softProvider: ProviderKey;
  softOdds: number;
  adjustedSoftOdds: number;
  impliedProb: number;

  commissionPct: number;

  evPct: number;
  edge: number;
  kellyFraction: number;
  kellyStake: number;

  detectedAt: Date;
  timestamp: number;
}

export interface ValueDetectionOptions {
  minEvPct?: number;
  kellyFraction?: number;
  totalStake?: number;
  maxOddsAgeMs?: number;
}

export interface ValueDetectionStats {
  eventsScanned: number;
  familiesScanned: number;
  atomsCompared: number;
  valueBetsFound: number;
  avgEvPct: number;
  bestEvPct: number;
}


export function detectValueForAtom(
  eventId: string,
  familyId: string,
  atomId: string,
  trueOdds: TrueOddsResult,
  sharpProvider: ProviderKey,
  options: ValueDetectionOptions = {},
): ValueBet[] {
  const {
    minEvPct = MIN_EV_PCT,
    kellyFraction = KELLY_FRACTION,
    totalStake = VALUE_TOTAL_STAKE,
    maxOddsAgeMs = MAX_VALUE_ODDS_AGE_MS,
  } = options;

  const valueBets: ValueBet[] = [];
  const softProviders = getRuntimeSoftProviders();
  const now = Date.now();

  const allOdds = getAllOddsForAtom(eventId, familyId, atomId);

  const sharpRecord = allOdds.get(sharpProvider);
  const sharpOddsAgeMs =
    sharpRecord != null ? now - sharpRecord.timestamp : null;

  if (sharpOddsAgeMs == null || sharpOddsAgeMs > maxOddsAgeMs) {
    return valueBets;
  }

  for (const softProvider of softProviders) {
    const softRecord = allOdds.get(softProvider);
    if (!softRecord || softRecord.suspended) continue;

    const ageMs = now - softRecord.timestamp;
    if (ageMs > maxOddsAgeMs) continue;

    if (softRecord.odds <= 1) continue;

    const rawSoftOdds = softRecord.odds;

    const commissionPct = getProviderCommission(softProvider);
    const adjustedSoftOdds = adjustOddsForCommission(
      rawSoftOdds,
      commissionPct,
    );

    const impliedProb = 1 / adjustedSoftOdds;

    const edge = adjustedSoftOdds * trueOdds.trueProb - 1;
    const evPct = edge * 100;

    if (evPct < minEvPct) continue;

    const fullKelly = edge / (adjustedSoftOdds - 1);
    const fractionalKelly = fullKelly * kellyFraction;

    const kellyStake = Math.max(
      0,
      Math.min(fractionalKelly * totalStake, totalStake * 0.1),
    );

    valueBets.push({
      id: `${eventId}|${familyId}|${atomId}`,
      eventId,
      familyId,
      atomId,
      sharpProvider,
      sharpOdds: trueOdds.rawOdds,
      trueProb: trueOdds.trueProb,
      trueOdds: trueOdds.trueOdds,
      softProvider,
      softOdds: rawSoftOdds, // Raw odds from provider
      adjustedSoftOdds, // Commission-adjusted odds
      impliedProb,
      commissionPct, // Commission percentage applied
      evPct: Math.round(evPct * 100) / 100, // Round to 2 decimals
      edge,
      kellyFraction: fractionalKelly,
      kellyStake: Math.round(kellyStake * 100) / 100, // Round to cents
      detectedAt: new Date(),
      timestamp: softRecord.timestamp,
    });
  }

  if (valueBets.length === 0) return [];
  const best = valueBets.reduce((a, b) => (a.evPct > b.evPct ? a : b));
  return [best];
}

export function detectValueForFamily(
  eventId: string,
  familyId: string,
  options: ValueDetectionOptions = {},
): ValueBet[] {
  const family = getFamily(familyId);
  if (!family) return [];

  const sharpProviders = getRuntimeSharpProviders();
  if (sharpProviders.length === 0) {
    return [];
  }

  const sharpProvider = sharpProviders[0];

  const familyTrueOdds = calculateTrueOddsForFamily(
    eventId,
    familyId,
    sharpProvider,
  );
  if (!familyTrueOdds) {
    return [];
  }

  const valueBets: ValueBet[] = [];
  for (const atomTrueOdds of familyTrueOdds.atoms) {
    const atomValues = detectValueForAtom(
      eventId,
      familyId,
      atomTrueOdds.atomId,
      atomTrueOdds,
      sharpProvider,
      options,
    );
    valueBets.push(...atomValues);
  }

  return valueBets;
}

export function detectValueForEvent(
  eventId: string,
  options: ValueDetectionOptions = {},
): ValueBet[] {
  const families = getFamiliesForEvent(eventId);
  const valueBets: ValueBet[] = [];

  for (const familyId of families) {
    const familyValues = detectValueForFamily(eventId, familyId, options);
    valueBets.push(...familyValues);
  }

  return valueBets;
}

export function detectAllValueBets(
  eventIds: string[],
  options: ValueDetectionOptions = {},
): ValueBet[] {
  const valueBets: ValueBet[] = [];

  for (const eventId of eventIds) {
    const eventValues = detectValueForEvent(eventId, options);
    valueBets.push(...eventValues);
  }

  valueBets.sort((a, b) => b.evPct - a.evPct);

  return valueBets;
}

export function detectAllValueBetsWithStats(
  eventIds: string[],
  options: ValueDetectionOptions = {},
): { valueBets: ValueBet[]; stats: ValueDetectionStats } {
  let familiesScanned = 0;
  let atomsCompared = 0;

  const valueBets: ValueBet[] = [];

  for (const eventId of eventIds) {
    const families = getFamiliesForEvent(eventId);

    for (const familyId of families) {
      familiesScanned++;

      const family = getFamily(familyId);
      if (family) {
        atomsCompared += family.atoms.length;
      }

      const familyValues = detectValueForFamily(eventId, familyId, options);
      valueBets.push(...familyValues);
    }
  }

  valueBets.sort((a, b) => b.evPct - a.evPct);

  const avgEvPct =
    valueBets.length > 0
      ? valueBets.reduce((sum, vb) => sum + vb.evPct, 0) / valueBets.length
      : 0;
  const bestEvPct = valueBets.length > 0 ? valueBets[0].evPct : 0;

  return {
    valueBets,
    stats: {
      eventsScanned: eventIds.length,
      familiesScanned,
      atomsCompared,
      valueBetsFound: valueBets.length,
      avgEvPct: Math.round(avgEvPct * 100) / 100,
      bestEvPct,
    },
  };
}

export function validateValueBet(vb: ValueBet): boolean {
  const allOdds = getAllOddsForAtom(vb.eventId, vb.familyId, vb.atomId);

  const currentSoftOdds = allOdds.get(vb.softProvider);
  if (!currentSoftOdds || currentSoftOdds.suspended) return false;

  if (currentSoftOdds.odds < vb.softOdds * 0.98) return false;

  const commissionPct = getProviderCommission(vb.softProvider);
  const adjustedOdds = adjustOddsForCommission(
    currentSoftOdds.odds,
    commissionPct,
  );
  const currentEdge = adjustedOdds * vb.trueProb - 1;
  const currentEvPct = currentEdge * 100;

  return currentEvPct > 0;
}

export function filterByMinEv(
  valueBets: ValueBet[],
  minEvPct: number,
): ValueBet[] {
  return valueBets.filter((vb) => vb.evPct >= minEvPct);
}

export function groupByEvent(valueBets: ValueBet[]): Map<string, ValueBet[]> {
  const grouped = new Map<string, ValueBet[]>();

  for (const vb of valueBets) {
    const list = grouped.get(vb.eventId) || [];
    list.push(vb);
    grouped.set(vb.eventId, list);
  }

  return grouped;
}

export function groupByProvider(
  valueBets: ValueBet[],
): Map<ProviderKey, ValueBet[]> {
  const grouped = new Map<ProviderKey, ValueBet[]>();

  for (const vb of valueBets) {
    const list = grouped.get(vb.softProvider) || [];
    list.push(vb);
    grouped.set(vb.softProvider, list);
  }

  return grouped;
}
