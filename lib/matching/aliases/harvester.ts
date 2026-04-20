/**
 * Proactive Alias Harvester
 *
 * Learns aliases from high-confidence auto-matches.
 * When events match at 85%+, name differences are extracted and staged.
 * After 3+ consistent appearances, staged candidates are promoted to real aliases.
 *
 * Flow:
 * 1. harvestFromMatchPair() — called when a match is confirmed
 * 2. promoteStagedAliases() — called at end of matchEvents()
 */

import * as fs from "fs";
import * as path from "path";
import type { NormalizedEvent } from "../../types";
import type { PreNormalizedNames } from "../normalize";
import { cachedCompareTwoStrings } from "../similarity-cache";
import { getMatchingConfig } from "../config";
import { addTeamAlias, addCompetitionAlias, clearAliasCache } from "./store";
import { hasGroupConflict } from "./group-guard";
import { resetMatchCache } from "../match-cache";
import { logger } from "../../shared/logger";

// ============================================
// Types
// ============================================

export interface HarvestCandidate {
  source: string;
  canonical: string;
  type: "team" | "competition";
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  providerPairs: string[];
}

interface StagingFile {
  version: number;
  updatedAt: string;
  candidates: HarvestCandidate[];
}

// ============================================
// File Paths
// ============================================

const STAGING_DIR = path.join(process.cwd(), "data", "aliases");
const STAGING_FILE = path.join(STAGING_DIR, "harvest-staging.json");

// ============================================
// Gender Validation (inlined from store.ts)
// ============================================

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

// ============================================
// Staging File I/O
// ============================================

function ensureStagingDir(): void {
  if (!fs.existsSync(STAGING_DIR)) {
    fs.mkdirSync(STAGING_DIR, { recursive: true });
  }
}

function loadStagingFile(): StagingFile {
  if (!fs.existsSync(STAGING_FILE)) {
    return { version: 1, updatedAt: new Date().toISOString(), candidates: [] };
  }

  try {
    const raw = fs.readFileSync(STAGING_FILE, "utf-8");
    return JSON.parse(raw) as StagingFile;
  } catch {
    logger.warn("Harvester", "Failed to load staging file, starting fresh");
    return { version: 1, updatedAt: new Date().toISOString(), candidates: [] };
  }
}

function saveStagingFile(data: StagingFile): void {
  ensureStagingDir();
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(STAGING_FILE, JSON.stringify(data, null, 2));
}

// ============================================
// Candidate Key
// ============================================

function candidateKey(
  type: "team" | "competition",
  source: string,
  canonical: string,
): string {
  return `${type}:${source}:${canonical}`;
}

// ============================================
// In-Memory Staging (flushed periodically)
// ============================================

// Buffer harvested pairs in memory during a single matchEvents() call,
// then flush to disk once at promotion time to avoid repeated file I/O.
let pendingCandidates: Map<string, HarvestCandidate> = new Map();
let stagingLoaded = false;
let stagingData: StagingFile | null = null;

function getStagingData(): StagingFile {
  if (!stagingLoaded) {
    stagingData = loadStagingFile();
    // Index existing candidates into the pending map
    for (const c of stagingData.candidates) {
      const key = candidateKey(c.type, c.source, c.canonical);
      pendingCandidates.set(key, { ...c });
    }
    stagingLoaded = true;
  }
  return stagingData!;
}

function flushStagingData(): void {
  if (!stagingLoaded) return;
  const data: StagingFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    candidates: Array.from(pendingCandidates.values()),
  };
  saveStagingFile(data);
  // Reset in-memory state so next cycle reloads from disk
  stagingLoaded = false;
  stagingData = null;
  pendingCandidates = new Map();
}

// ============================================
// Core: Add a candidate to staging
// ============================================

function stageCandidate(
  source: string,
  canonical: string,
  type: "team" | "competition",
  providerPair: string,
): void {
  // Ensure staging is loaded
  getStagingData();

  // Normalize direction: shorter name as source, longer as canonical
  let normSource = source.toLowerCase().trim();
  let normCanonical = canonical.toLowerCase().trim();

  if (normSource.length > normCanonical.length) {
    [normSource, normCanonical] = [normCanonical, normSource];
  }

  // Skip identical
  if (normSource === normCanonical) return;

  // Both names must be >= 3 chars
  if (normSource.length < 3 || normCanonical.length < 3) return;

  const key = candidateKey(type, normSource, normCanonical);
  const existing = pendingCandidates.get(key);

  if (existing) {
    existing.occurrences++;
    existing.lastSeen = new Date().toISOString();
    if (!existing.providerPairs.includes(providerPair)) {
      existing.providerPairs.push(providerPair);
    }
  } else {
    const now = new Date().toISOString();
    pendingCandidates.set(key, {
      source: normSource,
      canonical: normCanonical,
      type,
      occurrences: 1,
      firstSeen: now,
      lastSeen: now,
      providerPairs: [providerPair],
    });
  }
}

// ============================================
// Public API
// ============================================

/**
 * Called in findMatchesInGroup() when a match is confirmed.
 * Extracts name differences between the two events and stages them as alias candidates.
 */
export function harvestFromMatchPair(
  eventA: NormalizedEvent,
  eventB: NormalizedEvent,
  preNormA: PreNormalizedNames,
  preNormB: PreNormalizedNames,
): void {
  const config = getMatchingConfig();
  if (!config.aliasHarvesting.enabled) return;

  // Get provider names for the provider pair key
  const providerA = Object.keys(eventA.providers)[0] || "unknown";
  const providerB = Object.keys(eventB.providers)[0] || "unknown";
  const providerPair = [providerA, providerB].sort().join("|");

  // Determine orientation: are home/away swapped between providers?
  const normalScore =
    (cachedCompareTwoStrings(preNormA.home, preNormB.home) +
      cachedCompareTwoStrings(preNormA.away, preNormB.away)) /
    2;
  const swappedScore =
    (cachedCompareTwoStrings(preNormA.home, preNormB.away) +
      cachedCompareTwoStrings(preNormA.away, preNormB.home)) /
    2;
  const isSwapped = swappedScore > normalScore;

  // Process team name pairs
  const pairs: Array<{ nameA: string; nameB: string }> = isSwapped
    ? [
        { nameA: preNormA.home, nameB: preNormB.away },
        { nameA: preNormA.away, nameB: preNormB.home },
      ]
    : [
        { nameA: preNormA.home, nameB: preNormB.home },
        { nameA: preNormA.away, nameB: preNormB.away },
      ];

  for (const { nameA, nameB } of pairs) {
    // Skip if names are identical after normalization
    if (nameA === nameB) continue;

    const dice = cachedCompareTwoStrings(nameA, nameB);

    // Skip if too similar (just noise, e.g. trailing whitespace differences)
    if (dice > 0.97) continue;

    // Skip if too different (not actually the same team)
    if (dice < 0.3) continue;

    stageCandidate(nameA, nameB, "team", providerPair);
  }

  // Process competition names
  if (preNormA.competition !== preNormB.competition) {
    const compDice = cachedCompareTwoStrings(
      preNormA.competition,
      preNormB.competition,
    );

    if (compDice <= 0.97 && compDice >= 0.3) {
      // Never stage an alias that would merge distinct sub-groups
      // (e.g. Serie C Group A ↔ Group B, or "Serie C" ↔ "Serie C Group A").
      // See lib/matching/aliases/group-guard.ts for rationale.
      if (hasGroupConflict(preNormA.competition, preNormB.competition)) {
        return;
      }
      stageCandidate(
        preNormA.competition,
        preNormB.competition,
        "competition",
        providerPair,
      );
    }
  }
}

/**
 * Called at end of matchEvents() to promote candidates that meet the occurrence threshold.
 * Returns counts of promoted team and competition aliases.
 */
export function promoteStagedAliases(): {
  team: number;
  competition: number;
} {
  const config = getMatchingConfig();
  if (!config.aliasHarvesting.enabled) {
    return { team: 0, competition: 0 };
  }

  // Ensure staging is loaded (may have been populated by harvestFromMatchPair calls)
  getStagingData();

  const minOccurrences = config.aliasHarvesting.minOccurrences;
  let teamPromoted = 0;
  let compPromoted = 0;
  const keysToRemove: string[] = [];

  for (const [key, candidate] of pendingCandidates) {
    if (candidate.occurrences < minOccurrences) continue;

    // Validate: both names must be >= 3 chars
    if (candidate.source.length < 3 || candidate.canonical.length < 3) {
      keysToRemove.push(key);
      continue;
    }

    if (candidate.type === "team") {
      // Validate: no gender mismatch
      if (
        isWomensTeam(candidate.source) !== isWomensTeam(candidate.canonical)
      ) {
        logger.warn(
          "Harvester",
          `Rejecting gender-mismatched candidate: "${candidate.source}" -> "${candidate.canonical}"`,
        );
        keysToRemove.push(key);
        continue;
      }

      addTeamAlias(candidate.source, candidate.canonical, {
        autoLearned: true,
        addedBy: "harvester",
      });
      teamPromoted++;
      keysToRemove.push(key);

      logger.info(
        "Harvester",
        `Promoted team alias: "${candidate.source}" -> "${candidate.canonical}" (${candidate.occurrences} occurrences)`,
      );
    } else {
      addCompetitionAlias(candidate.source, candidate.canonical, {
        autoLearned: true,
        addedBy: "harvester",
      });
      compPromoted++;
      keysToRemove.push(key);

      logger.info(
        "Harvester",
        `Promoted competition alias: "${candidate.source}" -> "${candidate.canonical}" (${candidate.occurrences} occurrences)`,
      );
    }
  }

  // Remove promoted/rejected candidates from staging
  for (const key of keysToRemove) {
    pendingCandidates.delete(key);
  }

  // Flush staging to disk
  flushStagingData();

  // If any aliases were promoted, invalidate caches so next matching cycle uses them
  if (teamPromoted > 0 || compPromoted > 0) {
    resetMatchCache();
    clearAliasCache();
    logger.info(
      "Harvester",
      `Promoted ${teamPromoted} team + ${compPromoted} competition aliases`,
    );
  }

  return { team: teamPromoted, competition: compPromoted };
}

/**
 * Get current staging candidates (for admin UI).
 */
export function getHarvestCandidates(): HarvestCandidate[] {
  const data = loadStagingFile();
  return data.candidates;
}

/**
 * Clear all staging data (for admin reset).
 */
export function clearHarvestStaging(): void {
  pendingCandidates = new Map();
  stagingLoaded = false;
  stagingData = null;

  if (fs.existsSync(STAGING_FILE)) {
    const empty: StagingFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      candidates: [],
    };
    saveStagingFile(empty);
  }

  logger.info("Harvester", "Staging data cleared");
}
