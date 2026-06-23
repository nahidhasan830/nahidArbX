
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


const BASE_URL = "https://v3.football.api-sports.io";
const API_KEY = process.env.API_FOOTBALL_KEY ?? "";

const MATCH_SCORE_THRESHOLD = 0.65;
const KICKOFF_WINDOW_MS = 90 * 60 * 1000;
const HTTP_TIMEOUT_MS = 15_000;
const API_FOOTBALL_FIXTURE_CACHE_TTL_MS = 2 * 60 * 1000;

const DAILY_LIMIT = 100;
const WARN_THRESHOLD = 0.8;


interface QuotaState {
  dayKey: string;
  usedRequests: number;
}

interface SourceIssueState {
  messages: string[];
}

interface PlanWindowState {
  dayKey: string;
  from: string;
  to: string;
  message: string;
}

function currentDayKey(): string {
  return format(new Date(), "yyyy-MM-dd");
}

const quota = singleton<QuotaState>("settle:api-football:quota", () => ({
  dayKey: currentDayKey(),
  usedRequests: 0,
}));

const sourceIssues = singleton<SourceIssueState>(
  "settle:api-football:source-issues",
  () => ({
    messages: [],
  }),
);

const planWindow = singleton<{ current: PlanWindowState | null }>(
  "settle:api-football:plan-window",
  () => ({
    current: null,
  }),
);

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

export function clearApiFootballSourceIssues(): void {
  sourceIssues.messages = [];
}

export function drainApiFootballSourceIssues(): string[] {
  const out = [...new Set(sourceIssues.messages)];
  sourceIssues.messages = [];
  return out;
}

function recordApiFootballSourceIssue(message: string): void {
  if (!message) return;
  sourceIssues.messages.push(message);
}

function rememberPlanWindow(message: string): void {
  const match = message.match(
    /try from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/i,
  );
  if (!match) return;
  const [, from, to] = match;
  if (!from || !to) return;
  planWindow.current = {
    dayKey: currentDayKey(),
    from,
    to,
    message,
  };
}

function getCurrentPlanWindow(): PlanWindowState | null {
  const current = planWindow.current;
  if (!current || current.dayKey !== currentDayKey()) return null;
  return current;
}

function shouldSkipDateByPlanWindow(date: string): string | null {
  const current = getCurrentPlanWindow();
  if (!current) return null;
  if (date >= current.from && date <= current.to) return null;
  return current.message;
}

function summarizeApiFootballErrors(errors: unknown): string | null {
  if (!errors) return null;
  if (Array.isArray(errors)) {
    const joined = errors.map(String).filter(Boolean).join("; ");
    return joined || null;
  }
  if (typeof errors === "string") return errors || null;
  if (typeof errors !== "object") return null;

  const messages = Object.entries(errors as Record<string, unknown>).flatMap(
    ([key, value]) => {
      if (value == null || value === "") return [];
      const prefix = key ? `${key}: ` : "";
      if (Array.isArray(value)) {
        return value.map((item) => `${prefix}${String(item)}`);
      }
      return [`${prefix}${String(value)}`];
    },
  );
  return messages.length > 0 ? messages.join("; ") : null;
}


const LEAGUE_IDS: Record<string, number> = {
  allsvenskan: 113,
  "sweden allsvenskan": 113,
  superettan: 114,
  "sweden superettan": 114,

  bundesliga: 78,
  "german bundesliga": 78,
  "germany bundesliga": 78,
  "bundesliga 2": 79,
  "2 bundesliga": 79,
  "germany bundesliga 2": 79,
  "3 liga": 80,
  "germany 3 liga": 80,

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

  "serie a": 135,
  "italy serie a": 135,
  "serie b": 136,
  "italy serie b": 136,

  "la liga": 140,
  "primera division": 140,
  "spain la liga": 140,
  "la liga 2": 141,
  segunda: 141,

  "ligue 1": 61,
  "france ligue 1": 61,
  "ligue 2": 62,
  "france ligue 2": 62,

  "super lig": 203,
  "super league": 203,
  "turkey super lig": 203,
  "turkey super league": 203,

  eliteserien: 103,
  "norway eliteserien": 103,
  "1st division": 104,
  "norway 1st division": 104,
  obosligaen: 104,

  "primeira liga": 94,
  "portugal primeira liga": 94,

  eredivisie: 88,
  "netherlands eredivisie": 88,

  premiership: 179,
  "scotland premiership": 179,
  "scotland championship": 180,

  superliga: 119,
  "denmark superliga": 119,
  "denmark division 1": 120,
  "denmark 1st division": 120,
  "1 division": 120,

  veikkausliiga: 244,
  "finland veikkausliiga": 244,
  ykkonen: 245,
  "finland ykkonen": 245,

  ekstraklasa: 106,
  "poland ekstraklasa": 106,
  "1 liga": 107,
  "poland 1st liga": 107,

  "pro league": 144,
  "jupiler pro league": 144,
  "belgium pro league": 144,

  "premier liga": 235,
  "russian premier liga": 235,

  psl: 288,
  "south africa psl": 288,
  "premier soccer league": 288,

  "albania superliga": 310,
  "albanian superliga": 310,
  "bosnia premier league": 225,
  "bulgarian a league": 172,

  "thai league 1": 296,
  "thailand league 1": 296,
  "thailand league 2": 297,
  "thai league 2": 297,

  brasileirao: 71,
  "brazil serie a": 71,
  "brazilian serie a": 71,
  "brazil serie b": 72,
  "brazilian serie b": 72,
  "brazil serie c": 75,
  "brazilian serie c": 75,

  "liga profesional": 128,
  "argentine primera": 128,

  "chinese super league": 169,
  "china super league": 169,

  "j league": 98,
  "j1 league": 98,
  "k league": 292,
  "k league 1": 292,

  mls: 253,
  "major league soccer": 253,

  "champions league": 2,
  "uefa champions league": 2,
  "europa league": 3,
  "uefa europa league": 3,
  "conference league": 848,
  "uefa conference league": 848,

  "singapore premier league": 382,

  "uae pro league": 308,
  "uae league": 308,

  "saudi pro league": 307,

  "iran persian gulf pro league": 290,

  "world cup": 1,
  "fifa world cup": 1,
  "international friendlies": 10,
  "club friendlies": 667,

  "lithuania a lyga": 354,
  "latvia higher league": 365,
  "israeli premier league": 383,

  "paraguay primera": 249,
  "paraguay division intermedia": 250,

  "slovakia super liga": 332,
  "slovakia 2 liga": 333,

  "croatian hnl": 210,
  "croatia hnl": 210,

  "czech first league": 345,
  "czech liga": 345,

  "liga 1": 283,
  "romania liga 1": 283,

  "nb i": 271,
  "hungary nb i": 271,

  "super league greece": 197,

  "austrian bundesliga": 218,

  "swiss super league": 207,

  "serbian superliga": 286,

  "ukrainian premier league": 333,

  "egyptian premier league": 233,

  "liga mx": 262,
  "mexico liga mx": 262,

  "colombian primera a": 239,

  "chilean primera": 265,
};


export const apiFootballLeagueId = (raw: string | null): number | null => {
  if (!raw) return null;
  const learned = lookupCompetitionSlug(raw, "api-football");
  if (learned) {
    const n = Number.parseInt(learned, 10);
    if (Number.isFinite(n)) return n;
  }
  const norm = normalizeCompetition(raw);
  if (LEAGUE_IDS[norm]) return LEAGUE_IDS[norm];
  for (const [alias, id] of Object.entries(LEAGUE_IDS)) {
    if (norm.includes(alias)) return id;
  }
  return null;
};


interface ApiFixture {
  fixture: {
    id: number;
    date: string;
    status: {
      long: string;
      short: string;
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

interface FixtureCacheEntry {
  fetchedAt: number;
  fixtures: ApiFixture[];
}

const fixturesByDate = singleton<Map<string, FixtureCacheEntry>>(
  "settle:api-football:fixtures-by-date",
  () => new Map(),
);

function getCachedFixtures(date: string): ApiFixture[] | null {
  const cached = fixturesByDate.get(date);
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > API_FOOTBALL_FIXTURE_CACHE_TTL_MS) {
    fixturesByDate.delete(date);
    return null;
  }
  return cached.fixtures;
}

function setCachedFixtures(date: string, fixtures: ApiFixture[]): void {
  fixturesByDate.set(date, {
    fetchedAt: Date.now(),
    fixtures,
  });
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
      return null;
  }
};


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
    const issue = summarizeApiFootballErrors(
      (data as { errors?: unknown } | null | undefined)?.errors,
    );
    if (issue) {
      recordApiFootballSourceIssue(
        `API-Football access issue on ${endpoint}: ${issue}`,
      );
      rememberPlanWindow(issue);
      logger.warn("ApiFootball", `${endpoint} returned error: ${issue}`);
    }
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


export async function fetchApiFootballScores(
  events: SettleEvent[],
): Promise<Map<string, MatchScore>> {
  const out = new Map<string, MatchScore>();
  if (events.length === 0 || !API_KEY) return out;

  const dateSet = new Set<string>();
  for (const e of events) {
    const start = new Date(e.startTime);
    for (const offset of [-1, 0, 1]) {
      dateSet.add(format(addDays(start, offset), "yyyy-MM-dd"));
    }
  }

  const allFixtures: ApiFixture[] = [];
  for (const date of [...dateSet].sort()) {
    const cached = getCachedFixtures(date);
    if (cached) {
      allFixtures.push(...cached);
      continue;
    }

    const skipReason = shouldSkipDateByPlanWindow(date);
    if (skipReason) {
      recordApiFootballSourceIssue(
        `API-Football access issue on /fixtures: ${skipReason}`,
      );
      continue;
    }
    const resp = await apiFetch<ApiFixtureResponse>("/fixtures", { date });
    if (resp && !summarizeApiFootballErrors(resp.errors)) {
      setCachedFixtures(date, resp.response ?? []);
    }
    if (resp?.response) {
      allFixtures.push(...resp.response);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (allFixtures.length === 0) {
    logger.debug(
      "ApiFootball",
      `No fixtures returned for ${dateSet.size} dates.`,
    );
    return out;
  }

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


export interface ApiFootballMatchStats {
  cornersHome: number;
  cornersAway: number;
  yellowCardsHome: number;
  redCardsHome: number;
  yellowCardsAway: number;
  redCardsAway: number;
}

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

export async function enrichApiFootballStats(
  scores: Map<string, MatchScore>,
  _events: SettleEvent[],
  opts: { withCorners?: boolean; withBookings?: boolean },
): Promise<{ enriched: number; skipped: number }> {
  let enriched = 0;
  let skipped = 0;

  for (const [_eventId, score] of scores) {
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
      score.bookingsHome = stats.yellowCardsHome + 2 * stats.redCardsHome;
      score.bookingsAway = stats.yellowCardsAway + 2 * stats.redCardsAway;
    }
    enriched++;

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
