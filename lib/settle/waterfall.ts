/**
 * Settlement waterfall: resolves a final MatchScore for a set of eventIds
 * at the cheapest available tier. Each source runs on events still missing
 * the data required by their pending bets after the previous source.
 *
 *   Tier 0  match_scores table (permanent cache)          — free
 *   Tier 2a free sports APIs: ESPN scoreboard             — free, unlimited
 *   Tier 2b SofaScore (unofficial, best-effort)           — free, CF-blocked
 *   Tier 2c free sports APIs: API-Football                — free, 100 req/day
 *
 * Tier 0 is read-only; tiers 2+ upsert their discoveries back into
 * match_scores so subsequent settlement requests are instantly free.
 *
 * NOTE: Tier 1 (Pinnacle WS + BC live feeds) was removed because
 * settlement runs ≥20 min after FT, by which point in-memory live
 * feed data has expired.
 */

import type { MatchScore } from "./types";
import {
  getScoresByEventIds,
  saveScoreIfAbsent,
  upsertScoreForce,
} from "../db/repositories/match-scores";
import { fetchEspnScores, enrichEspnStats } from "./sources/espn";
import {
  fetchApiFootballScores,
  enrichApiFootballStats,
  getApiFootballQuota,
} from "./sources/api-football";
import { fetchSofaScoreScores } from "./sources/sofascore";
import { getBrowserSessionStats } from "./sources/sofascore-browser";
import { logger } from "../shared/logger";

/**
 * Event metadata the waterfall needs to hand to Tier 2+ sources so they
 * can look up the match in external providers (which don't know our
 * eventId). Pulled from the denormalized columns on value_bets.
 */
export interface SettleEvent {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  competition: string | null;
  startTime: string; // ISO
}

export interface WaterfallTelemetry {
  total: number;
  tier0_hits: number;
  tier1_hits: number;
  tier2_hits: number;
  tier3_hits: number;
  tier4_hits: number;
  unresolved: number;
  durationMs: number;
  eventsTotal: number;
  eventsAttempted: number;
  eventsSkippedByBackoff: number;
  eventsResolvedFromCache: number;
  eventsResolvedByEspn: number;
  eventsResolvedBySofaScore: number;
  eventsResolvedByApiFootball: number;
  eventsStillUnresolved: number;
  apiFootballRequestsUsed: number;
  /**
   * Non-fatal warnings about data-source access issues encountered
   * during this run. E.g. SofaScore 403, Scrape.do 401. Surfaced in
   * the settlement monitor UI and optionally as Telegram alerts.
   */
  sourceIssues: string[];
}

export interface ResolveResult {
  scores: Map<string, MatchScore>;
  telemetry: WaterfallTelemetry;
  eventBreakdown: {
    networkAttemptedEventIds: string[];
    skippedByBackoffEventIds: string[];
    fullyResolvedEventIds: string[];
    stillUnresolvedEventIds: string[];
  };
}

/**
 * A tier is allowed to return a score with confidence < 0.7; in that case
 * the waterfall treats it as a miss and tries the next tier. Keeps a cheap
 * but ambiguous source from silently overwriting a more confident one
 * that would have been reached downstream.
 */
const MIN_ACCEPT_CONFIDENCE = 0.7;

const accept = (s: MatchScore | null): s is MatchScore =>
  !!s && s.confidence >= MIN_ACCEPT_CONFIDENCE;

export interface ResolveOptions {
  /** Ask statistics-capable tiers to fetch corner counts. */
  needsCorners?: boolean;
  /** Ask statistics-capable tiers to fetch card (booking) counts. */
  needsBookings?: boolean;
  /**
   * The batch contains 1H or 2H scope bets that require half-time scores.
   * When true, cached scores missing htHome/htAway are treated as misses
   * so downstream tiers (SofaScore, API-Football) can provide the HT data.
   */
  needsHtScore?: boolean;
  /**
   * Skip Tier 0 (match_scores DB cache) for the given events. Useful
   * when the user re-runs a settlement and wants a fresh score rather
   * than the cached one — otherwise the waterfall short-circuits on
   * the cache hit and nothing changes.
   */
  bypassCache?: boolean;
  /**
   * Per-event settlement data requirements. When omitted, the batch-level
   * flags above apply to every event for backwards compatibility.
   */
  eventRequirements?: Map<string, SettlementDataRequirements>;
  /**
   * Events allowed to run network sources after the cache check. Events not
   * present here still read Tier 0 but are skipped by retry backoff when the
   * cache is insufficient.
   */
  networkEventIds?: Set<string>;
}

export interface SettlementDataRequirements {
  needsHtScore?: boolean;
  needsCorners?: boolean;
  needsBookings?: boolean;
}

type SourceName = "espn" | "sofascore" | "api-football";

const terminalVoidStatus = (s: MatchScore): boolean =>
  s.status === "ABD" || s.status === "POSTPONED";

const hasRequiredData = (
  s: MatchScore,
  req: SettlementDataRequirements,
): boolean => {
  if (terminalVoidStatus(s)) return true;
  if (s.ftHome == null || s.ftAway == null) return false;
  if (req.needsHtScore && (s.htHome == null || s.htAway == null)) return false;
  if (req.needsCorners && (s.cornersHome == null || s.cornersAway == null)) {
    return false;
  }
  if (
    req.needsBookings &&
    (s.bookingsHome == null || s.bookingsAway == null)
  ) {
    return false;
  }
  return true;
};

const mergeScore = (
  previous: MatchScore | undefined,
  next: MatchScore,
): MatchScore => {
  if (!previous) return next;
  return {
    ...previous,
    ...next,
    htHome: next.htHome ?? previous.htHome ?? null,
    htAway: next.htAway ?? previous.htAway ?? null,
    etHome: next.etHome ?? previous.etHome ?? null,
    etAway: next.etAway ?? previous.etAway ?? null,
    penHome: next.penHome ?? previous.penHome ?? null,
    penAway: next.penAway ?? previous.penAway ?? null,
    cornersHome: next.cornersHome ?? previous.cornersHome ?? null,
    cornersAway: next.cornersAway ?? previous.cornersAway ?? null,
    htCornersHome: next.htCornersHome ?? previous.htCornersHome ?? null,
    htCornersAway: next.htCornersAway ?? previous.htCornersAway ?? null,
    bookingsHome: next.bookingsHome ?? previous.bookingsHome ?? null,
    bookingsAway: next.bookingsAway ?? previous.bookingsAway ?? null,
  };
};

// ─── Main resolver ──────────────────────────────────────────────────────────

export async function resolveScores(
  events: SettleEvent[],
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const started = Date.now();
  const apiFootballQuotaAtStart = getApiFootballQuota();
  const telemetry: WaterfallTelemetry = {
    total: events.length,
    tier0_hits: 0,
    tier1_hits: 0,
    tier2_hits: 0,
    tier3_hits: 0,
    tier4_hits: 0,
    unresolved: 0,
    durationMs: 0,
    eventsTotal: events.length,
    eventsAttempted: 0,
    eventsSkippedByBackoff: 0,
    eventsResolvedFromCache: 0,
    eventsResolvedByEspn: 0,
    eventsResolvedBySofaScore: 0,
    eventsResolvedByApiFootball: 0,
    eventsStillUnresolved: 0,
    apiFootballRequestsUsed: 0,
    sourceIssues: [],
  };
  const scores = new Map<string, MatchScore>();
  const satisfied = new Set<string>();
  const networkAttemptedEventIds = new Set<string>();
  const skippedByBackoffEventIds = new Set<string>();
  if (events.length === 0) {
    telemetry.durationMs = Date.now() - started;
    return {
      scores,
      telemetry,
      eventBreakdown: {
        networkAttemptedEventIds: [],
        skippedByBackoffEventIds: [],
        fullyResolvedEventIds: [],
        stillUnresolvedEventIds: [],
      },
    };
  }

  const eventIds = events.map((e) => e.eventId);
  const defaultRequirements: SettlementDataRequirements = {
    needsHtScore: opts.needsHtScore === true,
    needsCorners: opts.needsCorners === true,
    needsBookings: opts.needsBookings === true,
  };
  const requirementsFor = (eventId: string): SettlementDataRequirements =>
    opts.eventRequirements?.get(eventId) ?? defaultRequirements;
  const allowedNetworkEventIds = opts.networkEventIds ?? new Set(eventIds);
  const canUseNetwork = (eventId: string): boolean =>
    allowedNetworkEventIds.has(eventId);
  const candidatesNeedingNetwork = (): SettleEvent[] =>
    events.filter((event) => {
      return !satisfied.has(event.eventId) && canUseNetwork(event.eventId);
    });
  const anyCandidateNeeds = (
    candidates: SettleEvent[],
    key: keyof SettlementDataRequirements,
  ): boolean => candidates.some((event) => requirementsFor(event.eventId)[key]);

  // `bypassCache` re-runs the waterfall but skips Tier 0 so free tiers
  // can produce a fresh score.
  const skipCache = opts.bypassCache === true;

  // ── Tier 0: DB cache ────────────────────────────────────────────────────────────
  //
  // Cache entries from earlier settlement runs may pre-date our current
  // data schema (e.g. corners were added later). If this batch needs
  // corner stats but the cached row lacks them, treat the cache as a
  // miss for that event so a downstream tier can enrich it.
  const cached = skipCache
    ? new Map<string, MatchScore>()
    : await getScoresByEventIds(eventIds);
  for (const [id, s] of cached) {
    scores.set(id, s);
    if (hasRequiredData(s, requirementsFor(id))) {
      satisfied.add(id);
      telemetry.eventsResolvedFromCache++;
    }
  }

  const persist = async (
    s: MatchScore,
    label: string,
    force = false,
  ): Promise<void> => {
    try {
      if (force) {
        await upsertScoreForce(s);
      } else {
        await saveScoreIfAbsent(s);
      }
    } catch (err) {
      logger.warn(
        "Waterfall",
        `${label} upsert for ${s.eventId} failed: ${(err as Error).message}`,
      );
    }
  };

  const recordSourceScores = async (
    fetched: Map<string, MatchScore>,
    source: SourceName,
    persistLabel: string,
  ): Promise<void> => {
    for (const [id, s] of fetched) {
      if (!accept(s)) continue;
      const previous = scores.get(id);
      const merged = mergeScore(previous, s);
      const req = requirementsFor(id);
      const sourceSatisfied = hasRequiredData(merged, req);
      const previousSatisfied = previous
        ? hasRequiredData(previous, req)
        : false;
      scores.set(id, merged);
      await persist(
        merged,
        persistLabel,
        sourceSatisfied &&
          (cached.has(id) || (!!previous && !previousSatisfied)),
      );
      if (!sourceSatisfied || satisfied.has(id)) continue;
      satisfied.add(id);
      if (source === "espn") telemetry.eventsResolvedByEspn++;
      else if (source === "sofascore") telemetry.eventsResolvedBySofaScore++;
      else telemetry.eventsResolvedByApiFootball++;
    }
  };

  const initialNetworkCandidates = candidatesNeedingNetwork();
  for (const event of initialNetworkCandidates) {
    networkAttemptedEventIds.add(event.eventId);
  }
  telemetry.eventsAttempted = networkAttemptedEventIds.size;

  // ── Tier 2a: ESPN (free, unauthenticated, ~85% of target leagues) ──────
  const t2aCandidates = candidatesNeedingNetwork();
  if (t2aCandidates.length > 0) {
    try {
      const t2a = await fetchEspnScores(t2aCandidates);
      if (t2a.size > 0) {
        const withCorners = anyCandidateNeeds(t2aCandidates, "needsCorners");
        const withBookings = anyCandidateNeeds(t2aCandidates, "needsBookings");
        if (withCorners || withBookings) {
          const { enriched } = await enrichEspnStats(t2a, t2aCandidates, {
            withCorners,
            withBookings,
          });
          if (enriched > 0) {
            logger.info(
              "Waterfall",
              `ESPN enriched ${enriched} events with requested stats.`,
            );
          }
        }
      }
      await recordSourceScores(t2a, "espn", "T2a-espn");
    } catch (err) {
      logger.warn(
        "Waterfall",
        `Tier 2a (ESPN) failed: ${(err as Error).message}`,
      );
    }
  }

  // ── Tier 2b: SofaScore (unofficial, broad coverage + HT/stats) ─────────
  const t2bCandidates = candidatesNeedingNetwork();
  if (t2bCandidates.length > 0) {
    try {
      const t2b = await fetchSofaScoreScores(t2bCandidates, {
        withCorners: anyCandidateNeeds(t2bCandidates, "needsCorners"),
        withBookings: anyCandidateNeeds(t2bCandidates, "needsBookings"),
      });
      await recordSourceScores(t2b, "sofascore", "T2b-sofa");
    } catch (err) {
      logger.warn(
        "Waterfall",
        `Tier 2b (SofaScore) failed: ${(err as Error).message}`,
      );
    }
  }

  // ── Tier 2c: API-Football (official, quota-guarded last resort) ────────
  const t2cCandidates = candidatesNeedingNetwork();
  if (t2cCandidates.length > 0) {
    try {
      const t2c = await fetchApiFootballScores(t2cCandidates);
      if (t2c.size > 0) {
        const withCorners = anyCandidateNeeds(t2cCandidates, "needsCorners");
        const withBookings = anyCandidateNeeds(t2cCandidates, "needsBookings");
        if (withCorners || withBookings) {
          const { enriched } = await enrichApiFootballStats(
            t2c,
            t2cCandidates,
            { withCorners, withBookings },
          );
          if (enriched > 0) {
            logger.info(
              "Waterfall",
              `API-Football enriched ${enriched} events with requested stats.`,
            );
          }
        }
      }
      await recordSourceScores(t2c, "api-football", "T2c-apifb");
    } catch (err) {
      logger.warn(
        "Waterfall",
        `Tier 2c (API-Football) failed: ${(err as Error).message}`,
      );
    }
  }

  for (const id of eventIds) {
    if (satisfied.has(id)) continue;
    if (!canUseNetwork(id)) skippedByBackoffEventIds.add(id);
  }

  // ── Source-health report ─────────────────────────────────────────────────
  const apiFbQuota = getApiFootballQuota();
  telemetry.apiFootballRequestsUsed = Math.max(
    0,
    apiFbQuota.used - apiFootballQuotaAtStart.used,
  );
  if (apiFbQuota.remaining === 0) {
    telemetry.sourceIssues.push(
      `API-Football daily limit exhausted (${apiFbQuota.used}/${apiFbQuota.dailyLimit}). Last-resort fallback is unavailable until midnight UTC.`,
    );
  } else if (apiFbQuota.remaining <= 10) {
    telemetry.sourceIssues.push(
      `API-Football quota low: ${apiFbQuota.remaining}/${apiFbQuota.dailyLimit} requests remaining.`,
    );
  }

  const sofaSession = getBrowserSessionStats();
  if (!sofaSession.alive) {
    telemetry.sourceIssues.push(
      `SofaScore transport is degraded after ${sofaSession.consecutiveFailures} consecutive direct/proxy failures. It will retry on next settlement tick.`,
    );
  }

  const stillUnresolvedEventIds = eventIds.filter((id) => !satisfied.has(id));
  telemetry.eventsSkippedByBackoff = skippedByBackoffEventIds.size;
  telemetry.eventsStillUnresolved = stillUnresolvedEventIds.length;
  telemetry.unresolved = telemetry.eventsStillUnresolved;
  telemetry.total = telemetry.eventsTotal;
  telemetry.tier0_hits = telemetry.eventsResolvedFromCache;
  telemetry.tier2_hits =
    telemetry.eventsResolvedByEspn +
    telemetry.eventsResolvedBySofaScore +
    telemetry.eventsResolvedByApiFootball;
  telemetry.durationMs = Date.now() - started;
  return {
    scores,
    telemetry,
    eventBreakdown: {
      networkAttemptedEventIds: [...networkAttemptedEventIds],
      skippedByBackoffEventIds: [...skippedByBackoffEventIds],
      fullyResolvedEventIds: [...satisfied],
      stillUnresolvedEventIds,
    },
  };
}
