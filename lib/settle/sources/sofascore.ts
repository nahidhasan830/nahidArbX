/**
 * Tier 2c — SofaScore unofficial API (curl_cffi TLS impersonation).
 *
 * Covers essentially every global football league with both HT and FT
 * scores cleanly. Used as the last free tier before the AI kill switch
 * — ESPN + API-Football run first because they're ToS-safe.
 *
 * Transport: Python curl_cffi subprocess (see ./sofascore-browser.ts).
 * SofaScore blocks all non-browser TLS fingerprints via Cloudflare, but
 * curl_cffi uses curl-impersonate with Chrome's BoringSSL cipher suite
 * to produce an identical JA3 fingerprint. No browser needed.
 *
 * Strategy: one GET per kickoff-date to
 *     /api/v1/sport/football/scheduled-events/{YYYY-MM-DD}
 *   (lists every finished match globally for that date — a single call
 *   covers hundreds of matches), then fuzzy-match our events against it
 *   by team names + kickoff window. No per-event lookup needed.
 *
 * Cost: $0 — no API key, no proxy credits, no browser, no external services.
 */

import { bestSim as compareTwoStrings } from "@/lib/matching/string-sim";
import type { SettleEvent } from "../waterfall";
import type { MatchScore } from "../types";
import { logger } from "../../shared/logger";
import { applyTeamAlias, learnTeamAlias } from "../aliases";
import { singleton } from "../../util/singleton";
import { fetchViaBrowser } from "./sofascore-browser";
import { verifySettlementMatch, AI_MAYBE_FLOOR } from "./ai-match";
import {
  addDays,
  differenceInCalendarDays,
  format,
  startOfDay,
} from "date-fns";

const MATCH_SCORE_THRESHOLD = 0.65;
const KICKOFF_WINDOW_MS = 90 * 60 * 1000; // 90 minutes — covers leagues where kickoff times differ between providers

// ─── Response shapes (SofaScore ships ~60 fields per event; we need ~6) ─────

interface SofaTeam {
  name: string;
  shortName?: string;
  nameCode?: string; // 3-letter code
  slug?: string;
}

interface SofaScoreLine {
  current?: number;
  period1?: number;
  period2?: number;
  normaltime?: number;
  extra1?: number;
  extra2?: number;
  penalties?: number;
}

interface SofaEventStatus {
  type: "finished" | "inprogress" | "notstarted" | "canceled" | "postponed";
  code?: number;
  description?: string;
}

interface SofaEvent {
  id: number;
  tournament?: { name?: string; slug?: string };
  homeTeam: SofaTeam;
  awayTeam: SofaTeam;
  homeScore: SofaScoreLine;
  awayScore: SofaScoreLine;
  status: SofaEventStatus;
  startTimestamp: number; // seconds
}

interface SofaScheduled {
  events?: SofaEvent[];
}

// ─── Matching ────────────────────────────────────────────────────────────────

// Noise tokens that rarely carry identity. Stripping them normalises
// "IF Gnistan" → "gnistan", "FC St. Pauli" → "st pauli", "Sheffield W"
// → "sheffield", "Hoffenheim II" → "hoffenheim".
const SUFFIX_NOISE =
  /\b(fc|cf|sc|ac|afc|cfc|fk|ii|iii|b|u21|u23|u19|u18|reserves|reserv|akademie|academy|women|w|wfc|wsl|jr|ladies|youth|u\d+|nd|1st|2nd|3rd|ifk|bk|if|ff|fk|ks|nk|ks|os|al|club|sportclub|klub|cd|cs|cs|ca|ca|al|calcio|futbol|football)\b/g;

// Transliterate characters that NFD+diacritic-removal misses because they
// have no canonical Unicode decomposition: ø/Ø (Danish/Norwegian),
// ə/Ə (Azerbaijani, sounds like 'a'), ı (Turkish/Azerbaijani dotless-i),
// đ/Đ (Croatian), ł/Ł (Polish).
const TRANSLITERATE: [RegExp, string][] = [
  [/ø/g, "o"],
  [/Ø/g, "o"],
  [/ə/g, "a"],
  [/Ə/g, "a"],
  [/ı/g, "i"],
  [/đ/g, "d"],
  [/Đ/g, "d"],
  [/ł/g, "l"],
  [/Ł/g, "l"],
];

const normalizeTeamName = (raw: string): string => {
  let s = raw.toLowerCase();
  for (const [from, to] of TRANSLITERATE) s = s.replace(from, to);
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(SUFFIX_NOISE, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const teamSimilarity = (a: string, b: string): number => {
  const na = normalizeTeamName(applyTeamAlias(a));
  const nb = normalizeTeamName(applyTeamAlias(b));
  if (!na || !nb) return 0;
  // Exact → 1.
  if (na === nb) return 1;
  // Substring on a token boundary ("hjk" vs "hjk helsinki") → 0.92.
  // This closes the gap the dice-coefficient leaves for short names.
  const shorter = na.length <= nb.length ? na : nb;
  const longer = shorter === na ? nb : na;
  if (shorter.length >= 3 && ` ${longer} `.includes(` ${shorter} `))
    return 0.92;
  return compareTwoStrings(na, nb);
};

const candidateNames = (t: SofaTeam): string[] =>
  [t.name, t.shortName, t.nameCode, t.slug].filter(
    (x): x is string => typeof x === "string" && x.length > 0,
  );

const mapStatus = (s: SofaEventStatus): MatchScore["status"] | null => {
  const d = (s.description ?? "").toLowerCase();

  if (s.type === "finished") {
    if (d.includes("aet") || d.includes("extra time")) return "AET";
    if (d.includes("penalt")) return "PEN";
    return "FT";
  }

  // If the match is currently in extra time or penalties, the 90-minute
  // regulation time is fully finished. We can extract the normaltime score.
  if (s.type === "inprogress") {
    if (d.includes("penalt")) return "PEN";
    if (d.includes("aet") || d.includes("extra time")) return "AET";
  }

  if (s.type === "canceled") return "ABD";
  if (s.type === "postponed") return "POSTPONED";
  return null;
};

// ─── Fetch one day's global scheduled-events ────────────────────────────────

type DayEventsCacheEntry = {
  fetchedAt: number;
  events: SofaEvent[];
};

const SOFASCORE_LIVE_CACHE_TTL_MS = 2 * 60 * 1000;
const SOFASCORE_HISTORICAL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const eventsByDate = singleton<Map<string, DayEventsCacheEntry>>(
  "settle:sofascore:day-events",
  () => new Map(),
);

export const getDayEventsCacheTtlMs = (
  date: string,
  nowMs: number = Date.now(),
): number => {
  const dateMs = Date.parse(`${date}T00:00:00`);
  if (!Number.isFinite(dateMs)) return SOFASCORE_LIVE_CACHE_TTL_MS;
  const deltaDays = Math.abs(
    differenceInCalendarDays(new Date(dateMs), startOfDay(new Date(nowMs))),
  );
  return deltaDays <= 1
    ? SOFASCORE_LIVE_CACHE_TTL_MS
    : SOFASCORE_HISTORICAL_CACHE_TTL_MS;
};

export const shouldUseDayEventsCache = (
  date: string,
  fetchedAt: number,
  nowMs: number = Date.now(),
): boolean => nowMs - fetchedAt < getDayEventsCacheTtlMs(date, nowMs);

const fetchDayEvents = async (date: string): Promise<SofaEvent[]> => {
  // Same-day scoreboards mutate throughout the day. A permanent cache
  // freezes pre-FT results and leaves recent matches unresolved across
  // every later settlement tick. Cache recent dates only briefly; keep
  // older dates warm much longer because their results no longer change.
  const cached = eventsByDate.get(date);
  if (cached && shouldUseDayEventsCache(date, cached.fetchedAt)) {
    return cached.events;
  }

  // Single call to the scheduled-events endpoint. The `inverse` variant was
  // dropped because it returns ALL sports (35+ MB, 10k events) — far too large
  // for subprocess transport. The regular endpoint already returns all football
  // matches for the date (800+ on busy days) which covers our settlement needs.
  const path = `/api/v1/sport/football/scheduled-events/${date}`;
  const collected: SofaEvent[] = [];

  const data = await fetchViaBrowser<SofaScheduled>(path);
  if (data) {
    for (const e of data.events ?? []) {
      collected.push(e);
    }
  }

  eventsByDate.set(date, { fetchedAt: Date.now(), events: collected });
  return collected;
};

// ─── Main entry ──────────────────────────────────────────────────────────────

/**
 * Statistics payload shape — we care about cornerKicks, yellowCards,
 * and redCards rows.
 */
interface SofaStatGroup {
  statisticsItems?: {
    key?: string;
    name?: string;
    homeValue?: number;
    awayValue?: number;
  }[];
}
interface SofaStatsResponse {
  statistics?: { groups?: SofaStatGroup[] }[];
}

/** Extracted match statistics from SofaScore's /event/{id}/statistics. */
interface EventStats {
  corners?: { home: number; away: number };
  /**
   * Booking points per team (Pinnacle convention):
   * 1 pt per yellow card + 2 pts per red card.
   */
  bookings?: { home: number; away: number };
}

/**
 * Best-effort per-event statistics fetch. SofaScore's statistics response
 * is grouped by category; we flatten to find `cornerKicks`, `yellowCards`,
 * and `redCards`. Silent null-return on 403/404 so stats are treated as
 * unavailable rather than blocking settlement.
 */
const fetchEventStats = async (
  sofaEventId: number,
): Promise<EventStats | null> => {
  const data = await fetchViaBrowser<SofaStatsResponse>(
    `/api/v1/event/${sofaEventId}/statistics`,
  );
  if (!data) return null;

  let cornersHome: number | null = null;
  let cornersAway: number | null = null;
  let yellowHome: number | null = null;
  let yellowAway: number | null = null;
  let redHome: number | null = null;
  let redAway: number | null = null;

  for (const period of data.statistics ?? []) {
    for (const g of period.groups ?? []) {
      for (const item of g.statisticsItems ?? []) {
        if (
          item.key === "cornerKicks" &&
          item.homeValue != null &&
          item.awayValue != null
        ) {
          cornersHome = item.homeValue;
          cornersAway = item.awayValue;
        }
        if (
          item.key === "yellowCards" &&
          item.homeValue != null &&
          item.awayValue != null
        ) {
          yellowHome = item.homeValue;
          yellowAway = item.awayValue;
        }
        if (
          item.key === "redCards" &&
          item.homeValue != null &&
          item.awayValue != null
        ) {
          redHome = item.homeValue;
          redAway = item.awayValue;
        }
      }
    }
  }

  const result: EventStats = {};
  if (cornersHome != null && cornersAway != null) {
    result.corners = { home: cornersHome, away: cornersAway };
  }
  // Booking points: 1 per yellow + 2 per red (Pinnacle convention).
  // If we have yellows, assume 0 reds when reds aren't reported.
  if (yellowHome != null && yellowAway != null) {
    result.bookings = {
      home: yellowHome + 2 * (redHome ?? 0),
      away: yellowAway + 2 * (redAway ?? 0),
    };
  }
  return Object.keys(result).length > 0 ? result : null;
};

/**
 * Resolve final scores via SofaScore. Groups events by local date,
 * fetches one scheduled-events/{date} payload per unique date, then
 * fuzzy-matches our events against the returned catalog.
 *
 * Pass `withCorners: true` to also fetch per-event corner stats.
 * Pass `withBookings: true` to also fetch per-event card (booking) stats.
 * Both share a single HTTP call per resolved event via `fetchEventStats`.
 */
export async function fetchSofaScoreScores(
  events: SettleEvent[],
  opts: { withCorners?: boolean; withBookings?: boolean } = {},
): Promise<Map<string, MatchScore>> {
  const out = new Map<string, MatchScore>();
  if (events.length === 0) return out;

  // Unique local dates needed — pad one day each side so provider catalog
  // boundaries still match.
  const dateSet = new Set<string>();
  for (const e of events) {
    const start = new Date(e.startTime);
    for (const offset of [-1, 0, 1]) {
      dateSet.add(format(addDays(start, offset), "yyyy-MM-dd"));
    }
  }

  const allEvents: SofaEvent[] = [];
  for (const d of [...dateSet].sort()) {
    allEvents.push(...(await fetchDayEvents(d)));
    // Gentle pacing: 1 req/sec keeps us well under the unpublished cap.
    await new Promise((r) => setTimeout(r, 1_100));
  }

  if (allEvents.length === 0) {
    logger.debug(
      "SofaScoreSource",
      `No events returned for any of ${dateSet.size} dates.`,
    );
    return out;
  }

  // Fuzzy-match each of our events against the SofaScore catalog.
  for (const ours of events) {
    const ourStart = new Date(ours.startTime).getTime();
    let best: { event: SofaEvent; score: number } | null = null;

    for (const theirs of allEvents) {
      const kickoff = theirs.startTimestamp * 1000;
      if (Math.abs(kickoff - ourStart) > KICKOFF_WINDOW_MS) continue;

      const homeSim = Math.max(
        0,
        ...candidateNames(theirs.homeTeam).map((n) =>
          teamSimilarity(ours.homeTeam, n),
        ),
      );
      const awaySim = Math.max(
        0,
        ...candidateNames(theirs.awayTeam).map((n) =>
          teamSimilarity(ours.awayTeam, n),
        ),
      );
      const combined = (homeSim + awaySim) / 2;
      if (combined < AI_MAYBE_FLOOR) continue; // Too different even for AI

      if (!best || combined > best.score)
        best = { event: theirs, score: combined };
    }

    if (!best) continue;

    // If the best match is below the deterministic threshold, ask AI
    if (best.score < MATCH_SCORE_THRESHOLD) {
      const aiResult = await verifySettlementMatch({
        ourHomeTeam: ours.homeTeam,
        ourAwayTeam: ours.awayTeam,
        ourCompetition: ours.competition,
        ourStartTime: ours.startTime,
        theirHomeTeam: best.event.homeTeam.name,
        theirAwayTeam: best.event.awayTeam.name,
        theirStartTime: new Date(
          best.event.startTimestamp * 1000,
        ).toISOString(),
        fuzzySimilarity: best.score,
        sourceProvider: "sofascore",
      });

      if (!aiResult?.confirmed) continue;
      best.score = Math.max(best.score, 0.85);
    }

    const status = mapStatus(best.event.status);
    if (!status) continue;

    if (status === "POSTPONED" || status === "ABD") {
      out.set(ours.eventId, {
        eventId: ours.eventId,
        status,
        htHome: null,
        htAway: null,
        ftHome: 0,
        ftAway: 0,
        source: "sofascore",
        confidence: 0.6 + best.score * 0.35,
        sourceUrl: `https://www.sofascore.com/event/${best.event.id}`,
      });
      continue;
    }

    const ftH =
      best.event.homeScore.normaltime ??
      (best.event.homeScore.period1 != null &&
      best.event.homeScore.period2 != null
        ? best.event.homeScore.period1 + best.event.homeScore.period2
        : (best.event.homeScore.current ?? null));
    const ftA =
      best.event.awayScore.normaltime ??
      (best.event.awayScore.period1 != null &&
      best.event.awayScore.period2 != null
        ? best.event.awayScore.period1 + best.event.awayScore.period2
        : (best.event.awayScore.current ?? null));
    if (ftH == null || ftA == null) continue;

    out.set(ours.eventId, {
      eventId: ours.eventId,
      status,
      htHome: best.event.homeScore.period1 ?? null,
      htAway: best.event.awayScore.period1 ?? null,
      ftHome: ftH,
      ftAway: ftA,
      etHome: best.event.homeScore.extra1 ?? null,
      etAway: best.event.awayScore.extra1 ?? null,
      penHome: best.event.homeScore.penalties ?? null,
      penAway: best.event.awayScore.penalties ?? null,
      source: "sofascore",
      confidence: 0.6 + best.score * 0.35,
      sourceUrl: `https://www.sofascore.com/event/${best.event.id}`,
    });

    // Learn team name equivalences on every confirmed match. The alias
    // store dedupes + normalises direction, so repeat calls are cheap
    // no-ops once the canonical form is recorded.
    try {
      if (best.event.homeTeam.name) {
        learnTeamAlias(ours.homeTeam, best.event.homeTeam.name);
      }
      if (best.event.awayTeam.name) {
        learnTeamAlias(ours.awayTeam, best.event.awayTeam.name);
      }
    } catch (err) {
      logger.debug(
        "SofaScoreSource",
        `learnTeamAlias failed (non-fatal): ${(err as Error).message}`,
      );
    }
  }

  // Optional second pass: per-event statistics fetch (corners and/or bookings).
  // Both stats come from the same /event/{id}/statistics endpoint, so one
  // HTTP call serves both needs — we only fire this pass when at least one
  // stat type was requested.
  const needsStats = opts.withCorners || opts.withBookings;
  if (needsStats) {
    for (const [eventId, score] of out) {
      // Score currently lacks an embedded sofa id; recover it from the URL.
      const m = score.sourceUrl?.match(/\/event\/(\d+)/);
      if (!m) continue;
      const sofaId = Number.parseInt(m[1], 10);
      const stats = await fetchEventStats(sofaId);
      await new Promise((r) => setTimeout(r, 350));
      if (!stats) continue;
      if (opts.withCorners && stats.corners) {
        score.cornersHome = stats.corners.home;
        score.cornersAway = stats.corners.away;
      }
      if (opts.withBookings && stats.bookings) {
        score.bookingsHome = stats.bookings.home;
        score.bookingsAway = stats.bookings.away;
      }
      out.set(eventId, score);
    }
  }

  if (out.size > 0) {
    const extras: string[] = [];
    if (opts.withCorners) extras.push("corners");
    if (opts.withBookings) extras.push("bookings");
    logger.info(
      "SofaScoreSource",
      `Resolved ${out.size}/${events.length} events via SofaScore${extras.length ? ` (with ${extras.join(", ")})` : ""}`,
    );
  }
  return out;
}
