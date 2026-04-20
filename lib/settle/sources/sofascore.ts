/**
 * Tier 2c — SofaScore unofficial API.
 *
 * Covers essentially every global football league with both HT and FT
 * scores cleanly. Used as the last free tier before the AI kill switch
 * — ESPN + football-data run first because they're ToS-safe.
 *
 * Risks, accepted deliberately:
 *   - Unofficial API, subject to change without notice.
 *   - Cloudflare bot-protected. Cloud-provider IPs (Vercel, AWS) often
 *     get 403s; residential IPs and rate-limited traffic usually pass.
 *   - Gray-area ToS. Fine for one-time backlog settlement; if this
 *     becomes a hot path in production, revisit.
 *
 * Strategy: one GET per kickoff-date to
 *     api.sofascore.com/api/v1/sport/football/scheduled-events/{YYYY-MM-DD}
 *   (lists every finished match globally for that date — a single call
 *   covers hundreds of matches), then fuzzy-match our events against it
 *   by team names + kickoff window. No per-event lookup needed.
 */

import axios from "axios";
import { compareTwoStrings } from "string-similarity";
import type { SettleEvent } from "../waterfall";
import type { MatchScore } from "../types";
import { logger } from "../../shared/logger";
import { applyTeamAlias, learnTeamAlias } from "../aliases";

const BASE_URL = "https://api.sofascore.com/api/v1";
const MATCH_SCORE_THRESHOLD = 0.7;
const KICKOFF_WINDOW_MS = 45 * 60 * 1000;
const HTTP_TIMEOUT_MS = 15_000;

/**
 * Browser-ish headers defeat the laziest of Cloudflare's fingerprinters.
 * Not a silver bullet — if SofaScore starts returning 403s from our IP
 * range, expect the fallback chain to short-circuit at this tier.
 */
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.sofascore.com/",
  Origin: "https://www.sofascore.com",
};

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

const normalizeTeamName = (raw: string): string =>
  raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(SUFFIX_NOISE, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

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

const eventsByDate = new Map<string, SofaEvent[]>();

const fetchDayEvents = async (date: string): Promise<SofaEvent[]> => {
  // In-memory cache within one process — a 100-bet test may request the
  // same date multiple times, no need to hammer SofaScore.
  const cached = eventsByDate.get(date);
  if (cached) return cached;

  // Query both the default scheduled-events endpoint AND the `inverse`
  // variant (which includes additional matches not in the primary list,
  // e.g. late-added fixtures / niche competitions SofaScore sometimes
  // hides behind the inverse flag).
  const urls = [
    `${BASE_URL}/sport/football/scheduled-events/${date}`,
    `${BASE_URL}/sport/football/scheduled-events/${date}/inverse`,
  ];
  const collected: SofaEvent[] = [];
  const seenIds = new Set<number>();

  for (const url of urls) {
    try {
      const { data } = await axios.get<SofaScheduled>(url, {
        headers: BROWSER_HEADERS,
        timeout: HTTP_TIMEOUT_MS,
      });
      for (const e of data.events ?? []) {
        if (seenIds.has(e.id)) continue;
        seenIds.add(e.id);
        collected.push(e);
      }
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response
        ?.status;
      if (status === 403) {
        logger.warn(
          "SofaScoreSource",
          `403 for ${url} — Cloudflare blocked. Consider residential IP.`,
        );
      } else if (status !== 404) {
        // /inverse 404s for some dates — treat as non-fatal.
        logger.warn(
          "SofaScoreSource",
          `GET ${url} failed: ${(err as Error).message}`,
        );
      }
    }
  }

  eventsByDate.set(date, collected);
  return collected;
};

// ─── Main entry ──────────────────────────────────────────────────────────────

/**
 * Statistics payload shape — we only care about the corner-kicks row.
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

/**
 * Best-effort per-event corner fetch. SofaScore's statistics response is
 * grouped by category; we flatten to find `cornerKicks` only. Silent
 * null-return on 403/404 so corners are treated as unavailable rather
 * than blocking settlement.
 */
const fetchEventCorners = async (
  sofaEventId: number,
): Promise<{ home: number; away: number } | null> => {
  try {
    const { data } = await axios.get<SofaStatsResponse>(
      `${BASE_URL}/event/${sofaEventId}/statistics`,
      { headers: BROWSER_HEADERS, timeout: HTTP_TIMEOUT_MS },
    );
    for (const period of data.statistics ?? []) {
      for (const g of period.groups ?? []) {
        for (const item of g.statisticsItems ?? []) {
          if (item.key === "cornerKicks") {
            if (item.homeValue == null || item.awayValue == null) return null;
            return { home: item.homeValue, away: item.awayValue };
          }
        }
      }
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * Resolve final scores via SofaScore. Groups events by UTC date,
 * fetches one scheduled-events/{date} payload per unique date, then
 * fuzzy-matches our events against the returned catalog.
 *
 * Pass `withCorners: true` to also fetch per-event corner stats. That's
 * an extra HTTP call per resolved event; only turn it on when the
 * batch actually contains a CORNERS market bet.
 */
export async function fetchSofaScoreScores(
  events: SettleEvent[],
  opts: { withCorners?: boolean } = {},
): Promise<Map<string, MatchScore>> {
  const out = new Map<string, MatchScore>();
  if (events.length === 0) return out;

  // Unique UTC dates needed — pad one day each side so timezone-skewed
  // kickoffs still match.
  const dateSet = new Set<string>();
  for (const e of events) {
    const t = new Date(e.startTime).getTime();
    for (const offset of [-86_400_000, 0, 86_400_000]) {
      dateSet.add(new Date(t + offset).toISOString().slice(0, 10));
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
      if (combined < MATCH_SCORE_THRESHOLD) continue;

      if (!best || combined > best.score)
        best = { event: theirs, score: combined };
    }

    if (!best) continue;

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

  // Optional second pass: per-event corner fetch. Only runs when the
  // caller explicitly opted in (via `withCorners`), since it's one
  // extra HTTP call per resolved event.
  if (opts.withCorners) {
    for (const [eventId, score] of out) {
      // Score currently lacks an embedded sofa id; recover it from the URL.
      const m = score.sourceUrl?.match(/\/event\/(\d+)/);
      if (!m) continue;
      const sofaId = Number.parseInt(m[1], 10);
      const corners = await fetchEventCorners(sofaId);
      await new Promise((r) => setTimeout(r, 350));
      if (corners) {
        score.cornersHome = corners.home;
        score.cornersAway = corners.away;
        out.set(eventId, score);
      }
    }
  }

  if (out.size > 0) {
    logger.info(
      "SofaScoreSource",
      `Resolved ${out.size}/${events.length} events via SofaScore${opts.withCorners ? " (with corners)" : ""}`,
    );
  }
  return out;
}
