
import * as fs from "fs";
import * as path from "path";
import { logger } from "../shared/logger";
import { computePairKey, type EventFingerprintInput } from "./pair-key";

export { computePairKey, type EventFingerprintInput };

const FILE = path.join(
  process.cwd(),
  "data",
  "gemini",
  "ai-decision-cache.json",
);

export type DecidedBy = "gemini" | "human" | "matcher";

export interface DecisionSnapshotSide {
  provider: string;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  startTime: string;
}

export interface CachedDecision {
  key: string;
  verdict: "SAME" | "DIFFERENT" | "UNCERTAIN";
  confidence: number;
  decidedBy: DecidedBy;
  decidedAt: string;
  sources: { url: string; title: string }[];
  model?: string;
  by?: string;
  snapshot?: { eventA: DecisionSnapshotSide; eventB: DecisionSnapshotSide };
}


interface CacheFile {
  version: number;
  decisions: Record<string, CachedDecision>;
}

declare global {
  var __aiDecisionCache: Map<string, CachedDecision> | undefined;
  var __aiDecisionCacheLoaded: boolean | undefined;
}

function getStore(): Map<string, CachedDecision> {
  if (!globalThis.__aiDecisionCache) {
    globalThis.__aiDecisionCache = new Map();
  }
  if (!globalThis.__aiDecisionCacheLoaded) {
    loadFromDisk();
  }
  return globalThis.__aiDecisionCache;
}

function loadFromDisk(): void {
  globalThis.__aiDecisionCacheLoaded = true;
  try {
    if (!fs.existsSync(FILE)) return;
    const raw = fs.readFileSync(FILE, "utf-8");
    const parsed: CacheFile = JSON.parse(raw);
    const store = globalThis.__aiDecisionCache!;
    store.clear();
    for (const [key, value] of Object.entries(parsed.decisions || {})) {
      store.set(key, value);
    }
    logger.info("AICache", `Loaded ${store.size} cached decisions`);
  } catch (err) {
    logger.warn("AICache", `Failed to load: ${(err as Error).message}`);
  }
}

let saveTimer: NodeJS.Timeout | null = null;
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveToDisk, 500);
}

function saveToDisk(): void {
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const store = getStore();
    const obj: Record<string, CachedDecision> = {};
    for (const [k, v] of store) obj[k] = v;
    const body: CacheFile = { version: 2, decisions: obj };
    fs.writeFileSync(FILE, JSON.stringify(body, null, 2));
  } catch (err) {
    logger.error("AICache", `Failed to save: ${(err as Error).message}`);
  }
}


export function getCachedDecision(key: string): CachedDecision | undefined {
  return getStore().get(key);
}

export const AI_AUTONOMOUS_THRESHOLD = (() => {
  const envVal = Number(process.env.AI_AUTONOMOUS_THRESHOLD);
  return Number.isFinite(envVal) && envVal >= 0 && envVal <= 100 ? envVal : 70;
})();

export function isPairResolved(key: string): boolean {
  return getStore().has(key);
}

export function saveAIDecision(params: {
  key: string;
  verdict: CachedDecision["verdict"];
  confidence: number;
  model?: string;
  sources?: { url: string; title: string }[];
  snapshot?: CachedDecision["snapshot"];
}): CachedDecision {
  const store = getStore();
  const existing = store.get(params.key);
  const entry: CachedDecision = {
    key: params.key,
    verdict: params.verdict,
    confidence: Math.max(0, Math.min(100, params.confidence)),
    decidedBy: "gemini",
    decidedAt: new Date().toISOString(),
    sources: params.sources || [],
    model: params.model,
    snapshot: params.snapshot ?? existing?.snapshot,
  };
  store.set(params.key, entry);
  scheduleSave();
  return entry;
}

export function saveHumanVerdict(
  key: string,
  verdict: "approved" | "rejected",
  by?: string,
  snapshot?: CachedDecision["snapshot"],
): CachedDecision {
  const existing = getStore().get(key);
  const entry: CachedDecision = {
    key,
    verdict: verdict === "approved" ? "SAME" : "DIFFERENT",
    confidence: 100,
    decidedBy: "human",
    decidedAt: new Date().toISOString(),
    sources: [],
    by,
    snapshot: snapshot ?? existing?.snapshot,
  };
  getStore().set(key, entry);
  scheduleSave();
  return entry;
}

export function deleteDecision(key: string): boolean {
  const ok = getStore().delete(key);
  if (ok) scheduleSave();
  return ok;
}

export function listDecisions(): CachedDecision[] {
  return Array.from(getStore().values());
}

export function clearAllDecisions(): void {
  getStore().clear();
  scheduleSave();
}

export function getCacheStats(): {
  total: number;
  byDecider: Record<DecidedBy, number>;
  byVerdict: Record<CachedDecision["verdict"], number>;
  humanApproved: number;
  humanRejected: number;
} {
  const stats = {
    total: 0,
    byDecider: { gemini: 0, human: 0, matcher: 0 } as Record<DecidedBy, number>,
    byVerdict: { SAME: 0, DIFFERENT: 0, UNCERTAIN: 0 } as Record<
      CachedDecision["verdict"],
      number
    >,
    humanApproved: 0,
    humanRejected: 0,
  };
  for (const d of getStore().values()) {
    stats.total++;
    stats.byDecider[d.decidedBy]++;
    stats.byVerdict[d.verdict]++;
    if (d.decidedBy === "human" && d.verdict === "SAME") stats.humanApproved++;
    if (d.decidedBy === "human" && d.verdict === "DIFFERENT")
      stats.humanRejected++;
  }
  return stats;
}
