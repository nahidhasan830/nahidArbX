/**
 * Tier 2c — API-Football (api-sports.io) official REST API.
 *
 * Free tier: 100 requests/day, 10 req/min, no credit card.
 * Covers 1,000+ leagues globally with FT + HT scores, corners,
 * yellow/red cards — everything the settlement pipeline needs.
 *
 * This source is the last resort after ESPN and SofaScore. It fires only
 * for events those sources couldn't resolve with the data required by
 * the pending bets. The daily quota guard remains the only API-Football
 * request cap.
 *
 * Endpoints used:
 *   GET /fixtures?date=YYYY-MM-DD       — all matches for a date
 *   GET /fixtures/statistics?fixture=ID  — match-level stats (corners, cards)
 *
 * Auth: `x-apisports-key: <token>` header.
 */

import axios from "axios";
import { bestSim as compareTwoStrings } from "@/lib/matching/string-sim";
import type { SettleEvent } from "../waterfall";
import type { MatchScore } from "../types";
import { logger } from "../../shared/logger";
import { singleton } from "../../util/singleton";
import {
  applyTeamAlias,
  learnCompetitionSlug,
  learnTeamAlias,
  lookupCompetitionSlug,
  normalizeCompetition,
} from "../aliases";
import { addDays, format } from "date-fns";

// ─── Configuration ──────────────────────────────────────────────────────────

const BASE_URL = "https://v3.football.api-sports.io";
const API_KEY = process.env.API_FOOTBALL_KEY ?? "";

const MATCH_SCORE_THRESHOLD = 0.65;
const KICKOFF_WINDOW_MS = 90 * 60 * 1000;
const HTTP_TIMEOUT_MS = 15_000;

/** Free tier: 100 requests/day. Warn at 80%. */
const DAILY_LIMIT = 100;
const WARN_THRESHOLD = 0.8;

// ─── Quota tracking ─────────────────────────────────────────────────────────

interface QuotaState {
  dayKey: string; // "YYYY-MM-DD"
  usedRequests: number;
}

function currentDayKey(): string {
  return format(new Date(), "yyyy-MM-dd");
}

const quota = singleton<QuotaState>("settle:api-football:quota", () => ({
  dayKey: currentDayKey(),
  usedRequests: 0,
}));

function ensureDayReset(): void {
  const key = currentDayKey();
  if (quota.dayKey !== key) {
    logger.info(
      "ApiFootball",
      `Day rolled ${quota.dayKey} → ${key}. Resetting usage (was ${quota.usedRequests}).`,
    );
    quota.dayKey = key;
    quota.usedRequests = 0;
  }
}

function canMakeRequest(): boolean {
  ensureDayReset();
  return quota.usedRequests < DAILY_LIMIT;
}

function trackRequest(): void {
  quota.usedRequests++;
  if (
    quota.usedRequests === Math.ceil(DAILY_LIMIT * WARN_THRESHOLD) ||
    quota.usedRequests === DAILY_LIMIT - 5
  ) {
    logger.warn(
      "ApiFootball",
      `Daily usage: ${quota.usedRequests}/${DAILY_LIMIT} requests.`,
    );
  }
}

export function getApiFootballQuota(): {
  dailyLimit: number;
  used: number;
  remaining: number;
} {
  ensureDayReset();
  return {
    dailyLimit: DAILY_LIMIT,
    used: quota.usedRequests,
    remaining: Math.max(0, DAILY_LIMIT - quota.usedRequests),
  };
}

// ─── League ID map ──────────────────────────────────────────────────────────
//
// API-Football uses numeric league IDs. This map covers leagues that ESPN
// doesn't handle well — niche/tier-2 competitions and leagues where HT
// scores are needed.

const LEAGUE_IDS: Record<string, number> = {
  // Sweden
  allsvenskan: 113,
  "sweden allsvenskan": 113,
  superettan: 114,
  "sweden superettan": 114,

  // Germany
  bundesliga: 78,
  "german bundesliga": 78,
  "germany bundesliga": 78,
  "bundesliga 2": 79,
  "2 bundesliga": 79,
  "germany bundesliga 2": 79,
  "3 liga": 80,
  "germany 3 liga": 80,

  // England
  "premier league": 39,
  "england premier league": 39,
  "english premier league": 39,
  championship: 40,
  "england championship": 40,
  "league 1": 41,
  "england league 1": 41,
  "league one": 41,
  "league 2": 42,
  "england league 2": 42,
  "league two": 42,

  // Italy
  "serie a": 135,
  "italy serie a": 135,
  "serie b": 136,
  "italy serie b": 136,

  // Spain
  "la liga": 140,
  "primera division": 140,
  "spain la liga": 140,
  "la liga 2": 141,
  segunda: 141,

  // France
  "ligue 1": 61,
  "france ligue 1": 61,
  "ligue 2": 62,
  "france ligue 2": 62,

  // Turkey
  "super lig": 203,
  "super league": 203,
  "turkey super lig": 203,
  "turkey super league": 203,

  // Norway
  eliteserien: 103,
  "norway eliteserien": 103,
  "1st division": 104,
  "norway 1st division": 104,
  obosligaen: 104,

  // Portugal
  "primeira liga": 94,
  "portugal primeira liga": 94,

  // Netherlands
  eredivisie: 88,
  "netherlands eredivisie": 88,

  // Scotland
  premiership: 179,
  "scotland premiership": 179,
  "scotland championship": 180,

  // Denmark
  superliga: 119,
  "denmark superliga": 119,
  "denmark division 1": 120,
  "denmark 1st division": 120,
  "1 division": 120,

  // Finland
  veikkausliiga: 244,
  "finland veikkausliiga": 244,
  ykkonen: 245,
  "finland ykkonen": 245,

  // Poland
  ekstraklasa: 106,
  "poland ekstraklasa": 106,
  "1 liga": 107,
  "poland 1st liga": 107,

  // Belgium
  "pro league": 144,
  "jupiler pro league": 144,
  "belgium pro league": 144,

  // Russia
  "premier liga": 235,
  "russian premier liga": 235,

  // South Africa
  psl: 288,
  "south africa psl": 288,
  "premier soccer league": 288,

  // Albania / Balkans
  "albania superliga": 310,
  "albanian superliga": 310,
  "bosnia premier league": 225,
  "bulgarian a league": 172,

  // Thailand
  "thai league 1": 296,
  "thailand league 1": 296,
  "thailand league 2": 297,
  "thai league 2": 297,

  // Brazil
  brasileirao: 71,
  "brazil serie a": 71,
  "brazilian serie a": 71,
  "brazil serie b": 72,
  "brazilian serie b": 72,
  "brazil serie c": 75,
  "brazilian serie c": 75,

  // Argentina
  "liga profesional": 128,
  "argentine primera": 128,

  // China
  "chinese super league": 169,
  "china super league": 169,

  // Japan / Korea
  "j league": 98,
  "j1 league": 98,
  "k league": 292,
  "k league 1": 292,

  // MLS
  mls: 253,
  "major league soccer": 253,

  // Europe-wide
  "champions league": 2,
  "uefa champions league": 2,
  "europa league": 3,
  "uefa europa league": 3,
  "conference league": 848,
  "uefa conference league": 848,

  // Singapore
  "singapore premier league": 382,

  // UAE
  "uae pro league": 308,
  "uae league": 308,

  // Saudi
  "saudi pro league": 307,

  // Iran
  "iran persian gulf pro league": 290,

  // International
  "world cup": 1,
  "fifa world cup": 1,
  "international friendlies": 10,
  "club friendlies": 667,

  // Lithuania, Latvia, Israel (niche)
  "lithuania a lyga": 354,
  "latvia higher league": 365,
  "israeli premier league": 383,

  // Paraguay (niche — not on ESPN)
  "paraguay primera": 249,
  "paraguay division intermedia": 250,

  // Slovakia (niche — not on ESPN)
  "slovakia super liga": 332,
  "slovakia 2 liga": 333,

  // Croatia
  "croatian hnl": 210,
  "croatia hnl": 210,

  // Czech Republic
  "czech first league": 345,
  "czech liga": 345,

  // Romania
  "liga 1": 283,
  "romania liga 1": 283,

  // Hungary
  "nb i": 271,
  "hungary nb i": 271,

  // Greece
  "super league greece": 197,

  // Austria
  "austrian bundesliga": 218,

  // Switzerland
  "swiss super league": 207,

  // Serbia
  "serbian superliga": 286,

  // Ukraine
  "ukrainian premier league": 333,

  // Egypt
  "egyptian premier league": 233,

  // Mexico
  "liga mx": 262,
  "mexico liga mx": 262,

  // Colombia
  "colombian primera a": 239,

  // Chile
  "chilean primera": 265,
};

// ─── API-Football league ID resolver ────────────────────────────────────────

export const apiFootballLeagueId = (raw: string | null): number | null => {
  if (!raw) return null;
  // 1. Learned entries
  const learned = lookupCompetitionSlug(raw, "api-football");
  if (learned) {
    const n = Number.parseInt(learned, 10);
    if (Number.isFinite(n)) return n;
  }
  // 2. Hand-coded aliases
  const norm = normalizeCompetition(raw);
  if (LEAGUE_IDS[norm]) return LEAGUE_IDS[norm];
  for (const [alias, id] of Object.entries(LEAGUE_IDS)) {
    if (norm.includes(alias)) return id;
  }
  return null;
};

// ─── Response shapes ────────────────────────────────────────────────────────

interface ApiFixture {
  fixture: {
    id: number;
    date: string; // ISO
    status: {
      long: string;
      short: string; // "FT", "AET", "PEN", "PST", "CANC", etc.
    };
  };
  league: {
    id: number;
    name: string;
    country: string;
  };
  teams: {
    home: { id: number; name: string };
    away: { id: number; name: string };
  };
  goals: {
    home: number | null;
    away: number | null;
  };
  score: {
    halftime: { home: number | null; away: number | null };
    fulltime: { home: number | null; away: number | null };
    extratime: { home: number | null; away: number | null };
    penalty: { home: number | null; away: number | null };
  };
}

interface ApiFixtureResponse {
  response: ApiFixture[];
  results: number;
  errors: unknown;
}

interface ApiStatItem {
  type: string;
  value: number | string | null;
}

interface ApiStatTeam {
  team: { id: number; name: string };
  statistics: ApiStatItem[];
}

interface ApiStatResponse {
  response: ApiStatTeam[];
  results: number;
}

// ─── Matching helpers ───────────────────────────────────────────────────────

const SUFFIX_NOISE =
  /\b(fc|cf|sc|ac|afc|cfc|fk|ii|iii|b|u21|u23|u19|u18|reserves|reserv|akademie|academy|women|w|wfc|wsl|jr|ladies|youth|u\d+|nd|1st|2nd|3rd|ifk|bk|if|ff|ks|nk|os|al|club|sportclub|klub|cd|cs|ca|calcio|futbol|football)\b/g;

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
  if (na === nb) return 1;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = shorter === na ? nb : na;
  if (shorter.length >= 3 && ` ${longer} `.includes(` ${shorter} `))
    return 0.92;
  return compareTwoStrings(na, nb);
};

const mapStatus = (short: string): MatchScore["status"] | null => {
  switch (short) {
    case "FT":
      return "FT";
    case "AET":
      return "AET";
    case "PEN":
      return "PEN";
    case "PST":
    case "POST":
      return "POSTPONED";
    case "CANC":
    case "ABD":
    case "AWD":
    case "WO":
      return "ABD";
    default:
      return null; // NS, 1H, HT, 2H, ET, BT, SUSP, INT, LIVE, etc.
  }
};

// ─── HTTP helper ────────────────────────────────────────────────────────────

async function apiFetch<T>(
  endpoint: string,
  params: Record<string, string | number>,
): Promise<T | null> {
  if (!API_KEY) {
    logger.debug("ApiFootball", "No API_FOOTBALL_KEY set — skipping.");
    return null;
  }
  if (!canMakeRequest()) {
    logger.warn(
      "ApiFootball",
      `Daily limit reached (${quota.usedRequests}/${DAILY_LIMIT}) — refusing request.`,
    );
    return null;
  }

  try {
    const { data } = await axios.get<T>(`${BASE_URL}${endpoint}`, {
      params,
      headers: { "x-apisports-key": API_KEY },
      timeout: HTTP_TIMEOUT_MS,
    });
    trackRequest();
    return data;
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === 429) {
      logger.warn("ApiFootball", "Rate limited (429) — backing off.");
      return null;
    }
    logger.warn(
      "ApiFootball",
      `GET ${endpoint} failed: ${(err as Error).message}`,
    );
    return null;
  }
}

// ─── Main entry: score resolution ───────────────────────────────────────────

/**
 * Resolve final scores for events via API-Football. Groups events by
 * date (one API call per date covering all leagues), then fuzzy-matches
 * by team name + kickoff window.
 *
 * Returns HT + FT + ET + PEN scores — the only free source that
 * provides clean half-time data.
 */
export async function fetchApiFootballScores(
  events: SettleEvent[],
): Promise<Map<string, MatchScore>> {
  const out = new Map<string, MatchScore>();
  if (events.length === 0 || !API_KEY) return out;

  // Collect unique local dates from events, pad +/-1 day for provider catalog variance.
  const dateSet = new Set<string>();
  for (const e of events) {
    const start = new Date(e.startTime);
    for (const offset of [-1, 0, 1]) {
      dateSet.add(format(addDays(start, offset), "yyyy-MM-dd"));
    }
  }

  // Fetch all fixtures for each date
  const allFixtures: ApiFixture[] = [];
  for (const date of [...dateSet].sort()) {
    const resp = await apiFetch<ApiFixtureResponse>("/fixtures", { date });
    if (resp?.response) {
      allFixtures.push(...resp.response);
    }
    // Gentle pacing: respect 10 req/min limit
    await new Promise((r) => setTimeout(r, 500));
  }

  if (allFixtures.length === 0) {
    logger.debug(
      "ApiFootball",
      `No fixtures returned for ${dateSet.size} dates.`,
    );
    return out;
  }

  // Fuzzy-match each of our events against the API-Football catalog
  for (const ours of events) {
    const ourStart = new Date(ours.startTime).getTime();
    let best: { fixture: ApiFixture; score: number } | null = null;

    for (const theirs of allFixtures) {
      const kickoff = new Date(theirs.fixture.date).getTime();
      if (Math.abs(kickoff - ourStart) > KICKOFF_WINDOW_MS) continue;

      const homeSim = teamSimilarity(ours.homeTeam, theirs.teams.home.name);
      const awaySim = teamSimilarity(ours.awayTeam, theirs.teams.away.name);
      const combined = (homeSim + awaySim) / 2;
      if (combined < MATCH_SCORE_THRESHOLD) continue;

      if (!best || combined > best.score) {
        best = { fixture: theirs, score: combined };
      }
    }

    if (!best) continue;

    const status = mapStatus(best.fixture.fixture.status.short);
    if (!status) continue;

    if (status === "POSTPONED" || status === "ABD") {
      out.set(ours.eventId, {
        eventId: ours.eventId,
        status,
        htHome: null,
        htAway: null,
        ftHome: 0,
        ftAway: 0,
        source: "api-football",
        confidence: 0.6 + best.score * 0.35,
        sourceUrl: `https://www.api-football.com/fixture/${best.fixture.fixture.id}`,
      });
      continue;
    }

    const ftH = best.fixture.score.fulltime.home ?? best.fixture.goals.home;
    const ftA = best.fixture.score.fulltime.away ?? best.fixture.goals.away;
    if (ftH == null || ftA == null) continue;

    const confidence = 0.6 + best.score * 0.35;
    out.set(ours.eventId, {
      eventId: ours.eventId,
      status,
      htHome: best.fixture.score.halftime.home ?? null,
      htAway: best.fixture.score.halftime.away ?? null,
      ftHome: ftH,
      ftAway: ftA,
      etHome: best.fixture.score.extratime.home ?? null,
      etAway: best.fixture.score.extratime.away ?? null,
      penHome: best.fixture.score.penalty.home ?? null,
      penAway: best.fixture.score.penalty.away ?? null,
      source: "api-football",
      confidence,
      sourceUrl: `https://www.api-football.com/fixture/${best.fixture.fixture.id}`,
    });

    // Learn aliases
    if (ours.competition) {
      const leagueId = best.fixture.league.id;
      learnCompetitionSlug(ours.competition, "api-football", String(leagueId));
    }
    try {
      learnTeamAlias(ours.homeTeam, best.fixture.teams.home.name);
      learnTeamAlias(ours.awayTeam, best.fixture.teams.away.name);
    } catch (err) {
      logger.debug(
        "ApiFootball",
        `learnTeamAlias failed (non-fatal): ${(err as Error).message}`,
      );
    }
  }

  if (out.size > 0) {
    logger.info(
      "ApiFootball",
      `Resolved ${out.size}/${events.length} events via API-Football.`,
    );
  }
  return out;
}

// ─── Match-level stats (corners, cards) ─────────────────────────────────────

export interface ApiFootballMatchStats {
  cornersHome: number;
  cornersAway: number;
  yellowCardsHome: number;
  redCardsHome: number;
  yellowCardsAway: number;
  redCardsAway: number;
}

/**
 * Fetch match-level statistics for a single fixture.
 * Costs 1 request from the daily quota.
 */
async function fetchFixtureStats(
  fixtureId: number,
): Promise<ApiFootballMatchStats | null> {
  const resp = await apiFetch<ApiStatResponse>("/fixtures/statistics", {
    fixture: fixtureId,
  });
  if (!resp?.response || resp.response.length < 2) return null;

  const getStat = (team: ApiStatTeam, type: string): number => {
    const item = team.statistics.find(
      (s) => s.type.toLowerCase() === type.toLowerCase(),
    );
    if (!item || item.value == null) return 0;
    const n =
      typeof item.value === "number"
        ? item.value
        : Number.parseInt(String(item.value), 10);
    return Number.isFinite(n) ? n : 0;
  };

  // API-Football returns teams in order [home, away]
  const home = resp.response[0];
  const away = resp.response[1];

  return {
    cornersHome: getStat(home, "Corner Kicks"),
    cornersAway: getStat(away, "Corner Kicks"),
    yellowCardsHome: getStat(home, "Yellow Cards"),
    redCardsHome: getStat(home, "Red Cards"),
    yellowCardsAway: getStat(away, "Yellow Cards"),
    redCardsAway: getStat(away, "Red Cards"),
  };
}

/**
 * Enrich an existing map of scores with card/corner data from API-Football.
 * Only enriches scores that were originally resolved by API-Football
 * (sourceUrl contains fixture ID).
 */
export async function enrichApiFootballStats(
  scores: Map<string, MatchScore>,
  _events: SettleEvent[],
  opts: { withCorners?: boolean; withBookings?: boolean },
): Promise<{ enriched: number; skipped: number }> {
  let enriched = 0;
  let skipped = 0;

  for (const [_eventId, score] of scores) {
    // Only enrich API-Football-sourced scores
    const m = score.sourceUrl?.match(/\/fixture\/(\d+)/);
    if (!m) {
      skipped++;
      continue;
    }

    const needsCorners =
      opts.withCorners &&
      (score.cornersHome == null || score.cornersAway == null);
    const needsBookings =
      opts.withBookings &&
      (score.bookingsHome == null || score.bookingsAway == null);
    if (!needsCorners && !needsBookings) continue;

    if (!canMakeRequest()) {
      logger.warn(
        "ApiFootball",
        `Daily limit prevents stats enrichment — ${quota.usedRequests}/${DAILY_LIMIT}.`,
      );
      break;
    }

    const fixtureId = Number.parseInt(m[1], 10);
    const stats = await fetchFixtureStats(fixtureId);
    if (!stats) {
      skipped++;
      continue;
    }

    if (needsCorners) {
      score.cornersHome = stats.cornersHome;
      score.cornersAway = stats.cornersAway;
    }
    if (needsBookings) {
      // Pinnacle convention: 1 pt per yellow, 2 pts per red
      score.bookingsHome = stats.yellowCardsHome + 2 * stats.redCardsHome;
      score.bookingsAway = stats.yellowCardsAway + 2 * stats.redCardsAway;
    }
    enriched++;

    // Gentle pacing
    await new Promise((r) => setTimeout(r, 500));
  }

  if (enriched > 0) {
    const extras: string[] = [];
    if (opts.withCorners) extras.push("corners");
    if (opts.withBookings) extras.push("bookings");
    logger.info(
      "ApiFootball",
      `Enriched ${enriched} events with ${extras.join("+")} via API-Football (${skipped} skipped)`,
    );
  }
  return { enriched, skipped };
}
