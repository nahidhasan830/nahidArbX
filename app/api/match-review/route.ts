/**
 * Match Review API
 *
 * GET  ?view=list            list pending near-matches + multi-provider matched events
 *       ?view=cached-decision&key=<k>  look up a single cached AI verdict
 *       ?view=stats          summary counts
 *
 * POST action=analyze                 { items: [{a, b, model?}], forceRefresh? }
 *      action=approve                 { key } — approve an AI decision, merge events, learn aliases
 *      action=reject                  { key } — reject an AI decision (negative example)
 *      action=delete                  { key } — drop a cached decision entirely
 */

import { NextRequest, NextResponse } from "next/server";
import pLimit from "p-limit";
import {
  analyzeMatchWithGemini,
  buildHumanSearchUrl,
  type ModelTier,
} from "@/lib/ai/gemini";
import {
  computePairKey,
  getCachedDecision,
  saveAIDecision,
  saveHumanVerdict,
  listDecisions,
  deleteDecision,
  getCacheStats,
  AI_AUTONOMOUS_THRESHOLD,
  type CachedDecision,
  type DecisionSnapshotSide,
} from "@/lib/matching/ai-decision-cache";

import { getNearMatches, getNearMatchById } from "@/lib/matching/diagnostics";
import { getEvents, setEvents, unmatchEventCompletely } from "@/lib/store";
import { isProviderRuntimeEnabled } from "@/lib/providers/runtime-state";
import {
  applyTeamAlias,
  applyCompetitionAlias,
} from "@/lib/matching/normalize";
import { computeDetailedScore } from "@/lib/matching/diagnostics/analyzer";
import { TIME_BUCKET_MS } from "@/lib/shared/constants";
import {
  ensureCompetitionEntity,
  ensureTeamEntity,
  recordObservation,
} from "@/lib/matching/entities";
import { resetMatchCache } from "@/lib/matching/match-cache";
import { updateNearMatchStatus } from "@/lib/matching/diagnostics/store";
import { locateEventBySide } from "@/lib/matching/locate";
import type { NormalizedEvent } from "@/lib/types";
import { logger } from "@/lib/shared/logger";
import {
  beginSession as beginBulkSession,
  endSession as endBulkSession,
  abort as abortBulk,
  pause as pauseBulk,
  resume as resumeBulk,
  isAborted as isBulkAborted,
  waitIfPaused as waitIfBulkPaused,
  getStatus as getBulkStatus,
  recordResult as recordBulkResult,
} from "@/lib/matching/bulk-control";

// ============================================
// Helpers
// ============================================

interface ReviewEventSide {
  provider: string;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  startTime: string;
}

interface ReviewItem {
  key: string;
  source: "near-match" | "matched-event" | "unmatched-candidate" | "decided";
  nearMatchId?: string;
  matchedEventId?: string;
  /** Internal event IDs — set for unmatched candidates so approve can merge them */
  eventAId?: string;
  eventBId?: string;
  /** similarity score for near-matches OR confidence for matched events */
  score: number;
  /** Time-bucket key used to group rows in the UI (ISO minute) */
  bucketKey?: string;
  /**
   * True when this pair was picked by bucket-symmetry heuristic:
   * the time bucket contained a clean 1-to-1 mapping across providers,
   * so this pairing is the only plausible one regardless of string score.
   */
  autoSuggested?: boolean;
  eventA: ReviewEventSide;
  eventB: ReviewEventSide;
  googleSearchUrl: string;
  cachedDecision?: CachedDecision;
}

function toSide(
  provider: string,
  e: {
    homeTeam: string;
    awayTeam: string;
    competition: string;
    startTime: Date | string;
  },
): ReviewEventSide {
  return {
    provider,
    homeTeam: e.homeTeam,
    awayTeam: e.awayTeam,
    competition: e.competition,
    startTime: new Date(e.startTime).toISOString(),
  };
}

const ALIASES = {
  team: applyTeamAlias,
  competition: applyCompetitionAlias,
};

/**
 * Deduplicate a list of review items by canonical pair key. The near-match
 * store keys entries by internal event ID, so when a provider reassigns IDs
 * on re-sync we can end up with multiple store entries that map to the same
 * canonical pair. The UI should show one row per real-world pair — we keep
 * the entry with the highest score (most likely to be the same event).
 */
function dedupeByPairKey(items: ReviewItem[]): ReviewItem[] {
  const byKey = new Map<string, ReviewItem>();
  for (const it of items) {
    const existing = byKey.get(it.key);
    if (!existing || it.score > existing.score) {
      byKey.set(it.key, it);
    }
  }
  return Array.from(byKey.values());
}

function buildItemsFromNearMatches(): ReviewItem[] {
  const nearMatches = getNearMatches();
  const items = nearMatches.map((nm) => {
    const key = computePairKey(
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
      ALIASES,
    );
    return {
      key,
      source: "near-match" as const,
      nearMatchId: nm.id,
      // Direct event IDs as well — the near-match store can be pruned by the
      // dedup replace-on-better-score logic, so the approve handler needs a
      // second way to locate the underlying events.
      eventAId: nm.eventA.id,
      eventBId: nm.eventB.id,
      score: nm.breakdown.finalScore,
      eventA: toSide(nm.eventA.provider, nm.eventA),
      eventB: toSide(nm.eventB.provider, nm.eventB),
      googleSearchUrl: buildHumanSearchUrl(nm.eventA, nm.eventB),
      cachedDecision: getCachedDecision(key),
    };
  });
  return dedupeByPairKey(items);
}

function buildItemsFromMatchedEvents(): ReviewItem[] {
  const events = getEvents();
  const items: ReviewItem[] = [];

  for (const ev of events) {
    const providers = Object.keys(ev.providers);
    if (providers.length < 2) continue;

    // Pair the base event data (we only have one set of home/away on the merged
    // event, so we show the same sides for each provider column). This still
    // gives the user a Google-search button + approve/reject for the merged match.
    const [providerA, providerB] = providers;
    const side: Pick<ReviewEventSide, "homeTeam" | "awayTeam" | "competition"> =
      {
        homeTeam: ev.homeTeam,
        awayTeam: ev.awayTeam,
        competition: ev.competition,
      };
    const sideA: ReviewEventSide = {
      ...side,
      provider: providerA,
      startTime: new Date(ev.startTime).toISOString(),
    };
    const sideB: ReviewEventSide = {
      ...side,
      provider: providerB,
      startTime: new Date(ev.startTime).toISOString(),
    };

    const key = computePairKey(side, side, ALIASES);

    items.push({
      key,
      source: "matched-event",
      matchedEventId: ev.id,
      score: (ev.matchConfidence ?? 100) / 100,
      eventA: sideA,
      eventB: sideB,
      googleSearchUrl: buildHumanSearchUrl(ev, ev),
      cachedDecision: getCachedDecision(key),
    });
  }

  return dedupeByPairKey(items);
}

/**
 * Build candidate pairs for events that the matcher couldn't match — i.e.
 * single-provider events sitting in a time bucket that contains events from
 * other providers. The similarity score may be arbitrarily low (e.g. 0.20
 * for transliterated or differently-abbreviated team names), so the matcher
 * itself ignores them. Surfacing them here lets a human (or the AI) decide.
 *
 * Per-bucket cost is bounded: we generate every cross-provider pair within
 * a bucket, score them with the standard Dice/alias similarity, drop pairs
 * that already have a human verdict, and cap at TOP_PER_BUCKET so very
 * crowded buckets stay usable in the UI.
 */
const TOP_CANDIDATES_PER_BUCKET = 6;

function buildUnmatchedCandidates(): ReviewItem[] {
  const events = getEvents();

  // Group single-provider events by time bucket (same logic the matcher uses)
  type Bucket = { iso: string; events: NormalizedEvent[] };
  const bucketMap = new Map<number, Bucket>();

  for (const ev of events) {
    if (Object.keys(ev.providers).length !== 1) continue;
    const ms = new Date(ev.startTime).getTime();
    const rounded = Math.floor(ms / TIME_BUCKET_MS) * TIME_BUCKET_MS;
    let bucket = bucketMap.get(rounded);
    if (!bucket) {
      bucket = { iso: new Date(rounded).toISOString(), events: [] };
      bucketMap.set(rounded, bucket);
    }
    bucket.events.push(ev);
  }

  const items: ReviewItem[] = [];

  for (const [, bucket] of bucketMap) {
    // At least two distinct providers must be represented for a cross-provider
    // pair to exist. If only one provider has events in this slot, there's
    // nothing to match against.
    const providersInBucket = new Set<string>();
    for (const ev of bucket.events) {
      for (const p of Object.keys(ev.providers)) providersInBucket.add(p);
    }
    if (providersInBucket.size < 2) continue;

    // Respect runtime-disabled providers.
    const validEvents = bucket.events.filter((e) =>
      Object.keys(e.providers).every((p) => isProviderRuntimeEnabled(p)),
    );
    if (validEvents.length < 2) continue;

    // Bucket-symmetry heuristic (Stage 2):
    //
    //   If every provider in this bucket has the same number of events, we
    //   have a 1-to-1 assignment problem and the bucket is "symmetric". We
    //   greedy-assign pairs in decreasing similarity order. For each pair
    //   we pick, we REMOVE both events from the pool so neither can pair
    //   again — a clean 1-to-1 mapping. These pairs get `autoSuggested: true`
    //   because the time bucket alone is strong evidence: if these events
    //   belong together, the symmetric structure proves it even when the
    //   string score is near zero (e.g. "FCB" ↔ "Barcelona").
    //
    //   Asymmetric buckets (e.g. 2 Pinnacle + 3 9W) fall through to the
    //   original top-N-by-score behavior, which is best for humans to scan.
    const byProvider = new Map<string, NormalizedEvent[]>();
    for (const e of validEvents) {
      const p = Object.keys(e.providers)[0];
      const list = byProvider.get(p) ?? [];
      list.push(e);
      byProvider.set(p, list);
    }
    const counts = Array.from(byProvider.values()).map((l) => l.length);
    const isSymmetric =
      counts.length > 0 && counts.every((c) => c === counts[0]);

    // Score every cross-provider pair in the bucket.
    const scored: Array<{
      a: NormalizedEvent;
      b: NormalizedEvent;
      score: number;
    }> = [];
    for (let i = 0; i < validEvents.length; i++) {
      for (let j = i + 1; j < validEvents.length; j++) {
        const a = validEvents[i];
        const b = validEvents[j];
        const providerA = Object.keys(a.providers)[0];
        const providerB = Object.keys(b.providers)[0];
        if (providerA === providerB) continue; // same provider — not a match
        const breakdown = computeDetailedScore(a, b);
        scored.push({ a, b, score: breakdown.finalScore });
      }
    }
    scored.sort((x, y) => y.score - x.score);

    const pushItem = (
      a: NormalizedEvent,
      b: NormalizedEvent,
      score: number,
      autoSuggested: boolean,
    ) => {
      const key = computePairKey(
        {
          homeTeam: a.homeTeam,
          awayTeam: a.awayTeam,
          competition: a.competition,
        },
        {
          homeTeam: b.homeTeam,
          awayTeam: b.awayTeam,
          competition: b.competition,
        },
        ALIASES,
      );
      items.push({
        key,
        source: "unmatched-candidate",
        eventAId: a.id,
        eventBId: b.id,
        score,
        bucketKey: bucket.iso,
        autoSuggested,
        eventA: toSide(Object.keys(a.providers)[0], a),
        eventB: toSide(Object.keys(b.providers)[0], b),
        googleSearchUrl: buildHumanSearchUrl(a, b),
        cachedDecision: getCachedDecision(key),
      });
    };

    if (isSymmetric) {
      // Greedy 1-to-1 assignment by similarity. Each event can appear in at
      // most one auto-suggested pair; once used it's unavailable.
      const used = new Set<string>();
      for (const s of scored) {
        if (used.has(s.a.id) || used.has(s.b.id)) continue;
        used.add(s.a.id);
        used.add(s.b.id);
        pushItem(s.a, s.b, s.score, true);
      }
      // If the greedy mapping didn't consume every event (which shouldn't
      // happen in a truly symmetric bucket), fall back to showing the top
      // leftover pairs as regular candidates.
      let leftoverCount = 0;
      for (const s of scored) {
        if (leftoverCount >= TOP_CANDIDATES_PER_BUCKET) break;
        if (used.has(s.a.id) && used.has(s.b.id)) continue;
        pushItem(s.a, s.b, s.score, false);
        leftoverCount++;
      }
    } else {
      // Asymmetric bucket — fall back to top-N pairs by score (original behavior).
      let count = 0;
      for (const s of scored) {
        if (count >= TOP_CANDIDATES_PER_BUCKET) break;
        pushItem(s.a, s.b, s.score, false);
        count++;
      }
    }
  }

  return dedupeByPairKey(items);
}

/**
 * Build a UI row from a cached decision. Prefers the frozen snapshot
 * (captured at decision time); falls back to parsing the canonical key
 * for legacy entries written before snapshots existed.
 */
function buildDecidedItemFromCache(d: CachedDecision): ReviewItem | null {
  if (d.snapshot) {
    const { eventA, eventB } = d.snapshot;
    return {
      key: d.key,
      source: "decided" as const,
      score: (d.confidence || 0) / 100,
      eventA,
      eventB,
      googleSearchUrl: buildHumanSearchUrl(
        {
          homeTeam: eventA.homeTeam,
          awayTeam: eventA.awayTeam,
          competition: eventA.competition,
          startTime: eventA.startTime,
        },
        {
          homeTeam: eventB.homeTeam,
          awayTeam: eventB.awayTeam,
          competition: eventB.competition,
          startTime: eventB.startTime,
        },
      ),
      cachedDecision: d,
    };
  }
  // Legacy entry — parse canonical key for a degraded but informative row.
  const [sideA, sideB] = d.key.split("::");
  if (!sideA || !sideB) return null;
  const parseSide = (s: string) => {
    const parts = s.split("|");
    return {
      homeTeam: parts[0] || "?",
      awayTeam: parts[1] || "?",
      competition: parts.slice(2).join("|") || "?",
    };
  };
  const a = parseSide(sideA);
  const b = parseSide(sideB);
  return {
    key: d.key,
    source: "decided" as const,
    score: (d.confidence || 0) / 100,
    eventA: { provider: "unknown", ...a, startTime: d.decidedAt },
    eventB: { provider: "unknown", ...b, startTime: d.decidedAt },
    googleSearchUrl: "",
    cachedDecision: d,
  };
}

/**
 * Enrich a legacy decided entry by looking it up in a pre-built index of
 * the current event store keyed by single-event canonical identity. The
 * index is O(n) to build; this lookup is O(n) per cache entry in the
 * worst case (two sides to match), which stays fast even with thousands
 * of events. Falls back to the original item when no match is found —
 * the row renders as "archived" and the user still sees the verdict.
 */
function enrichDecidedFromStore(
  d: CachedDecision,
  fallback: ReviewItem,
  sideIndex: Map<string, { event: NormalizedEvent; provider: string }[]>,
): ReviewItem {
  const [sideKeyA, sideKeyB] = d.key.split("::");
  if (!sideKeyA || !sideKeyB) return fallback;
  const candidatesA = sideIndex.get(sideKeyA);
  const candidatesB = sideIndex.get(sideKeyB);
  if (!candidatesA || !candidatesB) return fallback;
  for (const a of candidatesA) {
    for (const b of candidatesB) {
      if (a.provider === b.provider) continue;
      return {
        ...fallback,
        eventA: toSide(a.provider, a.event),
        eventB: toSide(b.provider, b.event),
        googleSearchUrl: buildHumanSearchUrl(a.event, b.event),
      };
    }
  }
  return fallback;
}

/**
 * Build an index from canonical side identity → events with that identity.
 * `sideIdentity` is "teams|comp" and collapses across providers (teams are
 * alphabetized, competition is aliased). Used to enrich legacy cache
 * entries in O(1) lookup per side.
 */
function buildSideIndex(): Map<
  string,
  { event: NormalizedEvent; provider: string }[]
> {
  const index = new Map<
    string,
    { event: NormalizedEvent; provider: string }[]
  >();
  for (const event of getEvents()) {
    for (const provider of Object.keys(event.providers)) {
      const teams = [
        applyTeamAlias(event.homeTeam),
        applyTeamAlias(event.awayTeam),
      ].sort();
      const sideKey = `${teams[0]}|${teams[1]}|${applyCompetitionAlias(
        event.competition,
      )}`;
      const list = index.get(sideKey);
      if (list) list.push({ event, provider });
      else index.set(sideKey, [{ event, provider }]);
    }
  }
  return index;
}

/**
 * If the cached decision lacks a snapshot, save one now so future renders
 * don't need to re-enrich. We keep the original verdict and confidence —
 * only the snapshot field changes.
 */
function backfillSnapshotIfMissing(
  d: CachedDecision,
  eventA: ReviewEventSide,
  eventB: ReviewEventSide,
): void {
  if (d.snapshot) return;
  if (eventA.provider === "unknown" || eventB.provider === "unknown") return;
  const snapshot: {
    eventA: DecisionSnapshotSide;
    eventB: DecisionSnapshotSide;
  } = {
    eventA: { ...eventA },
    eventB: { ...eventB },
  };
  if (d.decidedBy === "human") {
    saveHumanVerdict(
      d.key,
      d.verdict === "SAME" ? "approved" : "rejected",
      d.by,
      snapshot,
    );
  } else {
    saveAIDecision({
      key: d.key,
      verdict: d.verdict,
      confidence: d.confidence,
      model: d.model,
      sources: d.sources,
      snapshot,
    });
  }
}

// ============================================
// GET
// ============================================

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const view = url.searchParams.get("view") || "list";

  try {
    switch (view) {
      case "list": {
        // Two status-based buckets:
        //
        //   toReview — pairs with no confident verdict yet (no decision, or
        //              AI UNCERTAIN / <threshold). The queue that needs action.
        //   decided  — any pair where *someone* decided: matcher auto-merge,
        //              AI confident verdict, or human approve/reject. The
        //              per-row badge shows WHO decided so the user can filter
        //              client-side and override anything they disagree with.
        //
        // Provider filter: drop items referencing a runtime-disabled provider.
        const include = (p: string) => isProviderRuntimeEnabled(p);
        const providerOk = (it: ReviewItem) =>
          include(it.eventA.provider) && include(it.eventB.provider);

        const rawNear = buildItemsFromNearMatches();
        const rawMatched = buildItemsFromMatchedEvents();
        const rawUnmatched = buildUnmatchedCandidates();

        const near = rawNear.filter(providerOk);
        const matched = rawMatched.filter(providerOk);
        const unmatched = rawUnmatched.filter(providerOk);

        const mergedKeys = new Set(matched.map((it) => it.key));
        const allDecisions = listDecisions();
        const humanKeys = new Set(
          allDecisions.filter((d) => d.decidedBy === "human").map((d) => d.key),
        );
        // Every cached decision removes the pair from To Review. AI touch =
        // out of the queue, regardless of verdict or confidence. Low-confidence
        // SAMEs still show up in the Decided tab with a visual flag.
        const decidedKeys = new Set(allDecisions.map((d) => d.key));

        // Tab 1 — To Review: only pairs no one has analyzed yet.
        const toReview = dedupeByPairKey(
          [...near, ...unmatched].filter(
            (it) => !mergedKeys.has(it.key) && !decidedKeys.has(it.key),
          ),
        );

        // Look up table for enriching legacy cache entries (saved before
        // snapshots were stored). Prefer items already built from live data.
        const liveByKey = new Map<string, ReviewItem>();
        for (const it of [...rawNear, ...rawMatched, ...rawUnmatched]) {
          if (!liveByKey.has(it.key)) liveByKey.set(it.key, it);
        }

        // Tab 2 — Decided: pairs with an explicit AI-confident or human
        // verdict. Matcher auto-merges live in their own lazy-loaded tab
        // (view=auto-merged) — they aren't included here by default because
        // there are typically hundreds and bloating the initial payload
        // slows page load.
        //
        // Build the side index lazily — only when a legacy cache entry
        // needs enrichment AND it isn't already covered by liveByKey.
        let sideIndex: ReturnType<typeof buildSideIndex> | null = null;

        const decided: ReviewItem[] = [];
        for (const d of allDecisions) {
          // Every cached verdict surfaces here — human or AI, any confidence.
          // Low-confidence SAMEs appear with their confidence badge so the
          // user can see what Gemini tried and decide whether to approve.
          let item = buildDecidedItemFromCache(d);
          if (!item) continue;
          if (
            item.eventA.provider === "unknown" ||
            item.eventB.provider === "unknown"
          ) {
            const live = liveByKey.get(d.key);
            let enriched: ReviewItem = item;
            if (live) {
              enriched = live;
            } else {
              if (!sideIndex) sideIndex = buildSideIndex();
              enriched = enrichDecidedFromStore(d, item, sideIndex);
            }
            if (enriched !== item) {
              item = {
                ...item,
                eventA: enriched.eventA,
                eventB: enriched.eventB,
                googleSearchUrl:
                  enriched.googleSearchUrl || item.googleSearchUrl,
              };
              backfillSnapshotIfMissing(d, item.eventA, item.eventB);
            }
          }
          if (item.eventA.provider !== "unknown" && !providerOk(item)) {
            continue;
          }
          decided.push(item);
        }

        // Count matcher auto-merges so the lazy tab can show its count
        // without loading the full list. Excludes anything that has a
        // human/AI verdict attached — those live in Decided.
        const autoMergedCount = matched.filter(
          (it) => !decidedKeys.has(it.key),
        ).length;

        const eventStoreSize = getEvents().length;
        const multiProv = getEvents().filter(
          (e) => Object.keys(e.providers).length > 1,
        ).length;
        logger.info(
          "MatchReview",
          `list: store=${eventStoreSize} (multi=${multiProv}) | ` +
            `toReview=${toReview.length} autoMergedCount=${autoMergedCount} decided=${decided.length} | ` +
            `keys: merged=${mergedKeys.size} human=${humanKeys.size} decided=${decidedKeys.size}`,
        );

        return NextResponse.json({
          toReview,
          autoMergedCount,
          decided,
          stats: getCacheStats(),
        });
      }

      case "auto-merged": {
        // Lazy: returns the full list of matcher auto-merges that no AI or
        // human has weighed in on yet. Fetched only when the user opens the
        // Auto-Merged tab — keeps the initial page load fast when this list
        // has hundreds of entries.
        const include = (p: string) => isProviderRuntimeEnabled(p);
        const providerOk = (it: ReviewItem) =>
          include(it.eventA.provider) && include(it.eventB.provider);

        const matched = buildItemsFromMatchedEvents().filter(providerOk);
        const allDecisions = listDecisions();
        const humanKeys = new Set(
          allDecisions.filter((d) => d.decidedBy === "human").map((d) => d.key),
        );
        const aiConfidentKeys = new Set(
          allDecisions
            .filter(
              (d) =>
                d.decidedBy !== "human" &&
                d.verdict !== "UNCERTAIN" &&
                d.confidence >= AI_AUTONOMOUS_THRESHOLD,
            )
            .map((d) => d.key),
        );

        const autoMerged: ReviewItem[] = matched
          .filter(
            (it) => !humanKeys.has(it.key) && !aiConfidentKeys.has(it.key),
          )
          .map((it) => {
            const synth: CachedDecision = {
              key: it.key,
              verdict: "SAME",
              confidence: Math.round(it.score * 100),
              decidedBy: "matcher",
              decidedAt: new Date().toISOString(),
              sources: [],
              model: "string-similarity",
            };
            return {
              ...it,
              source: "decided" as const,
              cachedDecision: synth,
            };
          });

        return NextResponse.json({ autoMerged });
      }

      case "cached-decision": {
        const key = url.searchParams.get("key");
        if (!key) {
          return NextResponse.json({ error: "Missing key" }, { status: 400 });
        }
        return NextResponse.json({ decision: getCachedDecision(key) || null });
      }

      case "stats": {
        return NextResponse.json({
          cacheStats: getCacheStats(),
          cached: listDecisions().length,
        });
      }

      case "bulk-status": {
        return NextResponse.json(getBulkStatus());
      }

      default:
        return NextResponse.json(
          { error: `Unknown view: ${view}` },
          { status: 400 },
        );
    }
  } catch (err) {
    logger.error("MatchReview", `GET failed: ${(err as Error).message}`);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

// ============================================
// POST
// ============================================

interface AnalyzeItemPayload {
  key: string;
  /** Which Gemini model to use. Optional — defaults to flash. */
  model?: ModelTier;
  eventA: ReviewEventSide;
  eventB: ReviewEventSide;
  forceRefresh?: boolean;
}

async function analyzeOne(
  payload: AnalyzeItemPayload,
): Promise<
  | { key: string; status: "cached" | "analyzed"; decision: CachedDecision }
  | { key: string; status: "error"; error: string }
> {
  // Dedup: if we already have a decision for this pair, don't spend quota.
  if (!payload.forceRefresh) {
    const cached = getCachedDecision(payload.key);
    if (cached) return { key: payload.key, status: "cached", decision: cached };
  }

  const snapshot: {
    eventA: DecisionSnapshotSide;
    eventB: DecisionSnapshotSide;
  } = {
    eventA: { ...payload.eventA },
    eventB: { ...payload.eventB },
  };

  try {
    const result = await analyzeMatchWithGemini(
      payload.eventA,
      payload.eventB,
      {
        model: payload.model,
      },
    );
    const saved = saveAIDecision({
      key: payload.key,
      verdict: result.decision,
      confidence: result.confidence,
      model: result.model,
      snapshot,
    });
    // Auto-merge on AI SAME ≥ threshold. Low-confidence SAMEs are saved to
    // the cache (so the pair leaves To Review) but NOT merged — the user
    // can see them in the Decided tab and approve if they want.
    if (
      saved.verdict === "SAME" &&
      saved.confidence >= AI_AUTONOMOUS_THRESHOLD
    ) {
      const status = autoMergeOnAISame(
        payload.eventA,
        payload.eventB,
        saved.confidence,
      );
      logger.info(
        "MatchReview",
        `auto-merge on AI SAME (${saved.confidence}%, ${saved.model}): ${status} — ${payload.eventA.homeTeam}/${payload.eventA.awayTeam}@${payload.eventA.provider} + ${payload.eventB.homeTeam}/${payload.eventB.awayTeam}@${payload.eventB.provider}`,
      );
    }
    return { key: payload.key, status: "analyzed", decision: saved };
  } catch (err) {
    return {
      key: payload.key,
      status: "error",
      error: (err as Error).message,
    };
  }
}

/**
 * Coerce a request body's event-side payloads into the snapshot shape the
 * decision cache expects. Returns undefined if either side is malformed —
 * the caller just omits the snapshot rather than throwing.
 */
function buildSnapshotFromBody(
  a: unknown,
  b: unknown,
): { eventA: DecisionSnapshotSide; eventB: DecisionSnapshotSide } | undefined {
  const coerce = (v: unknown): DecisionSnapshotSide | null => {
    if (!v || typeof v !== "object") return null;
    const r = v as Record<string, unknown>;
    if (
      typeof r.provider !== "string" ||
      typeof r.homeTeam !== "string" ||
      typeof r.awayTeam !== "string" ||
      typeof r.startTime !== "string"
    ) {
      return null;
    }
    return {
      provider: r.provider,
      homeTeam: r.homeTeam,
      awayTeam: r.awayTeam,
      competition: typeof r.competition === "string" ? r.competition : "",
      startTime: r.startTime,
    };
  };
  const eventA = coerce(a);
  const eventB = coerce(b);
  if (!eventA || !eventB) return undefined;
  return { eventA, eventB };
}

/**
 * Apply a confident AI SAME verdict: locate both sides in the current store,
 * merge them, replace the originals with the combined event, and learn aliases
 * from the pair. Safe no-ops when events can't be found (rotated IDs / already
 * pruned) or are already the same merged entity.
 */
function autoMergeOnAISame(
  uiA: {
    provider: string;
    homeTeam: string;
    awayTeam: string;
    startTime: string;
  },
  uiB: {
    provider: string;
    homeTeam: string;
    awayTeam: string;
    startTime: string;
  },
  confidence: number,
): "merged" | "already-merged" | "events-missing" {
  const eventA = locateEventBySide(uiA);
  const eventB = locateEventBySide(uiB);
  if (!eventA || !eventB) return "events-missing";
  if (eventA.id === eventB.id) return "already-merged";

  const { merged } = mergeAndLearn(eventA, eventB, confidence);
  const filtered = getEvents().filter(
    (e) => e.id !== eventA.id && e.id !== eventB.id,
  );
  filtered.push(merged);
  setEvents(filtered);
  return "merged";
}

function mergeAndLearn(
  eventA: NormalizedEvent,
  eventB: NormalizedEvent,
  confidencePct: number,
): { merged: NormalizedEvent; eventA: string; eventB: string } {
  const merged: NormalizedEvent = {
    ...eventA,
    providers: { ...eventA.providers, ...eventB.providers },
    matchSource: "ai-confirmed",
    matchConfidence: confidencePct,
  };

  // Record observations into the entity-resolution store. Treats
  // eventA as the canonical side (Pinnacle takes precedence elsewhere
  // in the merge flow). Async; fire-and-forget so the caller's response
  // isn't blocked on Postgres.
  void (async () => {
    try {
      const providerB =
        (Object.keys(eventB.providers)[0] as string | undefined) ?? "unknown";
      const compEntity = await ensureCompetitionEntity(eventA.competition);
      const competitionId = compEntity?.id ?? null;
      const homeEntity = await ensureTeamEntity({
        canonicalName: eventA.homeTeam,
        competitionId,
      });
      const awayEntity = await ensureTeamEntity({
        canonicalName: eventA.awayTeam,
        competitionId,
      });

      if (
        homeEntity &&
        eventA.homeTeam.toLowerCase() !== eventB.homeTeam.toLowerCase()
      ) {
        await recordObservation({
          kind: "team",
          surface: eventB.homeTeam,
          provider: providerB,
          competitionId,
          pairedWithEntityId: homeEntity.id,
          matchScore: confidencePct / 100,
          outcome: "manual-confirm",
          source: "match-review",
        });
      }
      if (
        awayEntity &&
        eventA.awayTeam.toLowerCase() !== eventB.awayTeam.toLowerCase()
      ) {
        await recordObservation({
          kind: "team",
          surface: eventB.awayTeam,
          provider: providerB,
          competitionId,
          pairedWithEntityId: awayEntity.id,
          matchScore: confidencePct / 100,
          outcome: "manual-confirm",
          source: "match-review",
        });
      }
      if (
        compEntity &&
        eventA.competition.toLowerCase() !== eventB.competition.toLowerCase()
      ) {
        await recordObservation({
          kind: "competition",
          surface: eventB.competition,
          provider: providerB,
          competitionId: null,
          pairedWithEntityId: compEntity.id,
          matchScore: confidencePct / 100,
          outcome: "manual-confirm",
          source: "match-review",
        });
      }
      resetMatchCache();
    } catch (err) {
      logger.warn(
        "MatchReview",
        `Alias observation failed: ${(err as Error).message}`,
      );
    }
  })();

  return { merged, eventA: eventA.id, eventB: eventB.id };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;

    switch (action) {
      case "analyze": {
        const items = body.items as AnalyzeItemPayload[] | undefined;
        if (!items || items.length === 0) {
          return NextResponse.json(
            { error: "items[] required" },
            { status: 400 },
          );
        }
        // Sequential — one Gemini call per pair, no parallel hammering on quota.
        const results: Awaited<ReturnType<typeof analyzeOne>>[] = [];
        for (const it of items) {
          results.push(
            await analyzeOne({ ...it, forceRefresh: body.forceRefresh }),
          );
        }
        return NextResponse.json({ results });
      }

      case "analyze-stream": {
        // Streams one SSE event per pair so the UI renders live progress.
        //   event: start   data: { total }
        //   event: result  data: { index, ...analyzeOneResult }  (out-of-order OK)
        //   event: done    data: { analyzed, cached, errored, total, aborted }
        //
        // Runs with tier-aware parallelism (see CONCURRENCY map below) — on a
        // paid Gemini plan the per-minute limits are high enough that 2–6
        // concurrent requests stay well under quota while cutting wall-clock
        // time 4-6x. Pause/abort are checked inside each task so user control
        // still works mid-run.
        const items = body.items as AnalyzeItemPayload[] | undefined;
        if (!items || items.length === 0) {
          return NextResponse.json(
            { error: "items[] required" },
            { status: 400 },
          );
        }

        // Block concurrent starts — the control module only tracks one
        // active session and UI hydration keys off `active`.
        const existing = getBulkStatus();
        if (existing.active) {
          return NextResponse.json(
            {
              error: "A bulk run is already in progress",
              sessionId: existing.sessionId,
            },
            { status: 409 },
          );
        }

        const forceRefresh = body.forceRefresh;
        const sessionModel = items[0]?.model ?? "flash";

        // Tier-aware concurrency. Overridable via env for tuning.
        // Defaults chosen to stay well under published paid-tier RPM limits
        // while still pipelining aggressively:
        //   Lite  (cheapest) — 6 × ~1.5s = ~240 RPM
        //   Flash (default)  — 4 × ~2s   = ~120 RPM
        //   Pro   (heaviest) — 2 × ~3s   = ~40 RPM
        const envInt = (name: string, fallback: number) => {
          const v = Number(process.env[name]);
          return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
        };
        const concurrency =
          sessionModel === "pro"
            ? envInt("GEMINI_CONCURRENCY_PRO", 2)
            : sessionModel === "lite"
              ? envInt("GEMINI_CONCURRENCY_LITE", 6)
              : envInt("GEMINI_CONCURRENCY_FLASH", 4);
        const limit = pLimit(concurrency);

        const encoder = new TextEncoder();
        // Session tracks progress + fans events out to all SSE subscribers
        // (this POST's own stream plus any /bulk-stream clients).
        beginBulkSession(sessionModel, items.length);
        const stream = new ReadableStream({
          async start(controller) {
            let closed = false;
            const send = (event: string, data: unknown) => {
              if (closed) return;
              try {
                controller.enqueue(
                  encoder.encode(
                    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
                  ),
                );
              } catch {
                // Client disconnected mid-write — stop pumping this stream;
                // the worker loop keeps going and feeds bulk-stream subscribers.
                closed = true;
              }
            };
            send("start", { total: items.length, concurrency });

            try {
              // Each task checks pause/abort BEFORE firing the Gemini call so
              // user control propagates even to tasks that were queued behind
              // the concurrency limiter. Out-of-order completions are fine:
              // every event carries its own index for the client.
              const tasks = items.map((it, i) =>
                limit(async () => {
                  if (isBulkAborted()) return;
                  await waitIfBulkPaused();
                  if (isBulkAborted()) return;
                  const result = await analyzeOne({ ...it, forceRefresh });
                  recordBulkResult(i, result.status, result);
                  send("result", { index: i, ...result });
                }),
              );
              await Promise.all(tasks);

              const aborted = isBulkAborted();
              const finalStatus = getBulkStatus();
              send("done", {
                analyzed: finalStatus.analyzed,
                cached: finalStatus.cached,
                errored: finalStatus.errored,
                total: items.length,
                aborted,
              });
            } finally {
              endBulkSession();
              if (!closed) {
                try {
                  controller.close();
                } catch {
                  // Already closed by the client — safe to ignore.
                }
              }
            }
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      }

      case "bulk-abort": {
        abortBulk();
        return NextResponse.json({ success: true, ...getBulkStatus() });
      }

      case "bulk-pause": {
        pauseBulk();
        return NextResponse.json({ success: true, ...getBulkStatus() });
      }

      case "bulk-resume": {
        resumeBulk();
        return NextResponse.json({ success: true, ...getBulkStatus() });
      }

      case "approve": {
        const { key, userId } = body;
        if (!key) {
          return NextResponse.json({ error: "key required" }, { status: 400 });
        }
        const cached = getCachedDecision(key);
        const nearMatchId = body.nearMatchId as string | undefined;
        const matchedEventId = body.matchedEventId as string | undefined;
        const eventAId = body.eventAId as string | undefined;
        const eventBId = body.eventBId as string | undefined;

        // Snapshot of the pair captured at decision time — so the Decided
        // tab can render this row (teams/providers/time) even after the live
        // event store rotates. Required shape matches DecisionSnapshotSide.
        const uiSnapshot = buildSnapshotFromBody(body.eventA, body.eventB);

        const all = getEvents();

        // Matched-event path: the pair is already merged into one event. The
        // user is just confirming the auto-match is correct. No merge step
        // needed — record the human verdict in the cache and we're done.
        // If the specific merged event no longer exists (sync dropped it),
        // the verdict is still worth saving — it locks the pair's outcome.
        if (matchedEventId) {
          const existing = all.find((e) => e.id === matchedEventId);
          saveHumanVerdict(key, "approved", userId, uiSnapshot);
          if (nearMatchId)
            updateNearMatchStatus(nearMatchId, "confirmed", userId);
          return NextResponse.json({
            success: true,
            mergedId: existing?.id ?? null,
            message: existing
              ? "Confirmed existing match."
              : "Verdict saved (the merged event has since been replaced by the matcher — next sync will produce the same merge).",
          });
        }

        // Not-yet-merged path: locate the two underlying events, merge them,
        // learn aliases, record the verdict. We try locating the events in
        // three increasing-robustness ways, because internal event IDs may
        // rotate between syncs (provider APIs can hand out fresh IDs on each
        // fetch), which would make a stale ID lookup miss.
        let eventA: NormalizedEvent | undefined;
        let eventB: NormalizedEvent | undefined;

        // (1) Near-match store reference.
        if (nearMatchId) {
          const nm = getNearMatchById(nearMatchId);
          if (nm) {
            eventA = all.find((e) => e.id === nm.eventA.id);
            eventB = all.find((e) => e.id === nm.eventB.id);
          }
        }

        // (2) Direct internal-ID lookup.
        if ((!eventA || !eventB) && eventAId && eventBId) {
          eventA = all.find((e) => e.id === eventAId);
          eventB = all.find((e) => e.id === eventBId);
        }

        // (3) Semantic lookup — the UI sent the ReviewItem's eventA/eventB
        // payload (provider, homeTeam, awayTeam, competition, startTime).
        // Match against the current store by provider + canonical names +
        // time bucket. Survives internal-ID rotation across syncs.
        const uiA = body.eventA as
          | {
              provider: string;
              homeTeam: string;
              awayTeam: string;
              startTime: string;
            }
          | undefined;
        const uiB = body.eventB as
          | {
              provider: string;
              homeTeam: string;
              awayTeam: string;
              startTime: string;
            }
          | undefined;

        // Short-circuit: if the matcher already auto-merged this pair in a
        // later sync (e.g. aliases grew enough to push the score ≥ 0.85),
        // we'll find ONE event in the store that contains BOTH providers
        // AND matches both UI sides. That means "already merged" — we just
        // record the human verdict on the existing match and call it done.
        if (uiA && uiB) {
          const matchingA =
            locateEventBySide(uiA, all) ??
            // if uiA's provider isn't single-provider-alone, check any multi-
            // provider event that includes the provider and teams
            all.find(
              (e) =>
                Object.keys(e.providers).length > 1 &&
                locateEventBySide(uiA, [e]),
            );
          const matchingB =
            locateEventBySide(uiB, all) ??
            all.find(
              (e) =>
                Object.keys(e.providers).length > 1 &&
                locateEventBySide(uiB, [e]),
            );
          if (matchingA && matchingB && matchingA.id === matchingB.id) {
            saveHumanVerdict(key, "approved", userId, uiSnapshot);
            if (nearMatchId)
              updateNearMatchStatus(nearMatchId, "confirmed", userId);
            return NextResponse.json({
              success: true,
              mergedId: matchingA.id,
              message: "Already merged by the matcher — verdict recorded.",
            });
          }
        }

        // Fall through to normal two-event-merge path.
        if (!eventA && uiA) eventA = locateEventBySide(uiA, all);
        if (!eventB && uiB) eventB = locateEventBySide(uiB, all);

        // If both sides resolve to the SAME stored event, they're already
        // merged. Treat as "already merged" confirm.
        if (eventA && eventB && eventA.id === eventB.id) {
          saveHumanVerdict(key, "approved", userId, uiSnapshot);
          if (nearMatchId)
            updateNearMatchStatus(nearMatchId, "confirmed", userId);
          return NextResponse.json({
            success: true,
            mergedId: eventA.id,
            message: "Already merged — verdict recorded.",
          });
        }

        if (!eventA || !eventB) {
          // Events are gone from the current store (refreshed-out, pruned,
          // or renamed beyond what aliases can collapse). The human verdict
          // still has real value — it prevents this pair from re-surfacing
          // on every future sync — so we record it and report graceful
          // success rather than forcing the user to chase a 404.
          logger.warn(
            "MatchReview",
            `approve: events not found in store, recording verdict only — key=${key} near=${nearMatchId} eventAId=${eventAId} eventBId=${eventBId} uiA=${uiA?.homeTeam}/${uiA?.awayTeam}@${uiA?.provider} uiB=${uiB?.homeTeam}/${uiB?.awayTeam}@${uiB?.provider}`,
          );
          saveHumanVerdict(key, "approved", userId, uiSnapshot);
          if (nearMatchId)
            updateNearMatchStatus(nearMatchId, "confirmed", userId);
          return NextResponse.json({
            success: true,
            deferred: true,
            message:
              "Verdict saved, but the events aren't in the current store — they'll merge on the next sync.",
          });
        }

        // Human approve is authoritative — merge with full confidence, but
        // surface the AI's prior confidence in the merged event if available
        // (so downstream display can show "AI said 92% SAME, human agreed").
        const confidencePct =
          cached?.decidedBy === "human" ? 100 : (cached?.confidence ?? 100);
        const { merged } = mergeAndLearn(eventA, eventB, confidencePct);
        const filtered = getEvents().filter(
          (e) => e.id !== eventA!.id && e.id !== eventB!.id,
        );
        filtered.push(merged);
        setEvents(filtered);

        // FULLY REPLACE any prior AI entry with the human verdict.
        saveHumanVerdict(key, "approved", userId, uiSnapshot);
        if (nearMatchId)
          updateNearMatchStatus(nearMatchId, "confirmed", userId);

        return NextResponse.json({
          success: true,
          mergedId: merged.id,
          message: `Approved. Merged ${eventA.id} + ${eventB.id}.`,
        });
      }

      case "reject": {
        const { key, userId, nearMatchId } = body;
        const matchedEventId = body.matchedEventId as string | undefined;
        if (!key) {
          return NextResponse.json({ error: "key required" }, { status: 400 });
        }

        const uiSnapshot = buildSnapshotFromBody(body.eventA, body.eventB);
        saveHumanVerdict(key, "rejected", userId, uiSnapshot);
        if (nearMatchId) updateNearMatchStatus(nearMatchId, "rejected", userId);

        // Reject on a matched-event row means "this auto-match is wrong" —
        // unmerge the combined event so each provider's side becomes a
        // single-provider event again. The cached rejection prevents the
        // pair from re-merging in future syncs.
        let unmatched: string | null = null;
        if (matchedEventId) {
          const result = unmatchEventCompletely(matchedEventId);
          unmatched = result.success
            ? `Unmerged ${matchedEventId}`
            : `Verdict saved, but unmerge failed: ${result.message}`;
        }

        return NextResponse.json({ success: true, unmatched });
      }

      case "delete": {
        const { key } = body;
        if (!key) {
          return NextResponse.json({ error: "key required" }, { status: 400 });
        }
        const ok = deleteDecision(key);
        return NextResponse.json({ success: ok });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 },
        );
    }
  } catch (err) {
    logger.error("MatchReview", `POST failed: ${(err as Error).message}`);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
