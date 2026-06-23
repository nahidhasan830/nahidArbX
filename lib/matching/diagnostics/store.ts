import fs from "fs";
import path from "path";
import { logger } from "../../shared/logger";
import type { NearMatch, DiagnosticStats, FailurePattern } from "./types";
import { MAX_NEAR_MATCHES, NEAR_MATCH_MAX_AGE_MS } from "./types";
import { computePairKey } from "../pair-key";
import { applyTeamAlias, applyCompetitionAlias } from "../normalize";

const DATA_DIR = path.join(process.cwd(), "rawData");
const STORE_FILE = path.join(DATA_DIR, "near-matches.json");

interface DiagnosticsStoreData {
  nearMatches: Record<string, NearMatch>;
  lastAnalysis: string | null;
  patterns: FailurePattern[];
  version: number;
}

interface DiagnosticsCache {
  nearMatches: Map<string, NearMatch>;
  lastAnalysis: Date | null;
  patterns: FailurePattern[];
  loaded: boolean;
  fileVersion: number;
}

declare global {
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

const cache = new Proxy({} as DiagnosticsCache, {
  get(_, prop) {
    return getCache()[prop as keyof DiagnosticsCache];
  },
  set(_, prop, value) {
    Reflect.set(getCache(), prop, value);
    return true;
  },
});

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

    if (data.version === cache.fileVersion && cache.loaded) {
      return;
    }

    cache.nearMatches = new Map();
    for (const [id, nm] of Object.entries(data.nearMatches)) {
      try {
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

export function forceReloadStore(): void {
  cache.loaded = false;
  cache.fileVersion = -1;
  loadFromFile();
}

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

export function addNearMatch(nearMatch: NearMatch): void {
  const store = getStore();

  if (store.nearMatches.has(nearMatch.id)) {
    return;
  }

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
      return;
    }
  }

  if (store.nearMatches.size >= MAX_NEAR_MATCHES) {
    const pendingByAge = Array.from(store.nearMatches.entries())
      .filter(([, nm]) => nm.status === "pending")
      .sort(([, a], [, b]) => a.detectedAt.getTime() - b.detectedAt.getTime());

    if (pendingByAge.length > 0) {
      store.nearMatches.delete(pendingByAge[0][0]);
    } else {
      const oldest = Array.from(store.nearMatches.entries()).sort(
        ([, a], [, b]) => a.detectedAt.getTime() - b.detectedAt.getTime(),
      )[0];
      if (oldest) store.nearMatches.delete(oldest[0]);
    }
  }

  store.nearMatches.set(nearMatch.id, nearMatch);
  scheduleSave();
}

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

  return results.sort(
    (a, b) => b.breakdown.finalScore - a.breakdown.finalScore,
  );
}

export function getNearMatchById(id: string): NearMatch | undefined {
  return getStore().nearMatches.get(id);
}

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

export function clearNearMatches(): void {
  const store = getStore();
  store.nearMatches.clear();
  store.patterns = [];
  store.lastAnalysis = null;
  scheduleSave();
}

export function setPatterns(patterns: FailurePattern[]): void {
  const store = getStore();
  store.patterns = patterns;
  store.lastAnalysis = new Date();
  scheduleSave();
}

export function getPatterns(): FailurePattern[] {
  return getStore().patterns;
}

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

export function getPendingCount(): number {
  const store = getStore();
  let count = 0;
  for (const nm of store.nearMatches.values()) {
    if (nm.status === "pending") count++;
  }
  return count;
}
