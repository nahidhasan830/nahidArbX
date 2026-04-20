/**
 * Atoms Registry
 *
 * Loads atoms.json and provides lookup utilities.
 * Validates family structure at initialization.
 */

import atomsData from "./atoms.json";
import type { Family, AtomsRegistry, TimeScope, AtomMarketType } from "./types";
import { logger } from "../shared/logger";

// Cast and validate the imported JSON
const registry = atomsData as AtomsRegistry;

// Lookup tables (populated at initialization)
const familyById = new Map<string, Family>();
const atomToFamilyId = new Map<string, string>();
const familiesByMarketType = new Map<string, Family[]>();

/**
 * Initialize lookup tables and validate structure
 */
function initializeRegistry(): void {
  const errors: string[] = [];

  for (const [familyId, family] of Object.entries(registry.families)) {
    // Validate family structure
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

    // Check for duplicate atom assignments
    for (const atomId of family.atoms) {
      const existingFamily = atomToFamilyId.get(atomId);
      if (existingFamily) {
        errors.push(
          `Atom "${atomId}" is assigned to multiple families: "${existingFamily}" and "${familyId}"`,
        );
      }
      atomToFamilyId.set(atomId, familyId);
    }

    // Store family
    familyById.set(familyId, family);

    // Index by market type
    const marketType = family.market_type;
    const existing = familiesByMarketType.get(marketType) || [];
    existing.push(family);
    familiesByMarketType.set(marketType, existing);
  }

  // Log validation results
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

// Initialize on module load
initializeRegistry();

// ============================================
// Lookup Functions
// ============================================

/**
 * Get a family by its ID
 */
export function getFamily(familyId: string): Family | undefined {
  return familyById.get(familyId);
}

/**
 * Get the family that contains a specific atom
 */
export function getFamilyByAtom(atomId: string): Family | undefined {
  const familyId = atomToFamilyId.get(atomId);
  return familyId ? familyById.get(familyId) : undefined;
}

/**
 * Get the family ID for a specific atom
 */
export function getFamilyIdByAtom(atomId: string): string | undefined {
  return atomToFamilyId.get(atomId);
}

/**
 * Check if an atom ID is valid (exists in the registry)
 */
export function isValidAtom(atomId: string): boolean {
  return atomToFamilyId.has(atomId);
}

/**
 * Get all atom IDs in a family
 */
export function getAtomsInFamily(familyId: string): string[] {
  const family = familyById.get(familyId);
  return family ? [...family.atoms] : [];
}

/**
 * Get all families
 */
export function getAllFamilies(): Family[] {
  return Array.from(familyById.values());
}

/**
 * Get all family IDs
 */
export function getAllFamilyIds(): string[] {
  return Array.from(familyById.keys());
}

/**
 * Get families by market type
 */
export function getFamiliesByMarketType(marketType: AtomMarketType): Family[] {
  return familiesByMarketType.get(marketType) || [];
}

/**
 * Find a family by market type, time scope, and optional line
 */
export function findFamily(
  marketType: AtomMarketType,
  timeScope: TimeScope,
  line?: number,
): Family | undefined {
  const candidates = familiesByMarketType.get(marketType) || [];

  for (const family of candidates) {
    if (family.time_scope !== timeScope) continue;

    // For markets with lines, must match exactly
    if (line !== undefined) {
      if (family.line === line) return family;
    } else {
      // For markets without lines (e.g., BTTS, DNB)
      if (family.line === undefined) return family;
    }
  }

  return undefined;
}

/**
 * Get registry statistics
 */
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
