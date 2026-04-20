/**
 * Near-Match Store
 *
 * File-based store for near-matches (pairs that almost matched).
 * Used for diagnostics and alias learning.
 *
 * Persists to disk to ensure data survives across API route contexts.
 */

import fs from "fs";
import path from "path";
import { logger } from "../../shared/logger";
import type { NearMatch, DiagnosticStats, FailurePattern } from "./types";
import {
  MAX_NEAR_MATCHES,
  NEAR_MATCH_MAX_AGE_MS,
  NearMatchSchema,
} from "./types";
import { computePairKey } from "../ai-decision-cache";
import { applyTeamAlias, applyCompetitionAlias } from "../normalize";

// ============================================
// File Storage Path
// ============================================

const DATA_DIR = path.join(process.cwd(), "rawData");
const STORE_FILE = path.join(DATA_DIR, "near-matches.json");

// ============================================
// Store State (in-memory cache + file persistence)
// ============================================

interface DiagnosticsStoreData {
  nearMatches: Record<string, NearMatch>;
  lastAnalysis: string | null;
  patterns: FailurePattern[];
  version: number;
}

// In-memory cache - use globalThis to survive Next.js hot reloads
interface DiagnosticsCache {
  nearMatches: Map<string, NearMatch>;
  lastAnalysis: Date | null;
  patterns: FailurePattern[];
  loaded: boolean;
  fileVersion: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __diagnosticsCache: DiagnosticsCache | undefined;
}

function getCache(): DiagnosticsCache {
  if (!globalThis.__diagnosticsCache) {
    globalThis.__diagnosticsCache = {
      nearMatches: new Map(),
      lastAnalysis: null,
      patterns: [],
      loaded: false,
      fileVersion: 0,
    };
  }
  return globalThis.__diagnosticsCache;
}

// Alias for backward compatibility (used throughout this file)
const cache = new Proxy({} as DiagnosticsCache, {
  get(_, prop) {
    return getCache()[prop as keyof DiagnosticsCache];
  },
  set(_, prop, value) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (getCache() as any)[prop as string] = value;
    return true;
  },
});

// ============================================
// File Operations
// ============================================

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadFromFile(): void {
  try {
    if (!fs.existsSync(STORE_FILE)) {
      cache.loaded = true;
      return;
    }

    const raw = fs.readFileSync(STORE_FILE, "utf-8");
    const data: DiagnosticsStoreData = JSON.parse(raw);

    // Only reload if file version changed
    if (data.version === cache.fileVersion && cache.loaded) {
      return;
    }

    // Parse near-matches with date conversion
    cache.nearMatches = new Map();
    for (const [id, nm] of Object.entries(data.nearMatches)) {
      try {
        // Convert string dates back to Date objects
        const parsed: NearMatch = {
          ...nm,
          eventA: {
            ...nm.eventA,
            startTime: new Date(nm.eventA.startTime),
          },
          eventB: {
            ...nm.eventB,
            startTime: new Date(nm.eventB.startTime),
          },
          detectedAt: new Date(nm.detectedAt),
          confirmedAt: nm.confirmedAt ? new Date(nm.confirmedAt) : undefined,
        };
        cache.nearMatches.set(id, parsed);
      } catch {
        // Skip invalid entries
      }
    }

    cache.lastAnalysis = data.lastAnalysis ? new Date(data.lastAnalysis) : null;
    cache.patterns = data.patterns || [];
    cache.fileVersion = data.version || 0;
    cache.loaded = true;
  } catch (error) {
    logger.warn(
      "Diagnostics",
      `Failed to load store: ${(error as Error).message}`,
    );
    cache.loaded = true;
  }
}

function saveToFile(): void {
  try {
    ensureDataDir();

    // Convert Map to object for JSON serialization
    const nearMatchesObj: Record<string, NearMatch> = {};
    for (const [id, nm] of cache.nearMatches) {
      nearMatchesObj[id] = nm;
    }

    const data: DiagnosticsStoreData = {
      nearMatches: nearMatchesObj,
      lastAnalysis: cache.lastAnalysis?.toISOString() || null,
      patterns: cache.patterns,
      version: cache.fileVersion + 1,
    };

    fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
    cache.fileVersion = data.version;
  } catch (error) {
    logger.error(
      "Diagnostics",
      `Failed to save store: ${(error as Error).message}`,
    );
  }
}

// Auto-save debounce
let saveTimeout: NodeJS.Timeout | null = null;
function scheduleSave(): void {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }
  saveTimeout = setTimeout(() => {
    saveToFile();
    saveTimeout = null;
  }, 500);
}

function getStore() {
  if (!cache.loaded) {
    loadFromFile();
  }
  return cache;
}

/**
 * Force reload from file (for when we need fresh data)
 */
export function forceReloadStore(): void {
  cache.loaded = false;
  cache.fileVersion = -1; // Reset version to force full reload
  loadFromFile();
}

// ============================================
// Near-Match Operations
// ============================================

/**
 * Compute the canonical pair key for a near-match so we can dedupe entries
 * that describe the same real-world pairing (provider APIs sometimes rotate
 * internal event IDs between syncs, which would otherwise create new entries
 * for the identical fixture pair).
 */
function canonicalKeyFor(nm: NearMatch): string {
  return computePairKey(
    {
      homeTeam: nm.eventA.homeTeam,
      awayTeam: nm.eventA.awayTeam,
      competition: nm.eventA.competition,
    },
    {
      homeTeam: nm.eventB.homeTeam,
      awayTeam: nm.eventB.awayTeam,
      competition: nm.eventB.competition,
    },
    { team: applyTeamAlias, competition: applyCompetitionAlias },
  );
}

/**
 * Add a near-match to the store.
 * Dedupes by canonical pair key (team + league identity) so the list never
 * contains multiple rows for the same real fixture pairing. Enforces max
 * capacity by removing oldest pending entries.
 */
export function addNearMatch(nearMatch: NearMatch): void {
  const store = getStore();

  // Internal-ID duplicate
  if (store.nearMatches.has(nearMatch.id)) {
    return;
  }

  // Canonical-pair duplicate: a different store entry already describes this
  // fixture pair. Replace it only if the new one has a better score OR the
  // existing one is stale (older than 1 hour). This keeps the store sized
  // to real distinct pairs rather than ballooning with re-sync churn.
  const newKey = canonicalKeyFor(nearMatch);
  for (const [id, existing] of store.nearMatches) {
    if (existing.status !== "pending") continue;
    if (canonicalKeyFor(existing) !== newKey) continue;

    const STALE_MS = 60 * 60 * 1000;
    const isStale = Date.now() - existing.detectedAt.getTime() > STALE_MS;
    const betterScore =
      nearMatch.breakdown.finalScore > existing.breakdown.finalScore;
    if (betterScore || isStale) {
      store.nearMatches.delete(id);
      break;
    } else {
      return; // existing is at least as good and not stale — keep it
    }
  }

  // Enforce capacity limit - remove oldest pending entries
  if (store.nearMatches.size >= MAX_NEAR_MATCHES) {
    const pendingByAge = Array.from(store.nearMatches.entries())
      .filter(([, nm]) => nm.status === "pending")
      .sort(([, a], [, b]) => a.detectedAt.getTime() - b.detectedAt.getTime());

    if (pendingByAge.length > 0) {
      store.nearMatches.delete(pendingByAge[0][0]);
    } else {
      // All are confirmed/rejected - remove oldest overall
      const oldest = Array.from(store.nearMatches.entries()).sort(
        ([, a], [, b]) => a.detectedAt.getTime() - b.detectedAt.getTime(),
      )[0];
      if (oldest) store.nearMatches.delete(oldest[0]);
    }
  }

  store.nearMatches.set(nearMatch.id, nearMatch);
  scheduleSave();
}

/**
 * Get all near-matches, optionally filtered.
 */
export function getNearMatches(filter?: {
  status?: NearMatch["status"];
  minScore?: number;
  provider?: string;
}): NearMatch[] {
  const store = getStore();
  let results = Array.from(store.nearMatches.values());

  if (filter?.status) {
    results = results.filter((nm) => nm.status === filter.status);
  }

  if (filter?.minScore !== undefined) {
    const minScore = filter.minScore;
    results = results.filter((nm) => nm.breakdown.finalScore >= minScore);
  }

  if (filter?.provider) {
    results = results.filter(
      (nm) =>
        nm.eventA.provider === filter.provider ||
        nm.eventB.provider === filter.provider,
    );
  }

  // Sort by score descending (highest potential matches first)
  return results.sort(
    (a, b) => b.breakdown.finalScore - a.breakdown.finalScore,
  );
}

/**
 * Get a single near-match by ID.
 */
export function getNearMatchById(id: string): NearMatch | undefined {
  return getStore().nearMatches.get(id);
}

/**
 * Update near-match status (for manual confirmation/rejection).
 */
export function updateNearMatchStatus(
  id: string,
  status: "confirmed" | "rejected",
  userId?: string,
): NearMatch | null {
  const store = getStore();
  const nearMatch = store.nearMatches.get(id);
  if (!nearMatch) return null;

  nearMatch.status = status;
  nearMatch.confirmedAt = new Date();
  nearMatch.confirmedBy = userId;

  logger.info(
    "Diagnostics",
    `Near-match ${id} ${status} by ${userId || "system"}`,
  );

  scheduleSave();
  return nearMatch;
}

/**
 * Remove old pending near-matches.
 * Keeps confirmed/rejected for audit trail.
 */
export function pruneOldNearMatches(
  maxAgeMs: number = NEAR_MATCH_MAX_AGE_MS,
): number {
  const store = getStore();
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;

  for (const [id, nm] of store.nearMatches) {
    if (nm.detectedAt.getTime() < cutoff && nm.status === "pending") {
      store.nearMatches.delete(id);
      removed++;
    }
  }

  if (removed > 0) {
    logger.debug("Diagnostics", `Pruned ${removed} old near-matches`);
    scheduleSave();
  }

  return removed;
}

/**
 * Clear all near-matches (for testing).
 */
export function clearNearMatches(): void {
  const store = getStore();
  store.nearMatches.clear();
  store.patterns = [];
  store.lastAnalysis = null;
  scheduleSave();
}

// ============================================
// Pattern Operations
// ============================================

/**
 * Set detected failure patterns.
 */
export function setPatterns(patterns: FailurePattern[]): void {
  const store = getStore();
  store.patterns = patterns;
  store.lastAnalysis = new Date();
  scheduleSave();
}

/**
 * Get current failure patterns.
 */
export function getPatterns(): FailurePattern[] {
  return getStore().patterns;
}

// ============================================
// Statistics
// ============================================

/**
 * Get diagnostic statistics.
 */
export function getDiagnosticStats(): DiagnosticStats {
  const store = getStore();
  const nearMatches = Array.from(store.nearMatches.values());

  const pending = nearMatches.filter((nm) => nm.status === "pending").length;
  const confirmed = nearMatches.filter(
    (nm) => nm.status === "confirmed",
  ).length;
  const rejected = nearMatches.filter((nm) => nm.status === "rejected").length;

  const avgScore =
    nearMatches.length > 0
      ? nearMatches.reduce((sum, nm) => sum + nm.breakdown.finalScore, 0) /
        nearMatches.length
      : 0;

  return {
    totalNearMatches: nearMatches.length,
    pending,
    confirmed,
    rejected,
    avgScore,
    lastAnalysis: store.lastAnalysis,
    patterns: store.patterns,
  };
}

/**
 * Get count of pending near-matches.
 */
export function getPendingCount(): number {
  const store = getStore();
  let count = 0;
  for (const nm of store.nearMatches.values()) {
    if (nm.status === "pending") count++;
  }
  return count;
}
