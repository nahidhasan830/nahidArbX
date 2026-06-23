
import type { ProviderKey } from "../providers/registry";
import { getAllOddsForAtom } from "./store";
import { getFamily } from "./registry";


export interface TrueOddsResult {
  atomId: string;
  rawOdds: number;
  rawProb: number;
  trueProb: number;
  trueOdds: number;
  vigPct: number;
  worstCaseMethod: DevigMethod;
}

export type DevigMethod = "multiplicative" | "additive" | "power" | "shin";

export interface FamilyTrueOdds {
  familyId: string;
  provider: ProviderKey;
  totalImpliedProb: number;
  vigPct: number;
  atoms: TrueOddsResult[];
}


function solvePowerExponent(rawProbs: number[]): number {
  let lo = 1;
  let hi = 100;

  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    let sum = 0;
    for (const p of rawProbs) sum += Math.pow(p, mid);
    if (sum > 1) lo = mid;
    else hi = mid;
  }

  return (lo + hi) / 2;
}


function solveShinZ(rawProbs: number[], totalImplied: number): number {
  const n = rawProbs.length;

  if (n === 2) {
    const diff = rawProbs[0] - rawProbs[1];
    const S = totalImplied;
    return ((S - 1) * (diff * diff - S)) / (S * (diff * diff - 1));
  }

  let z = 0;
  for (let iter = 0; iter < 1000; iter++) {
    let sumSqrt = 0;
    for (const p of rawProbs) {
      sumSqrt += Math.sqrt(z * z + (4 * (1 - z) * p * p) / totalImplied);
    }
    const zNew = (sumSqrt - 2) / (n - 2);
    if (Math.abs(zNew - z) < 1e-12) break;
    z = zNew;
  }

  return z;
}

function computeShinProbs(
  rawProbs: number[],
  totalImplied: number,
  z: number,
): number[] {
  const denom = 2 * (1 - z);
  return rawProbs.map(
    (p) =>
      (Math.sqrt(z * z + (4 * (1 - z) * p * p) / totalImplied) - z) / denom,
  );
}


const ADDITIVE_FLOOR = 0.001;

function computeAdditiveProbs(
  rawProbs: number[],
  totalImplied: number,
): number[] {
  const n = rawProbs.length;
  const marginPerOutcome = (totalImplied - 1) / n;
  return rawProbs.map((p) => Math.max(p - marginPerOutcome, ADDITIVE_FLOOR));
}


export function calculateTrueOddsForFamily(
  eventId: string,
  familyId: string,
  provider: ProviderKey,
): FamilyTrueOdds | null {
  const family = getFamily(familyId);
  if (!family) return null;

  const rawOdds: { atomId: string; odds: number }[] = [];
  let totalImpliedProb = 0;

  for (const atomId of family.atoms) {
    const oddsMap = getAllOddsForAtom(eventId, familyId, atomId);
    const providerOdds = oddsMap.get(provider);

    if (!providerOdds || providerOdds.suspended) {
      return null;
    }

    if (providerOdds.odds <= 1) {
      return null;
    }

    rawOdds.push({ atomId, odds: providerOdds.odds });
    totalImpliedProb += 1 / providerOdds.odds;
  }

  if (rawOdds.length !== family.atoms.length) {
    return null;
  }

  const vigPct = (totalImpliedProb - 1) * 100;
  const rawProbs = rawOdds.map(({ odds }) => 1 / odds);

  const multProbs = rawProbs.map((p) => p / totalImpliedProb);

  const addProbs = computeAdditiveProbs(rawProbs, totalImpliedProb);

  const k = solvePowerExponent(rawProbs);
  const powerProbs = rawProbs.map((p) => Math.pow(p, k));

  const z = solveShinZ(rawProbs, totalImpliedProb);
  const shinProbs = computeShinProbs(rawProbs, totalImpliedProb, z);

  const atoms: TrueOddsResult[] = rawOdds.map(({ atomId, odds }, i) => {
    const rawProb = rawProbs[i];

    const candidates: [number, DevigMethod][] = [
      [multProbs[i], "multiplicative"],
      [addProbs[i], "additive"],
      [powerProbs[i], "power"],
      [shinProbs[i], "shin"],
    ];

    let trueProb = candidates[0][0];
    let worstCaseMethod: DevigMethod = candidates[0][1];

    for (let j = 1; j < candidates.length; j++) {
      if (candidates[j][0] > trueProb) {
        trueProb = candidates[j][0];
        worstCaseMethod = candidates[j][1];
      }
    }

    const trueOdds = 1 / trueProb;

    const atomVigPct = ((rawProb - trueProb) / rawProb) * 100;

    return {
      atomId,
      rawOdds: odds,
      rawProb,
      trueProb,
      trueOdds,
      vigPct: atomVigPct,
      worstCaseMethod,
    };
  });

  return {
    familyId,
    provider,
    totalImpliedProb,
    vigPct,
    atoms,
  };
}

export function getTrueOddsForAtom(
  eventId: string,
  familyId: string,
  atomId: string,
  provider: ProviderKey,
): TrueOddsResult | null {
  const familyOdds = calculateTrueOddsForFamily(eventId, familyId, provider);
  if (!familyOdds) return null;

  return familyOdds.atoms.find((a) => a.atomId === atomId) ?? null;
}

export function getFamilyVig(
  eventId: string,
  familyId: string,
  provider: ProviderKey,
): number | null {
  const familyOdds = calculateTrueOddsForFamily(eventId, familyId, provider);
  return familyOdds?.vigPct ?? null;
}

export function hasCompleteOdds(
  eventId: string,
  familyId: string,
  provider: ProviderKey,
): boolean {
  return calculateTrueOddsForFamily(eventId, familyId, provider) !== null;
}
