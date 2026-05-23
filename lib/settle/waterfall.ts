/**
 * Settlement waterfall: resolves a final MatchScore for a set of eventIds
 * at the cheapest available tier. Each tier runs only on events still
 * missing a score after the previous tier.
 *
 *   Tier 0  match_scores table (permanent cache)          — free
 *   Tier 2a free sports APIs: ESPN scoreboard             — free, unlimited
 *   Tier 2b free sports APIs: API-Football                — free, 100 req/day
 *   Tier 2c SofaScore (unofficial, best-effort)           — free, CF-blocked
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
  /** Ask statistics-capable tiers (SofaScore) to fetch corner counts. */
  needsCorners?: boolean;
  /** Ask statistics-capable tiers (SofaScore) to fetch card (booking) counts. */
  needsBookings?: boolean;
  /**
   * The batch contains 1H or 2H scope bets that require half-time scores.
   * When true, cached scores missing htHome/htAway are treated as misses
   * so downstream tiers (API-Football, SofaScore) can provide the HT data.
   */
  needsHtScore?: boolean;
  /**
   * Skip Tier 0 (match_scores DB cache) for the given events. Useful
   * when the user re-runs a settlement and wants a fresh score rather
   * than the cached one — otherwise the waterfall short-circuits on
   * the cache hit and nothing changes.
   */
  bypassCache?: boolean;
}

// ─── Enrichment helpers ─────────────────────────────────────────────────────
//
// Both corners and bookings enrichment follow the same 3-tier cascade:
//   1. ESPN (free, unlimited)
//   2. API-Football (official, 100 req/day)
//   3. SofaScore (unofficial, CF-blocked)
//
// Instead of duplicating 90 lines per stat type, we extract a single
// `enrichStats()` that parameterizes which stat to enrich.

type StatType = "corners" | "bookings";

/**
 * Check if a score is still missing a specific stat type.
 */
const isMissingStat = (s: MatchScore, stat: StatType): boolean => {
  if (stat === "corners") return s.cornersHome == null || s.cornersAway == null;
  return s.bookingsHome == null || s.bookingsAway == null;
};

/**
 * Run the ESPN → API-Football → SofaScore enrichment cascade for a single
 * stat type (corners or bookings). Mutates the `scores` map in place.
 */
async function enrichStats(
  stat: StatType,
  scores: Map<string, MatchScore>,
  events: SettleEvent[],
  cached: Map<string, MatchScore>,
  persist: (s: MatchScore, label: string) => Promise<void>,
  metaById: Map<string, SettleEvent>,
): Promise<void> {
  const opts =
    stat === "corners"
      ? { withCorners: true as const }
      : { withBookings: true as const };

  // 1. ESPN — primary source, free and unlimited.
  try {
    const { enriched } = await enrichEspnStats(scores, events, opts);
    for (const [, s] of scores) {
      if (!isMissingStat(s, stat)) await persist(s, `${stat}-enrich-espn`);
    }
    if (enriched > 0) {
      logger.info(
        "Waterfall",
        `ESPN enriched ${enriched} events with ${stat}.`,
      );
    }
  } catch (err) {
    logger.warn(
      "Waterfall",
      `${stat} enrichment via ESPN failed: ${(err as Error).message}`,
    );
  }

  // 2. API-Football — fallback for ESPN gaps.
  try {
    const { enriched } = await enrichApiFootballStats(scores, events, opts);
    for (const [, s] of scores) {
      if (!isMissingStat(s, stat)) await persist(s, `${stat}-enrich-apifb`);
    }
    if (enriched > 0) {
      logger.info(
        "Waterfall",
        `API-Football enriched ${enriched} events with ${stat}.`,
      );
    }
  } catch (err) {
    logger.warn(
      "Waterfall",
      `${stat} enrichment via API-Football failed: ${(err as Error).message}`,
    );
  }

  // 3. SofaScore — last-resort fallback for events still missing the stat.
  const needingEnrichment: SettleEvent[] = [];
  for (const [id, s] of scores) {
    if (isMissingStat(s, stat)) {
      const meta = metaById.get(id);
      if (meta) needingEnrichment.push(meta);
    }
  }
  if (needingEnrichment.length === 0) return;
  try {
    const enriched = await fetchSofaScoreScores(needingEnrichment, opts);
    for (const [id, s] of enriched) {
      if (isMissingStat(s, stat)) continue;
      const existing = scores.get(id);
      if (!existing) continue;
      // Keep the primary source's goals — only borrow the stats.
      const merged: MatchScore = { ...existing };
      if (stat === "corners") {
        merged.cornersHome = s.cornersHome;
        merged.cornersAway = s.cornersAway;
        merged.htCornersHome =
          s.htCornersHome ?? existing.htCornersHome ?? null;
        merged.htCornersAway =
          s.htCornersAway ?? existing.htCornersAway ?? null;
      } else {
        merged.bookingsHome = s.bookingsHome;
        merged.bookingsAway = s.bookingsAway;
      }
      scores.set(id, merged);
      await persist(merged, `${stat}-enrich-sofa`);
    }
  } catch (err) {
    logger.warn(
      "Waterfall",
      `${stat} enrichment via SofaScore failed: ${(err as Error).message}`,
    );
  }
}

// ─── Main resolver ──────────────────────────────────────────────────────────

export async function resolveScores(
  events: SettleEvent[],
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const started = Date.now();
  const telemetry: WaterfallTelemetry = {
    total: events.length,
    tier0_hits: 0,
    tier1_hits: 0,
    tier2_hits: 0,
    tier3_hits: 0,
    tier4_hits: 0,
    unresolved: 0,
    durationMs: 0,
    sourceIssues: [],
  };
  const scores = new Map<string, MatchScore>();
  if (events.length === 0) {
    telemetry.durationMs = Date.now() - started;
    return { scores, telemetry };
  }

  const eventIds = events.map((e) => e.eventId);
  const metaById = new Map(events.map((e) => [e.eventId, e]));

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
    const cornersRequiredButMissing =
      opts.needsCorners === true &&
      (s.cornersHome == null || s.cornersAway == null);
    const bookingsRequiredButMissing =
      opts.needsBookings === true &&
      (s.bookingsHome == null || s.bookingsAway == null);
    const htRequiredButMissing =
      opts.needsHtScore === true && (s.htHome == null || s.htAway == null);
    if (
      cornersRequiredButMissing ||
      bookingsRequiredButMissing ||
      htRequiredButMissing
    )
      continue;
    scores.set(id, s);
    telemetry.tier0_hits++;
  }
  const stillMissingIds = () => eventIds.filter((id) => !scores.has(id));
  const stillMissingEvents = () =>
    stillMissingIds()
      .map((id) => metaById.get(id))
      .filter((e): e is SettleEvent => !!e);

  const persist = async (s: MatchScore, label: string): Promise<void> => {
    try {
      // If we're enriching a cached row with corners we already had the
      // gist of, force-upsert so the cache gains the new stats instead
      // of silently keeping the old stat-less row.
      const enrichingCorners =
        opts.needsCorners === true &&
        s.cornersHome != null &&
        s.cornersAway != null &&
        cached.has(s.eventId);
      if (enrichingCorners) {
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

  // ── Tier 2a: ESPN (free, unauthenticated, ~85% of target leagues) ──────
  const t2aCandidates = stillMissingEvents();
  if (t2aCandidates.length > 0) {
    try {
      const t2a = await fetchEspnScores(t2aCandidates);
      for (const [id, s] of t2a) {
        if (!accept(s)) continue;
        scores.set(id, s);
        telemetry.tier2_hits++;
        await persist(s, "T2a-espn");
      }
    } catch (err) {
      logger.warn(
        "Waterfall",
        `Tier 2a (ESPN) failed: ${(err as Error).message}`,
      );
    }
  }

  // ── Tier 2b: API-Football (official, 100 req/day free, 1000+ leagues) ──
  const t2bCandidates = stillMissingEvents();
  if (t2bCandidates.length > 0) {
    try {
      const t2b = await fetchApiFootballScores(t2bCandidates);
      for (const [id, s] of t2b) {
        if (!accept(s)) continue;
        scores.set(id, s);
        telemetry.tier2_hits++;
        await persist(s, "T2b-apifb");
      }
    } catch (err) {
      logger.warn(
        "Waterfall",
        `Tier 2b (API-Football) failed: ${(err as Error).message}`,
      );
    }
  }

  // ── Tier 2c: SofaScore (unofficial, ~100% global coverage + HT) ────────
  const t2cCandidates = stillMissingEvents();
  if (t2cCandidates.length > 0) {
    try {
      const t2c = await fetchSofaScoreScores(t2cCandidates, {
        withCorners: opts.needsCorners === true,
        withBookings: opts.needsBookings === true,
      });
      for (const [id, s] of t2c) {
        if (!accept(s)) continue;
        scores.set(id, s);
        telemetry.tier2_hits++;
        await persist(s, "T2c-sofa");
      }
    } catch (err) {
      logger.warn(
        "Waterfall",
        `Tier 2c (SofaScore) failed: ${(err as Error).message}`,
      );
    }
  }

  // ── Stat enrichment passes ────────────────────────────────────────────────
  //
  // Each stat type uses the same ESPN → API-Football → SofaScore cascade.
  if (opts.needsCorners === true) {
    await enrichStats("corners", scores, events, cached, persist, metaById);
  }
  if (opts.needsBookings === true) {
    await enrichStats("bookings", scores, events, cached, persist, metaById);
  }

  // ── HT-enrichment pass ────────────────────────────────────────────────────
  //
  // Scores sourced from ESPN often lack HT data. If this batch has 1H/2H
  // bets and some resolved scores are still missing htHome/htAway, try
  // API-Football → SofaScore to fill in the HT gaps.
  if (opts.needsHtScore === true) {
    const needingHt: SettleEvent[] = [];
    for (const [id, s] of scores) {
      if (s.htHome == null || s.htAway == null) {
        const meta = metaById.get(id);
        if (meta) needingHt.push(meta);
      }
    }
    if (needingHt.length > 0) {
      // 1. API-Football (official API, provides clean HT).
      try {
        const t2b = await fetchApiFootballScores(needingHt);
        for (const [id, s] of t2b) {
          if (s.htHome == null || s.htAway == null) continue;
          const existing = scores.get(id);
          if (!existing) continue;
          // Keep the primary source's FT goals — only borrow HT.
          const merged: MatchScore = {
            ...existing,
            htHome: s.htHome,
            htAway: s.htAway,
          };
          scores.set(id, merged);
          await upsertScoreForce(merged);
        }
      } catch (err) {
        logger.warn(
          "Waterfall",
          `HT enrichment via API-Football failed: ${(err as Error).message}`,
        );
      }

      // 2. SofaScore fallback for events still missing HT.
      const stillNeedingHt: SettleEvent[] = [];
      for (const [id, s] of scores) {
        if (s.htHome == null || s.htAway == null) {
          const meta = metaById.get(id);
          if (meta) stillNeedingHt.push(meta);
        }
      }
      if (stillNeedingHt.length > 0) {
        try {
          const sofa = await fetchSofaScoreScores(stillNeedingHt, {});
          for (const [id, s] of sofa) {
            if (s.htHome == null || s.htAway == null) continue;
            const existing = scores.get(id);
            if (!existing) continue;
            const merged: MatchScore = {
              ...existing,
              htHome: s.htHome,
              htAway: s.htAway,
            };
            scores.set(id, merged);
            await upsertScoreForce(merged);
          }
        } catch (err) {
          logger.warn(
            "Waterfall",
            `HT enrichment via SofaScore failed: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  // ── Source-health report ─────────────────────────────────────────────────
  const apiFbQuota = getApiFootballQuota();
  if (apiFbQuota.remaining === 0) {
    telemetry.sourceIssues.push(
      `API-Football daily limit exhausted (${apiFbQuota.used}/${apiFbQuota.dailyLimit}). Niche-league fallback unavailable until midnight UTC.`,
    );
  } else if (apiFbQuota.remaining <= 10) {
    telemetry.sourceIssues.push(
      `API-Football quota low: ${apiFbQuota.remaining}/${apiFbQuota.dailyLimit} requests remaining.`,
    );
  }

  const sofaSession = getBrowserSessionStats();
  if (!sofaSession.alive) {
    telemetry.sourceIssues.push(
      `SofaScore browser session is not active. It will auto-start on next settlement tick.`,
    );
  }

  telemetry.unresolved = eventIds.length - scores.size;
  telemetry.durationMs = Date.now() - started;
  return { scores, telemetry };
}
