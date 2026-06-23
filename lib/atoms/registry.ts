
import atomsData from "./atoms.json";
import type { Family, AtomsRegistry, TimeScope, AtomMarketType } from "./types";
import { logger } from "../shared/logger";

const registry = atomsData as AtomsRegistry;

const familyById = new Map<string, Family>();
const atomToFamilyId = new Map<string, string>();
const familiesByMarketType = new Map<string, Family[]>();

function initializeRegistry(): void {
  const errors: string[] = [];

  for (const [familyId, family] of Object.entries(registry.families)) {
    if (family.type === "pair" && family.atoms.length !== 2) {
      errors.push(
        `Family "${familyId}" is type "pair" but has ${family.atoms.length} atoms (expected 2)`,
      );
    }
    if (family.type === "group" && family.atoms.length < 3) {
      errors.push(
        `Family "${familyId}" is type "group" but has ${family.atoms.length} atoms (expected >= 3)`,
      );
    }

    for (const atomId of family.atoms) {
      const existingFamily = atomToFamilyId.get(atomId);
      if (existingFamily) {
        errors.push(
          `Atom "${atomId}" is assigned to multiple families: "${existingFamily}" and "${familyId}"`,
        );
      }
      atomToFamilyId.set(atomId, familyId);
    }

    familyById.set(familyId, family);

    const marketType = family.market_type;
    const existing = familiesByMarketType.get(marketType) || [];
    existing.push(family);
    familiesByMarketType.set(marketType, existing);
  }

  if (errors.length > 0) {
    logger.error("AtomsRegistry", "Validation errors:", errors);
    throw new Error(
      `AtomsRegistry validation failed with ${errors.length} errors`,
    );
  }

  logger.info(
    "AtomsRegistry",
    `Loaded ${familyById.size} families, ${atomToFamilyId.size} atoms`,
  );
}

initializeRegistry();


export function getFamily(familyId: string): Family | undefined {
  return familyById.get(familyId);
}

export function getFamilyByAtom(atomId: string): Family | undefined {
  const familyId = atomToFamilyId.get(atomId);
  return familyId ? familyById.get(familyId) : undefined;
}

export function getFamilyIdByAtom(atomId: string): string | undefined {
  return atomToFamilyId.get(atomId);
}

export function isValidAtom(atomId: string): boolean {
  return atomToFamilyId.has(atomId);
}

export function getAtomsInFamily(familyId: string): string[] {
  const family = familyById.get(familyId);
  return family ? [...family.atoms] : [];
}

export function getAllFamilies(): Family[] {
  return Array.from(familyById.values());
}

export function getAllFamilyIds(): string[] {
  return Array.from(familyById.keys());
}

export function getFamiliesByMarketType(marketType: AtomMarketType): Family[] {
  return familiesByMarketType.get(marketType) || [];
}

export function findFamily(
  marketType: AtomMarketType,
  timeScope: TimeScope,
  line?: number,
): Family | undefined {
  const candidates = familiesByMarketType.get(marketType) || [];

  for (const family of candidates) {
    if (family.time_scope !== timeScope) continue;

    if (line !== undefined) {
      if (family.line === line) return family;
    } else {
      if (family.line === undefined) return family;
    }
  }

  return undefined;
}

export function getRegistryStats(): {
  familyCount: number;
  atomCount: number;
  pairCount: number;
  groupCount: number;
  marketTypes: string[];
} {
  let pairCount = 0;
  let groupCount = 0;

  for (const family of familyById.values()) {
    if (family.type === "pair") pairCount++;
    else groupCount++;
  }

  return {
    familyCount: familyById.size,
    atomCount: atomToFamilyId.size,
    pairCount,
    groupCount,
    marketTypes: Array.from(familiesByMarketType.keys()),
  };
}
