/**
 * AI Decision Cache
 *
 * Persists verdicts for event pairs keyed by a stable canonical fingerprint
 * (team + league canonicals from the alias table — see `computePairKey`).
 * The matcher consults this cache before generating near-match rows, and
 * the match-review route consults it before spending AI quota on a pair.
 *
 * A pair has at most ONE cached entry. The entry always reflects the CURRENT
 * verdict — who decided, what they decided, why. When a human overrides an
 * earlier AI verdict the entry is fully replaced (not shadowed): `decidedBy`
 * becomes `"human"` and the AI's reasoning is gone. Delete removes the
 * entry so the pair re-surfaces on the next sync for fresh review.
 */

import * as fs from "fs";
import * as path from "path";
import { logger } from "../shared/logger";

const FILE = path.join(
  process.cwd(),
  "data",
  "gemini",
  "ai-decision-cache.json",
);

/** Provenance of a cached verdict. `matcher` is synthesized at read time for
 * auto-merges driven purely by string-similarity (no AI / human involved) —
 * it is NEVER persisted to the cache file. */
export type DecidedBy = "gemini" | "human" | "matcher";

/** Event-side snapshot stored alongside a cached decision so the Decided
 * tab can render the pair (teams/providers/time) even after sync rotation
 * removes the underlying events from the live store. */
export interface DecisionSnapshotSide {
  provider: string;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  startTime: string;
}

/** A single cached verdict — one entry per canonical pair. */
export interface CachedDecision {
  key: string;
  /** The verdict itself. */
  verdict: "SAME" | "DIFFERENT" | "UNCERTAIN";
  /** 0-100. Always 100 for human verdicts (human is authoritative). */
  confidence: number;
  /** Free-form explanation — AI reasoning or human note. */
  reasoning: string;
  /** Who decided. */
  decidedBy: DecidedBy;
  /** ISO timestamp of the verdict. */
  decidedAt: string;
  /** AI-cited sources (empty array for human verdicts). */
  sources: { url: string; title: string }[];
  /** Model ID for AI verdicts; undefined for human. */
  model?: string;
  /** User id for human verdicts; undefined for AI. */
  by?: string;
  /** Frozen snapshot of the pair at decision time. Optional for backward
   * compatibility with entries saved before this field existed. */
  snapshot?: { eventA: DecisionSnapshotSide; eventB: DecisionSnapshotSide };
}

export interface EventFingerprintInput {
  homeTeam: string;
  awayTeam: string;
  competition: string;
}

// ============================================
// Key derivation
// ============================================

/**
 * Compute the canonical identity of a single event side.
 *
 * Teams are alphabetized so "Home=A, Away=B" and "Home=B, Away=A" collapse
 * to the same identity — we don't care which side is home when deciding
 * whether two fixtures describe the same real-world match.
 *
 * Time is NOT part of the key: the matcher already groups events into
 * 1-minute buckets before scoring, so any pair we compare is at the same
 * minute by construction. Adding time would wrongly separate decisions
 * across fixture dates.
 */
function sideIdentity(
  e: EventFingerprintInput,
  aliasTeam: (s: string) => string,
  aliasComp: (s: string) => string,
): string {
  const teams = [aliasTeam(e.homeTeam), aliasTeam(e.awayTeam)].sort();
  return `${teams[0]}|${teams[1]}|${aliasComp(e.competition)}`;
}

/**
 * Compute a stable, order-independent cache key for a pair of events.
 */
export function computePairKey(
  a: EventFingerprintInput,
  b: EventFingerprintInput,
  alias: {
    team: (s: string) => string;
    competition: (s: string) => string;
  },
): string {
  const sideA = sideIdentity(a, alias.team, alias.competition);
  const sideB = sideIdentity(b, alias.team, alias.competition);
  return sideA < sideB ? `${sideA}::${sideB}` : `${sideB}::${sideA}`;
}

// ============================================
// Persistence
// ============================================

interface CacheFile {
  version: number;
  decisions: Record<string, CachedDecision>;
}

declare global {
  // eslint-disable-next-line no-var
  var __aiDecisionCache: Map<string, CachedDecision> | undefined;
  // eslint-disable-next-line no-var
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

// ============================================
// Public API
// ============================================

export function getCachedDecision(key: string): CachedDecision | undefined {
  return getStore().get(key);
}

/**
 * Confidence threshold for auto-merging an AI SAME verdict. Below this,
 * the verdict still counts as "decided" (the pair leaves To Review) but no
 * merge happens until a human approves.
 *
 * Configurable via env `AI_AUTONOMOUS_THRESHOLD`. Set to `0` for full trust
 * (every SAME verdict auto-merges regardless of confidence).
 */
export const AI_AUTONOMOUS_THRESHOLD = (() => {
  const envVal = Number(process.env.AI_AUTONOMOUS_THRESHOLD);
  return Number.isFinite(envVal) && envVal >= 0 && envVal <= 100 ? envVal : 70;
})();

/**
 * Is this pair resolved — should it be hidden from the "To Review" queue
 * and the matcher skip generating new near-match rows for it?
 *
 * Any cached decision counts as resolved:
 *   - Human approve/reject → final.
 *   - AI SAME / DIFFERENT / UNCERTAIN at any confidence → also final.
 *
 * Low-confidence AI verdicts DO NOT auto-merge (see `AI_AUTONOMOUS_THRESHOLD`),
 * but they still move the pair out of the queue and into the Decided tab,
 * where the human can eyeball them at leisure. This matches the user's stated
 * preference: "whatever AI decides is final" for queue purposes.
 */
export function isPairResolved(key: string): boolean {
  return getStore().has(key);
}

/**
 * Save an AI verdict. Each new run fully replaces the previous entry — latest
 * decision wins, regardless of who decided before. If a human approved this
 * pair and then the user re-runs Gemini on it (e.g. Try Pro), the AI verdict
 * takes over. The human can always click Approve/Reject again to flip back.
 */
export function saveAIDecision(params: {
  key: string;
  verdict: CachedDecision["verdict"];
  confidence: number;
  reasoning: string;
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
    reasoning: params.reasoning,
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

/**
 * Record a human verdict — FULLY REPLACES any existing entry.
 *
 * The AI's previous reasoning, confidence, and sources are discarded. The
 * entry now reflects the human decision as the single source of truth.
 * If the human changes their mind later, calling this again with the other
 * verdict replaces again.
 */
export function saveHumanVerdict(
  key: string,
  verdict: "approved" | "rejected",
  by?: string,
  note?: string,
  snapshot?: CachedDecision["snapshot"],
): CachedDecision {
  const existing = getStore().get(key);
  const entry: CachedDecision = {
    key,
    verdict: verdict === "approved" ? "SAME" : "DIFFERENT",
    confidence: 100,
    reasoning: note || "",
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
