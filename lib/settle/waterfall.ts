/**
 * Settlement waterfall: resolves a final MatchScore for a set of eventIds
 * at the cheapest available tier. Each tier runs only on events still
 * missing a score after the previous tier.
 *
 *   Tier 0  match_scores table (permanent cache)          — free
 *   Tier 1  multi-source-store (Pinnacle WS + BC poller)  — free
 *   Tier 2  free sports APIs (football-data / pinnacle)   — free  [Phase 2]
 *   Tier 3  Gemini + url_context                          — ~$0.0003/match [Phase 3]
 *   Tier 4  Gemini Batch API (overnight)                  — ~$0.014/match [Phase 4]
 *
 * Tier 0 is read-only; tiers 1+ upsert their discoveries back into
 * match_scores so subsequent settlement requests are instantly free.
 */

import type { MatchScore } from "./types";
import {
  getScoresByEventIds,
  saveScoreIfAbsent,
  upsertScoreForce,
} from "../db/repositories/match-scores";
import { readLiveFeedScore } from "./sources/live-feed";
import { fetchEspnScores } from "./sources/espn";
import { fetchSofaScoreScores } from "./sources/sofascore";
import { fetchUrlContextScores } from "./sources/url-context";
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
  /**
   * Allow the paid Tier 3 (Gemini url_context) to run for events the
   * free tiers couldn't resolve. Default is **false** — the automatic
   * background scheduler never calls AI. Only the manual "AI settle"
   * button in the UI opts in.
   */
  allowAi?: boolean;
  /**
   * Skip Tier 0 (match_scores DB cache) for the given events. Useful
   * when the user re-runs a settlement and wants a fresh score rather
   * than the cached one — otherwise the waterfall short-circuits on
   * the cache hit and nothing changes.
   */
  bypassCache?: boolean;
  /**
   * Skip Tier 0/1/2 entirely and send every event directly to Tier 3
   * (Gemini url_context). Implies `allowAi: true`. Used by the re-run
   * menu's "AI — {tier}" options.
   */
  forceAi?: boolean;
  /**
   * Model tier to use when Tier 3 fires. Defaults to Lite server-side.
   */
  aiModel?: "lite" | "flash" | "pro";
}

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
  };
  const scores = new Map<string, MatchScore>();
  if (events.length === 0) {
    telemetry.durationMs = Date.now() - started;
    return { scores, telemetry };
  }

  const eventIds = events.map((e) => e.eventId);
  const metaById = new Map(events.map((e) => [e.eventId, e]));

  // `forceAi` implies bypassing every free tier and going straight to
  // Gemini — it's only set by the re-run UI when the user explicitly
  // picks an AI model. `bypassCache` is a softer variant: re-runs the
  // waterfall but skips Tier 0 so free tiers can produce a fresh score.
  const skipCache = opts.bypassCache === true || opts.forceAi === true;
  const skipFreeTiers = opts.forceAi === true;

  // ── Tier 0: DB cache ──────────────────────────────────────────────────────
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
    if (cornersRequiredButMissing) continue;
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

  // ── Tier 1: in-memory live feeds ─────────────────────────────────────────
  if (!skipFreeTiers) {
    for (const id of stillMissingIds()) {
      const s = readLiveFeedScore(id);
      if (accept(s)) {
        scores.set(id, s);
        telemetry.tier1_hits++;
        await persist(s, "T1");
      }
    }

    // ── Tier 2a: ESPN (free, unauthenticated, ~85% of target leagues) ──────
    //
    // Primary free-tier source. Covers Allsvenskan, 2. Bundesliga, Serie B,
    // Eliteserien, Super Lig, PSL, etc. — the bulk of the user's DB. Only
    // returns FT (no HT), so HT-scope bets fall through to 2b/3.
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

    // ── Tier 2b: SofaScore (unofficial, ~100% global coverage + HT) ────────
    //
    // Last free tier before AI. Returns HT + FT + corners.
    const t2bCandidates = stillMissingEvents();
    if (t2bCandidates.length > 0) {
      try {
        const t2b = await fetchSofaScoreScores(t2bCandidates, {
          withCorners: opts.needsCorners === true,
        });
        for (const [id, s] of t2b) {
          if (!accept(s)) continue;
          scores.set(id, s);
          telemetry.tier2_hits++;
          await persist(s, "T2b-sofa");
        }
      } catch (err) {
        logger.warn(
          "Waterfall",
          `Tier 2b (SofaScore) failed: ${(err as Error).message}`,
        );
      }
    }
  }

  // ── Corner-enrichment pass ────────────────────────────────────────────────
  //
  // Earlier tiers (ESPN, football-data) don't report corners. If the
  // batch needs corners and we have events still missing them, query
  // SofaScore once more specifically for those — merge stats into the
  // existing score (keep its FT/HT from the trusted source).
  if (opts.needsCorners === true) {
    const needingCorners: SettleEvent[] = [];
    for (const [id, s] of scores) {
      if (s.cornersHome == null || s.cornersAway == null) {
        const meta = metaById.get(id);
        if (meta) needingCorners.push(meta);
      }
    }
    if (needingCorners.length > 0) {
      try {
        const enriched = await fetchSofaScoreScores(needingCorners, {
          withCorners: true,
        });
        for (const [id, s] of enriched) {
          if (s.cornersHome == null || s.cornersAway == null) continue;
          const existing = scores.get(id);
          if (!existing) continue;
          // Keep the primary source's goals — only borrow corners.
          const merged: MatchScore = {
            ...existing,
            cornersHome: s.cornersHome,
            cornersAway: s.cornersAway,
            htCornersHome: s.htCornersHome ?? existing.htCornersHome ?? null,
            htCornersAway: s.htCornersAway ?? existing.htCornersAway ?? null,
          };
          scores.set(id, merged);
          await persist(merged, "corner-enrich");
        }
      } catch (err) {
        logger.warn(
          "Waterfall",
          `Corner enrichment via SofaScore failed: ${(err as Error).message}`,
        );
      }
    }
  }

  // ── Tier 3: Gemini url_context (paid long-tail resolver) ────────────────
  //
  // OFF by default. Only fires when the caller explicitly opts in via
  // `allowAi: true` — the automatic background scheduler never does.
  // The UI's "AI settle" button is the only production trigger.
  // Safety net: the adapter throws `UrlContextBatchAbort` if Gemini
  // returns a spend-cap or quota-exhausted error, short-circuiting the
  // batch so a bad response can't hammer the API in a loop.
  const t3Candidates = stillMissingEvents();
  const aiUnlocked = opts.allowAi === true || opts.forceAi === true;
  if (t3Candidates.length > 0 && process.env.GEMINI_API_KEY && aiUnlocked) {
    try {
      const t3 = await fetchUrlContextScores(t3Candidates, 3, {
        model: opts.aiModel,
      });
      for (const [id, s] of t3) {
        if (!accept(s)) continue;
        scores.set(id, s);
        telemetry.tier3_hits++;
        // `forceAi` re-runs force-upsert the new result so the cache's
        // prior source (e.g. ESPN) is replaced by the fresh AI one.
        if (opts.forceAi) {
          await upsertScoreForce(s);
        } else {
          await persist(s, "T3");
        }
      }
    } catch (err) {
      logger.warn(
        "Waterfall",
        `Tier 3 (url_context) failed: ${(err as Error).message}`,
      );
    }
  }

  // ── Tier 4: Batch API deep fallback (Phase 4) ─────────────────────────────
  // Wired up by the continuous settlement loop, not by this function —
  // resolveScores is synchronous-return so we don't block real-time
  // settlement on a 24h batch job.

  telemetry.unresolved = eventIds.length - scores.size;
  telemetry.durationMs = Date.now() - started;
  return { scores, telemetry };
}
