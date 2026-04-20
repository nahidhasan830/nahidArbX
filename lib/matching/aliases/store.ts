/**
 * Alias Storage
 *
 * Persistent storage for learned team and competition aliases.
 * Uses JSON files for persistence across restarts.
 */

import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { logger } from "../../shared/logger";
import { hasGroupConflict } from "./group-guard";

// ============================================
// File Paths
// ============================================

const ALIASES_DIR = path.join(process.cwd(), "data", "aliases");
const TEAM_ALIASES_FILE = path.join(ALIASES_DIR, "team-aliases.json");
const COMPETITION_ALIASES_FILE = path.join(
  ALIASES_DIR,
  "competition-aliases.json",
);

// ============================================
// Schemas
// ============================================

const AliasEntrySchema = z.object({
  source: z.string(), // The variant name (normalized)
  canonical: z.string(), // The canonical name to use
  addedAt: z.string(),
  addedBy: z.string().optional(),
  autoLearned: z.boolean(),
  occurrences: z.number().default(1),
});

const AliasFileSchema = z.object({
  version: z.number(),
  updatedAt: z.string(),
  aliases: z.array(AliasEntrySchema),
});

// ============================================
// Types
// ============================================

export type AliasEntry = z.infer<typeof AliasEntrySchema>;
export type AliasFile = z.infer<typeof AliasFileSchema>;

// ============================================
// Gender Validation Helpers
// ============================================

/**
 * Detect if a team name indicates a women's team.
 * Used to prevent incorrectly aliasing men's and women's teams.
 */
function isWomensTeam(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("(wom") ||
    lower.includes("(w)") ||
    lower.includes("women") ||
    lower.includes(" w ") ||
    lower.endsWith(" w") ||
    lower.includes("ladies") ||
    lower.includes("femenino") ||
    lower.includes("femeni") ||
    lower.includes("feminino") ||
    lower.includes("frauen") ||
    lower.includes("dames") ||
    lower.includes("vrouwen")
  );
}

/**
 * Validate that an alias doesn't mix men's and women's teams.
 */
function isValidTeamAlias(source: string, canonical: string): boolean {
  const sourceIsWomens = isWomensTeam(source);
  const canonicalIsWomens = isWomensTeam(canonical);

  // Both must be same gender category
  if (sourceIsWomens !== canonicalIsWomens) {
    return false;
  }

  return true;
}

// ============================================
// In-Memory Cache
// ============================================

let teamAliasCache: Map<string, string> | null = null;
let competitionAliasCache: Map<string, string> | null = null;

// ============================================
// File Operations
// ============================================

/**
 * Ensure aliases directory exists.
 */
function ensureAliasDir(): void {
  if (!fs.existsSync(ALIASES_DIR)) {
    fs.mkdirSync(ALIASES_DIR, { recursive: true });
  }
}

/**
 * Load aliases from file.
 */
function loadAliasFile(filePath: string): AliasFile {
  if (!fs.existsSync(filePath)) {
    return { version: 1, updatedAt: new Date().toISOString(), aliases: [] };
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return AliasFileSchema.parse(parsed);
  } catch (error) {
    logger.error(
      "Aliases",
      `Failed to load ${path.basename(filePath)}:`,
      error,
    );
    return { version: 1, updatedAt: new Date().toISOString(), aliases: [] };
  }
}

/**
 * Save aliases to file.
 */
function saveAliasFile(filePath: string, data: AliasFile): void {
  ensureAliasDir();
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ============================================
// Team Aliases
// ============================================

/**
 * Get team aliases as a lookup map.
 * Returns { normalizedVariant: normalizedCanonical }
 */
export function getTeamAliases(): Record<string, string> {
  if (!teamAliasCache) {
    const file = loadAliasFile(TEAM_ALIASES_FILE);
    teamAliasCache = new Map(
      file.aliases.map((a) => [
        a.source.toLowerCase(),
        a.canonical.toLowerCase(),
      ]),
    );
  }
  return Object.fromEntries(teamAliasCache);
}

/**
 * Get all team alias entries (for admin display).
 */
export function getAllTeamAliases(): AliasEntry[] {
  return loadAliasFile(TEAM_ALIASES_FILE).aliases;
}

/**
 * Add a team alias.
 */
export function addTeamAlias(
  source: string,
  canonical: string,
  options: { autoLearned?: boolean; addedBy?: string } = {},
): void {
  const file = loadAliasFile(TEAM_ALIASES_FILE);
  let normalizedSource = source.toLowerCase().trim();
  let normalizedCanonical = canonical.toLowerCase().trim();

  // Skip if source equals canonical
  if (normalizedSource === normalizedCanonical) {
    return;
  }

  // Normalize direction: shorter name → longer name (canonical)
  // This prevents vice-versa duplicates by always mapping variant → canonical
  if (normalizedSource.length > normalizedCanonical.length) {
    [normalizedSource, normalizedCanonical] = [
      normalizedCanonical,
      normalizedSource,
    ];
    logger.info(
      "Aliases",
      `Normalized direction: "${normalizedSource}" -> "${normalizedCanonical}"`,
    );
  }

  // Validate gender: don't alias men's and women's teams together
  if (!isValidTeamAlias(normalizedSource, normalizedCanonical)) {
    logger.warn(
      "Aliases",
      `Rejected alias: "${normalizedSource}" -> "${normalizedCanonical}" (gender mismatch)`,
    );
    return;
  }

  // Conflict detection: check for circular/chain conflicts
  // 1. If canonical is already a source → would create a chain (A→B, B→C)
  const canonicalAsSource = file.aliases.find(
    (a) => a.source.toLowerCase() === normalizedCanonical,
  );
  if (canonicalAsSource) {
    // Resolve: use the final canonical instead (A→C, skip B)
    const finalCanonical = canonicalAsSource.canonical.toLowerCase();
    logger.warn(
      "Aliases",
      `Chain detected: "${normalizedSource}" -> "${normalizedCanonical}" -> "${finalCanonical}". Using final canonical.`,
    );
    normalizedCanonical = finalCanonical;
  }

  // 2. If source is already a canonical target → would create a cycle (X→A, A→B)
  const sourceAsCanonical = file.aliases.find(
    (a) => a.canonical.toLowerCase() === normalizedSource,
  );
  if (sourceAsCanonical) {
    // Resolve: update the existing alias to point to the new canonical
    logger.warn(
      "Aliases",
      `Cycle detected: "${sourceAsCanonical.source}" -> "${normalizedSource}" and "${normalizedSource}" -> "${normalizedCanonical}". Updating existing.`,
    );
    sourceAsCanonical.canonical = normalizedCanonical;
    sourceAsCanonical.occurrences++;
    saveAliasFile(TEAM_ALIASES_FILE, file);
    teamAliasCache = null;
    return;
  }

  // Check if alias already exists
  const existing = file.aliases.find(
    (a) => a.source.toLowerCase() === normalizedSource,
  );

  if (existing) {
    existing.occurrences++;
    // Update canonical if different (take the longer/more complete name)
    if (normalizedCanonical.length > existing.canonical.length) {
      existing.canonical = normalizedCanonical;
    }
  } else {
    file.aliases.push({
      source: normalizedSource,
      canonical: normalizedCanonical,
      addedAt: new Date().toISOString(),
      addedBy: options.addedBy,
      autoLearned: options.autoLearned ?? false,
      occurrences: 1,
    });
  }

  saveAliasFile(TEAM_ALIASES_FILE, file);
  teamAliasCache = null; // Invalidate cache

  logger.info(
    "Aliases",
    `Added team alias: "${normalizedSource}" -> "${normalizedCanonical}"`,
  );
}

/**
 * Remove a team alias.
 */
export function removeTeamAlias(source: string): boolean {
  const file = loadAliasFile(TEAM_ALIASES_FILE);
  const normalizedSource = source.toLowerCase().trim();
  const idx = file.aliases.findIndex(
    (a) => a.source.toLowerCase() === normalizedSource,
  );

  if (idx === -1) return false;

  file.aliases.splice(idx, 1);
  saveAliasFile(TEAM_ALIASES_FILE, file);
  teamAliasCache = null;

  logger.info("Aliases", `Removed team alias: "${source}"`);
  return true;
}

// ============================================
// Competition Aliases
// ============================================

/**
 * Get competition aliases as a lookup map.
 */
export function getCompetitionAliases(): Record<string, string> {
  if (!competitionAliasCache) {
    const file = loadAliasFile(COMPETITION_ALIASES_FILE);
    competitionAliasCache = new Map(
      file.aliases.map((a) => [
        a.source.toLowerCase(),
        a.canonical.toLowerCase(),
      ]),
    );
  }
  return Object.fromEntries(competitionAliasCache);
}

/**
 * Get all competition alias entries (for admin display).
 */
export function getAllCompetitionAliases(): AliasEntry[] {
  return loadAliasFile(COMPETITION_ALIASES_FILE).aliases;
}

/**
 * Add a competition alias.
 */
export function addCompetitionAlias(
  source: string,
  canonical: string,
  options: { autoLearned?: boolean; addedBy?: string } = {},
): void {
  const file = loadAliasFile(COMPETITION_ALIASES_FILE);
  let normalizedSource = source.toLowerCase().trim();
  let normalizedCanonical = canonical.toLowerCase().trim();

  // Skip if source equals canonical
  if (normalizedSource === normalizedCanonical) {
    return;
  }

  // Reject cross-group aliases (Serie C Group A vs Group B, or
  // ambiguous "Serie C" vs specific "Serie C Group A"). Applied before
  // direction normalization so both orderings are caught.
  if (hasGroupConflict(normalizedSource, normalizedCanonical)) {
    logger.warn(
      "Aliases",
      `Rejected competition alias: "${normalizedSource}" -> "${normalizedCanonical}" (group conflict)`,
    );
    return;
  }

  // Normalize direction: shorter name → longer name (canonical)
  // This prevents vice-versa duplicates by always mapping variant → canonical
  if (normalizedSource.length > normalizedCanonical.length) {
    [normalizedSource, normalizedCanonical] = [
      normalizedCanonical,
      normalizedSource,
    ];
    logger.info(
      "Aliases",
      `Normalized direction: "${normalizedSource}" -> "${normalizedCanonical}"`,
    );
  }

  // Conflict detection: check for circular/chain conflicts
  // 1. If canonical is already a source → would create a chain (A→B, B→C)
  const canonicalAsSource = file.aliases.find(
    (a) => a.source.toLowerCase() === normalizedCanonical,
  );
  if (canonicalAsSource) {
    // Resolve: use the final canonical instead (A→C, skip B)
    const finalCanonical = canonicalAsSource.canonical.toLowerCase();
    logger.warn(
      "Aliases",
      `Chain detected: "${normalizedSource}" -> "${normalizedCanonical}" -> "${finalCanonical}". Using final canonical.`,
    );
    normalizedCanonical = finalCanonical;
  }

  // 2. If source is already a canonical target → would create a cycle (X→A, A→B)
  const sourceAsCanonical = file.aliases.find(
    (a) => a.canonical.toLowerCase() === normalizedSource,
  );
  if (sourceAsCanonical) {
    // Resolve: update the existing alias to point to the new canonical
    logger.warn(
      "Aliases",
      `Cycle detected: "${sourceAsCanonical.source}" -> "${normalizedSource}" and "${normalizedSource}" -> "${normalizedCanonical}". Updating existing.`,
    );
    sourceAsCanonical.canonical = normalizedCanonical;
    sourceAsCanonical.occurrences++;
    saveAliasFile(COMPETITION_ALIASES_FILE, file);
    competitionAliasCache = null;
    return;
  }

  const existing = file.aliases.find(
    (a) => a.source.toLowerCase() === normalizedSource,
  );

  if (existing) {
    existing.occurrences++;
    // Update canonical if different (take the longer/more complete name)
    if (normalizedCanonical.length > existing.canonical.length) {
      existing.canonical = normalizedCanonical;
    }
  } else {
    file.aliases.push({
      source: normalizedSource,
      canonical: normalizedCanonical,
      addedAt: new Date().toISOString(),
      addedBy: options.addedBy,
      autoLearned: options.autoLearned ?? false,
      occurrences: 1,
    });
  }

  saveAliasFile(COMPETITION_ALIASES_FILE, file);
  competitionAliasCache = null;

  logger.info(
    "Aliases",
    `Added competition alias: "${normalizedSource}" -> "${normalizedCanonical}"`,
  );
}

/**
 * Remove a competition alias.
 */
export function removeCompetitionAlias(source: string): boolean {
  const file = loadAliasFile(COMPETITION_ALIASES_FILE);
  const normalizedSource = source.toLowerCase().trim();
  const idx = file.aliases.findIndex(
    (a) => a.source.toLowerCase() === normalizedSource,
  );

  if (idx === -1) return false;

  file.aliases.splice(idx, 1);
  saveAliasFile(COMPETITION_ALIASES_FILE, file);
  competitionAliasCache = null;

  logger.info("Aliases", `Removed competition alias: "${source}"`);
  return true;
}

// ============================================
// Utilities
// ============================================

/**
 * Clear alias caches (for testing or forced reload).
 */
export function clearAliasCache(): void {
  teamAliasCache = null;
  competitionAliasCache = null;
}

/**
 * Wipe ALL learned aliases — both the on-disk JSON files and the in-memory
 * lookup caches. Used by the Cleanup panel to force a true clean slate
 * when the user wants to rebuild the alias table from scratch.
 *
 * Note: file deletion alone is not enough because the alias store keeps
 * its data on globalThis to survive Next.js hot reloads; the next save
 * would re-write the surviving in-memory data. This function wipes both.
 */
export function clearAllAliases(): { team: number; competition: number } {
  const teamFile = loadAliasFile(TEAM_ALIASES_FILE);
  const compFile = loadAliasFile(COMPETITION_ALIASES_FILE);
  const removed = {
    team: teamFile.aliases.length,
    competition: compFile.aliases.length,
  };

  const empty: AliasFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    aliases: [],
  };
  saveAliasFile(TEAM_ALIASES_FILE, { ...empty });
  saveAliasFile(COMPETITION_ALIASES_FILE, { ...empty });

  teamAliasCache = null;
  competitionAliasCache = null;

  logger.info(
    "AliasStore",
    `Cleared all aliases: ${removed.team} team, ${removed.competition} competition`,
  );
  return removed;
}

/**
 * Get alias statistics.
 */
export function getAliasStats(): {
  teamAliases: number;
  competitionAliases: number;
  autoLearned: number;
  manual: number;
} {
  const teamFile = loadAliasFile(TEAM_ALIASES_FILE);
  const compFile = loadAliasFile(COMPETITION_ALIASES_FILE);

  const allAliases = [...teamFile.aliases, ...compFile.aliases];

  return {
    teamAliases: teamFile.aliases.length,
    competitionAliases: compFile.aliases.length,
    autoLearned: allAliases.filter((a) => a.autoLearned).length,
    manual: allAliases.filter((a) => !a.autoLearned).length,
  };
}

/**
 * Clean up and normalize alias files.
 * - Normalizes direction: shorter → longer (canonical)
 * - Removes vice-versa duplicates
 * - Merges duplicates by summing occurrences
 * - Removes gender-mismatched team aliases (men's vs women's)
 * - Resolves circular conflicts (A→B, B→A or C→A situations)
 */
export function cleanupViceVersaDuplicates(): {
  team: number;
  competition: number;
  genderMismatches: number;
  circularConflicts: number;
} {
  let teamCleaned = 0;
  let compCleaned = 0;
  let genderMismatches = 0;
  let circularConflicts = 0;

  // Helper to resolve circular conflicts in aliases
  // Returns the final canonical for a given name by following the chain
  const resolveCanonical = (
    name: string,
    aliasMap: Map<string, string>,
    visited: Set<string>,
  ): string => {
    if (visited.has(name)) return name; // Cycle detected, stop
    visited.add(name);
    const next = aliasMap.get(name);
    if (next && next !== name) {
      return resolveCanonical(next, aliasMap, visited);
    }
    return name;
  };

  // Helper to normalize and dedupe a competition alias list
  const normalizeAliases = (
    aliases: AliasEntry[],
  ): { cleaned: AliasEntry[]; removed: number; circularRemoved: number } => {
    // First pass: build a map of all aliases
    const aliasMap = new Map<string, string>();
    for (const alias of aliases) {
      let source = alias.source.toLowerCase();
      let canonical = alias.canonical.toLowerCase();
      if (source.length > canonical.length) {
        [source, canonical] = [canonical, source];
      }
      aliasMap.set(source, canonical);
    }

    // Second pass: detect circular conflicts
    // A conflict exists if a canonical is also a source (A→B, B→C) or vice versa (A→B, C→A)
    const canonicals = new Set(Array.from(aliasMap.values()));
    const sources = new Set(Array.from(aliasMap.keys()));

    // Find canonicals that are also sources (chain A→B→C)
    const chainsToResolve = Array.from(canonicals).filter((c) =>
      sources.has(c),
    );

    let circularRemoved = 0;

    // Resolve chains by updating to final canonical
    if (chainsToResolve.length > 0) {
      for (const [source, canonical] of aliasMap.entries()) {
        const finalCanonical = resolveCanonical(canonical, aliasMap, new Set());
        if (finalCanonical !== canonical) {
          aliasMap.set(source, finalCanonical);
          circularRemoved++;
          logger.warn(
            "Aliases",
            `Resolved chain: "${source}" -> "${canonical}" -> "${finalCanonical}"`,
          );
        }
      }
    }

    // Third pass: rebuild cleaned aliases
    const normalized = new Map<string, AliasEntry>();
    let removed = 0;

    for (const alias of aliases) {
      let source = alias.source.toLowerCase();
      let canonical = alias.canonical.toLowerCase();

      // Normalize direction: shorter → longer
      if (source.length > canonical.length) {
        [source, canonical] = [canonical, source];
      }

      // Use resolved canonical if available
      const resolvedCanonical = aliasMap.get(source) || canonical;

      // Skip if source equals canonical after resolution
      if (source === resolvedCanonical) {
        removed++;
        continue;
      }

      const key = `${source}::${resolvedCanonical}`;

      if (normalized.has(key)) {
        // Merge: sum occurrences
        const existing = normalized.get(key)!;
        existing.occurrences += alias.occurrences;
        removed++;
      } else {
        normalized.set(key, {
          ...alias,
          source,
          canonical: resolvedCanonical,
        });
      }
    }

    return {
      cleaned: Array.from(normalized.values()),
      removed,
      circularRemoved,
    };
  };

  // Helper to normalize, dedupe, AND validate gender for team aliases
  const normalizeTeamAliases = (
    aliases: AliasEntry[],
  ): {
    cleaned: AliasEntry[];
    removed: number;
    genderRemoved: number;
    circularRemoved: number;
  } => {
    // First pass: build a map of all aliases
    const aliasMap = new Map<string, string>();
    for (const alias of aliases) {
      let source = alias.source.toLowerCase();
      let canonical = alias.canonical.toLowerCase();
      if (source.length > canonical.length) {
        [source, canonical] = [canonical, source];
      }
      aliasMap.set(source, canonical);
    }

    // Second pass: detect and resolve circular conflicts
    const canonicals = new Set(Array.from(aliasMap.values()));
    const sources = new Set(Array.from(aliasMap.keys()));
    const chainsToResolve = Array.from(canonicals).filter((c) =>
      sources.has(c),
    );

    let circularRemoved = 0;

    if (chainsToResolve.length > 0) {
      for (const [source, canonical] of aliasMap.entries()) {
        const finalCanonical = resolveCanonical(canonical, aliasMap, new Set());
        if (finalCanonical !== canonical) {
          aliasMap.set(source, finalCanonical);
          circularRemoved++;
          logger.warn(
            "Aliases",
            `Resolved chain: "${source}" -> "${canonical}" -> "${finalCanonical}"`,
          );
        }
      }
    }

    // Third pass: rebuild cleaned aliases
    const normalized = new Map<string, AliasEntry>();
    let removed = 0;
    let genderRemoved = 0;

    for (const alias of aliases) {
      let source = alias.source.toLowerCase();
      let canonical = alias.canonical.toLowerCase();

      // Normalize direction: shorter → longer
      if (source.length > canonical.length) {
        [source, canonical] = [canonical, source];
      }

      // Use resolved canonical if available
      const resolvedCanonical = aliasMap.get(source) || canonical;

      // Skip if source equals canonical after resolution
      if (source === resolvedCanonical) {
        removed++;
        continue;
      }

      // Check for gender mismatch (men's vs women's teams)
      if (!isValidTeamAlias(source, resolvedCanonical)) {
        genderRemoved++;
        logger.warn(
          "Aliases",
          `Removing gender-mismatched alias: "${source}" -> "${resolvedCanonical}"`,
        );
        continue; // Skip this alias entirely
      }

      const key = `${source}::${resolvedCanonical}`;

      if (normalized.has(key)) {
        // Merge: sum occurrences
        const existing = normalized.get(key)!;
        existing.occurrences += alias.occurrences;
        removed++;
      } else {
        normalized.set(key, {
          ...alias,
          source,
          canonical: resolvedCanonical,
        });
      }
    }

    return {
      cleaned: Array.from(normalized.values()),
      removed,
      genderRemoved,
      circularRemoved,
    };
  };

  // Clean team aliases (with gender validation)
  const teamFile = loadAliasFile(TEAM_ALIASES_FILE);
  const teamResult = normalizeTeamAliases(teamFile.aliases);
  teamCleaned = teamResult.removed;
  genderMismatches = teamResult.genderRemoved;
  circularConflicts += teamResult.circularRemoved;

  if (
    teamCleaned > 0 ||
    genderMismatches > 0 ||
    teamResult.circularRemoved > 0
  ) {
    teamFile.aliases = teamResult.cleaned;
    saveAliasFile(TEAM_ALIASES_FILE, teamFile);
    teamAliasCache = null;
    if (teamCleaned > 0) {
      logger.info(
        "Aliases",
        `Cleaned up ${teamCleaned} team alias entries (normalized direction, merged duplicates)`,
      );
    }
    if (genderMismatches > 0) {
      logger.info(
        "Aliases",
        `Removed ${genderMismatches} gender-mismatched team aliases`,
      );
    }
    if (teamResult.circularRemoved > 0) {
      logger.info(
        "Aliases",
        `Resolved ${teamResult.circularRemoved} circular/chain conflicts in team aliases`,
      );
    }
  }

  // Clean competition aliases (no gender validation needed)
  const compFile = loadAliasFile(COMPETITION_ALIASES_FILE);
  const compResult = normalizeAliases(compFile.aliases);
  compCleaned = compResult.removed;
  circularConflicts += compResult.circularRemoved;

  if (compCleaned > 0 || compResult.circularRemoved > 0) {
    compFile.aliases = compResult.cleaned;
    saveAliasFile(COMPETITION_ALIASES_FILE, compFile);
    competitionAliasCache = null;
    if (compCleaned > 0) {
      logger.info(
        "Aliases",
        `Cleaned up ${compCleaned} competition alias entries (normalized direction, merged duplicates)`,
      );
    }
    if (compResult.circularRemoved > 0) {
      logger.info(
        "Aliases",
        `Resolved ${compResult.circularRemoved} circular/chain conflicts in competition aliases`,
      );
    }
  }

  return {
    team: teamCleaned,
    competition: compCleaned,
    genderMismatches,
    circularConflicts,
  };
}
