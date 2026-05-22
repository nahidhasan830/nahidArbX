/**
 * Tier 2b — ESPN hidden scoreboard API.
 *
 * ESPN exposes an unauthenticated JSON endpoint at
 *   site.api.espn.com/apis/site/v2/sports/soccer/{leagueSlug}/scoreboard
 * with broad global coverage: Allsvenskan, Superettan, 2. Bundesliga,
 * Serie B, Eliteserien, Turkish Super Lig, PSL, and many tier-1 leagues.
 * It is vastly broader than football-data.org's free tier and — unlike
 * SofaScore — is not behind Cloudflare bot protection.
 *
 * Trade-off: HT score is not exposed as a clean field (ESPN gives goal
 * events with timestamps; splitting goals into half 1 vs 2 is brittle).
 * This adapter returns FT only; HT-scope bets for events ESPN covers
 * will still fall through to a later tier. The vast majority of the
 * value-bet feed is FT-scope anyway, so this is a net win.
 */

import axios from "axios";
import { bestSim as compareTwoStrings } from "@/lib/matching/string-sim";
import type { SettleEvent } from "../waterfall";
import type { MatchScore } from "../types";
import { logger } from "../../shared/logger";
import {
  applyTeamAlias,
  learnCompetitionSlug,
  learnTeamAlias,
  lookupCompetitionSlug,
  normalizeCompetition,
} from "../aliases";
import { verifySettlementMatch, AI_MAYBE_FLOOR } from "./ai-match";
import { addDays, format } from "date-fns";

const BASE_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const MATCH_SCORE_THRESHOLD = 0.65;
const KICKOFF_WINDOW_MS = 90 * 60 * 1000; // 90 minutes — covers leagues where Pinnacle times differ from ESPN
const HTTP_TIMEOUT_MS = 12_000;

/**
 * Map the free-form `competition` string stored on value_bets → ESPN's
 * country-code.tier slug. ESPN slugs aren't documented in one place;
 * this list was assembled by probing their API and trial-and-error.
 * Unknown competitions skip to the next tier (no fallback scan since
 * ESPN doesn't have a "all leagues for date" endpoint).
 */
const LEAGUE_ALIASES: Record<string, string> = {
  // Sweden
  allsvenskan: "swe.1",
  "sweden allsvenskan": "swe.1",
  superettan: "swe.2",
  "sweden superettan": "swe.2",

  // Germany
  bundesliga: "ger.1",
  "german bundesliga": "ger.1",
  "germany bundesliga": "ger.1",
  "bundesliga 2": "ger.2",
  "2. bundesliga": "ger.2",
  "germany bundesliga 2": "ger.2",
  "3. liga": "ger.3",
  "germany 3. liga": "ger.3",
  "germany 3 liga": "ger.3",

  // England
  "premier league": "eng.1",
  "england premier league": "eng.1",
  "english premier league": "eng.1",
  championship: "eng.2",
  "england championship": "eng.2",
  "league 1": "eng.3",
  "england league 1": "eng.3",
  "league one": "eng.3",

  // Italy
  "serie a": "ita.1",
  "italy serie a": "ita.1",
  "serie b": "ita.2",
  "italy serie b": "ita.2",

  // Spain
  "la liga": "esp.1",
  "primera division": "esp.1",
  "spain la liga": "esp.1",
  "la liga 2": "esp.2",
  segunda: "esp.2",

  // France
  "ligue 1": "fra.1",
  "france ligue 1": "fra.1",
  "ligue 2": "fra.2",
  "france ligue 2": "fra.2",

  // Turkey
  "super lig": "tur.1",
  "super league": "tur.1",
  "turkey super lig": "tur.1",
  "turkey super league": "tur.1",

  // South Africa
  psl: "rsa.1",
  "south africa psl": "rsa.1",
  "premier soccer league": "rsa.1",

  // Norway
  eliteserien: "nor.1",
  "norway eliteserien": "nor.1",
  "1st division": "nor.2",
  "norway 1st division": "nor.2",
  obosligaen: "nor.2",

  // Portugal
  "primeira liga": "por.1",
  "portugal primeira liga": "por.1",

  // Netherlands
  eredivisie: "ned.1",
  "netherlands eredivisie": "ned.1",

  // Scotland
  premiership: "sco.1",
  "scotland premiership": "sco.1",
  "scotland championship": "sco.2",

  // Denmark
  superliga: "den.1",
  "denmark superliga": "den.1",
  "denmark division 1": "den.2",
  "denmark 1st division": "den.2",
  "1 division": "den.2",

  // Finland
  veikkausliiga: "fin.1",
  "finland veikkausliiga": "fin.1",
  ykkonen: "fin.2",
  "finland ykkonen": "fin.2",

  // Poland
  ekstraklasa: "pol.1",
  "poland ekstraklasa": "pol.1",
  "1 liga": "pol.2",
  "poland 1st liga": "pol.2",

  // Belgium
  "pro league": "bel.1",
  "jupiler pro league": "bel.1",
  "belgium pro league": "bel.1",

  // Russia
  "premier liga": "rus.1",
  "russian premier liga": "rus.1",

  // Albania / Balkans
  "albania superliga": "alb.1",
  "albanian superliga": "alb.1",
  "bosnia premier league": "bih.1",
  "bulgarian a league": "bul.1",

  // Thailand
  "thai league 1": "tha.1",
  "thailand league 1": "tha.1",
  "thailand league 2": "tha.2",
  "thai league 2": "tha.2",

  // International / friendlies — ESPN has some friendly coverage
  "friendlies women": "fifa.friendlies.w",
  "international friendlies": "fifa.friendlies",
  "club friendlies": "club.friendlies",

  // Various other niche
  "lithuania a lyga": "ltu.1",
  "latvia higher league": "lva.1",
  "israeli premier league": "isr.1",
  "saudi pro league": "ksa.1",
  "iran persian gulf pro league": "irn.1",

  // Brazil
  brasileirao: "bra.1",
  "brazil serie a": "bra.1",
  "brazilian serie a": "bra.1",
  "brazil serie b": "bra.2",
  "brazilian serie b": "bra.2",
  "brazil serie c": "bra.3",
  "brazilian serie c": "bra.3",
  "brazil serie d": "bra.4",

  // Argentina
  "liga profesional": "arg.1",
  "argentine primera": "arg.1",

  // China
  "chinese super league": "chn.1",
  "china super league": "chn.1",

  // Japan / Korea
  "j league": "jpn.1",
  "j1 league": "jpn.1",
  "k league": "kor.1",
  "k league 1": "kor.1",

  // MLS / USL
  mls: "usa.1",
  "major league soccer": "usa.1",

  // Europe-wide
  "champions league": "uefa.champions",
  "uefa champions league": "uefa.champions",
  "europa league": "uefa.europa",
  "uefa europa league": "uefa.europa",
  "conference league": "uefa.europa.conf",
  "uefa conference league": "uefa.europa.conf",

  // Singapore
  "singapore premier league": "sgp.1",
  "singapore league 1": "sgp.1",
  spfl: "sgp.1",
  "singapore premier league 1": "sgp.1",

  // UAE
  "uae pro league": "uae.1",
  "uae league": "uae.1",

  // World
  "world cup": "fifa.world",
  "fifa world cup": "fifa.world",
  "world cup qualifiers europe": "fifa.worldq.uefa",
  "world cup qualifiers europe women": "fifa.worldq.uefa.w",
  "fifa wcq europe women": "fifa.worldq.uefa.w",

  // Africa
  "caf champions league": "caf.champions",
  "caf confederation cup": "caf.confed",

  // South America
  "copa libertadores": "conmebol.libertadores",
  libertadores: "conmebol.libertadores",
  "copa sudamericana": "conmebol.sudamericana",

  // Additional niche leagues (coverage expansion)
  // Croatia
  "croatian hnl": "cro.1",
  "croatia hnl": "cro.1",

  // Czech Republic
  "czech first league": "cze.1",
  "czech liga": "cze.1",

  // Romania
  "romania liga 1": "rou.1",

  // Hungary
  "nb i": "hun.1",
  "hungary nb i": "hun.1",

  // Greece
  "super league greece": "gre.1",
  "greece super league": "gre.1",

  // Austria
  "austrian bundesliga": "aut.1",
  "austria bundesliga": "aut.1",

  // Switzerland
  "swiss super league": "sui.1",
  "switzerland super league": "sui.1",

  // Serbia
  "serbian superliga": "srb.1",

  // Ukraine
  "ukrainian premier league": "ukr.1",

  // Egypt
  "egyptian premier league": "egy.1",

  // Mexico
  "liga mx": "mex.1",
  "mexico liga mx": "mex.1",

  // Colombia
  "colombian primera a": "col.1",
  "colombia primera a": "col.1",

  // Chile
  "chilean primera": "chi.1",

  // Peru
  "peruvian primera": "per.1",

  // Paraguay
  "paraguay primera": "par.1",

  // Uruguay
  "uruguayan primera": "uru.1",

  // Australia
  "a league": "aus.1",
  "a league men": "aus.1",

  // India
  "indian super league": "ind.1",
};

/**
 * ESPN publishes "country.tier" slugs; the competition stored on
 * value_bets is typically "{Country} - {LeagueName}" with inconsistent
 * casing/punctuation. Normalize then look up via exact + substring.
 */
const espnSlug = (raw: string | null): string | null => {
  if (!raw) return null;
  // 1. Learned entries (populated by the pipeline over time — matches
  //    adapt to the user's competition strings without manual edits).
  const learned = lookupCompetitionSlug(raw, "espn");
  if (learned) return learned;
  // 2. Hand-coded aliases below.
  const norm = normalizeCompetition(raw);
  if (LEAGUE_ALIASES[norm]) return LEAGUE_ALIASES[norm];
  for (const [alias, slug] of Object.entries(LEAGUE_ALIASES)) {
    if (norm.includes(alias)) return slug;
  }
  return null;
};

// ─── Response shapes (ESPN ships a LOT we don't care about) ──────────────────

interface EspnCompetitor {
  id: string;
  homeAway: "home" | "away";
  score: string;
  team: { displayName: string; shortDisplayName: string; abbreviation: string };
}

interface EspnCompetition {
  date: string;
  status: {
    type: {
      state: "pre" | "in" | "post";
      completed: boolean;
      description: string;
    };
  };
  competitors: EspnCompetitor[];
}

interface EspnEvent {
  id: string;
  date: string;
  status: EspnCompetition["status"];
  competitions: EspnCompetition[];
}

interface EspnScoreboard {
  events?: EspnEvent[];
}

// ─── Matching helpers ────────────────────────────────────────────────────────

const SUFFIX_NOISE =
  /\b(fc|cf|sc|ac|afc|cfc|fk|ii|iii|b|u21|u23|u19|u18|reserves|reserv|akademie|academy|women|w|wfc|wsl|jr|ladies|youth|u\d+|nd|1st|2nd|3rd|ifk|bk|if|ff|ks|nk|os|al|club|sportclub|klub|cd|cs|ca|calcio|futbol|football)\b/g;

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
  // Apply learned aliases first — if "Werder Bremen" was previously
  // mapped to "SV Werder Bremen", normalizing both sides lifts the
  // similarity to 1 without our having to hand-maintain the regex.
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

const statusToMatchStatus = (
  state: string,
  description: string,
): MatchScore["status"] | null => {
  if (state !== "post") return null;
  const d = description.toLowerCase();
  if (d.includes("aet") || d.includes("extra time")) return "AET";
  if (d.includes("penalt")) return "PEN";
  if (d.includes("abandoned")) return "ABD";
  if (d.includes("postponed")) return "POSTPONED";
  return "FT";
};

const eventToScore = (
  e: EspnEvent,
  eventId: string,
  confidence: number,
): MatchScore | null => {
  const comp = e.competitions?.[0];
  if (!comp) return null;
  const status = statusToMatchStatus(
    comp.status.type.state,
    comp.status.type.description ?? "",
  );
  if (!status) return null;
  const home = comp.competitors.find((c) => c.homeAway === "home");
  const away = comp.competitors.find((c) => c.homeAway === "away");
  if (!home || !away) return null;

  return {
    eventId,
    status,
    htHome: null, // ESPN doesn't expose HT cleanly; leave for later tier.
    htAway: null,
    ftHome: Number.parseInt(home.score, 10),
    ftAway: Number.parseInt(away.score, 10),
    source: "espn",
    confidence,
    sourceUrl: `https://www.espn.com/soccer/match/_/gameId/${e.id}`,
  };
};

// ─── Scoreboard fetch ────────────────────────────────────────────────────────

const yyyymmdd = (d: Date): string => format(d, "yyyyMMdd");

/**
 * Fetch a single league's scoreboard covering [dateFrom, dateTo]. ESPN's
 * `dates` param accepts `YYYYMMDD-YYYYMMDD` ranges. We keep ranges <= 7
 * days since very wide ranges seem to 400 for some leagues.
 */
const fetchLeagueScoreboard = async (
  slug: string,
  dateFrom: string,
  dateTo: string,
): Promise<EspnEvent[]> => {
  const url = `${BASE_URL}/${slug}/scoreboard`;
  const dates = dateFrom === dateTo ? dateFrom : `${dateFrom}-${dateTo}`;
  try {
    const { data } = await axios.get<EspnScoreboard>(url, {
      params: { dates },
      timeout: HTTP_TIMEOUT_MS,
    });
    return data.events ?? [];
  } catch (err) {
    // ESPN returns 400 for leagues it doesn't publish; that's a hint to
    // skip this slug, not a failure to retry.
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === 400) return [];
    logger.warn(
      "EspnSource",
      `GET /${slug}/scoreboard failed: ${(err as Error).message}`,
    );
    return [];
  }
};

// ─── Main entry ──────────────────────────────────────────────────────────────

/**
 * Resolve final scores for the given events via ESPN. Groups events by
 * league slug, makes one scoreboard call per (slug, date-range), then
 * fuzzy-matches by team name + kickoff window. Events whose competition
 * doesn't map to an ESPN slug are silently skipped.
 */
export async function fetchEspnScores(
  events: SettleEvent[],
): Promise<Map<string, MatchScore>> {
  const out = new Map<string, MatchScore>();
  if (events.length === 0) return out;

  // Bucket by slug. Only events whose competition we recognize get
  // queued; others fall through to the next waterfall tier.
  const bySlug = new Map<string, SettleEvent[]>();
  for (const e of events) {
    const slug = espnSlug(e.competition);
    if (!slug) continue;
    const bucket = bySlug.get(slug) ?? [];
    bucket.push(e);
    bySlug.set(slug, bucket);
  }

  if (bySlug.size === 0) {
    logger.debug(
      "EspnSource",
      `No recognized league slug in batch of ${events.length} events.`,
    );
    return out;
  }

  for (const [slug, bucket] of bySlug) {
    // Widest date range needed for this bucket. ESPN `dates` is inclusive
    // on both sides. Pad 1 day each side for provider catalog variance.
    const stamps = bucket
      .map((e) => new Date(e.startTime).getTime())
      .sort((a, b) => a - b);
    const earliest = addDays(new Date(stamps[0]), -1);
    const latest = addDays(new Date(stamps[stamps.length - 1]), 1);
    const dateFrom = yyyymmdd(earliest);
    const dateTo = yyyymmdd(latest);

    const espnEvents = await fetchLeagueScoreboard(slug, dateFrom, dateTo);
    if (espnEvents.length === 0) continue;

    // For each of our events in this bucket, pick the best ESPN match.
    for (const ours of bucket) {
      const ourStart = new Date(ours.startTime).getTime();
      let best: { event: EspnEvent; score: number } | null = null;

      for (const theirs of espnEvents) {
        const comp = theirs.competitions?.[0];
        if (!comp) continue;
        const kickoff = new Date(theirs.date).getTime();
        if (Math.abs(kickoff - ourStart) > KICKOFF_WINDOW_MS) continue;

        const home = comp.competitors.find((c) => c.homeAway === "home");
        const away = comp.competitors.find((c) => c.homeAway === "away");
        if (!home || !away) continue;

        const homeSim = Math.max(
          teamSimilarity(ours.homeTeam, home.team.displayName),
          teamSimilarity(ours.homeTeam, home.team.shortDisplayName),
          teamSimilarity(ours.homeTeam, home.team.abbreviation),
        );
        const awaySim = Math.max(
          teamSimilarity(ours.awayTeam, away.team.displayName),
          teamSimilarity(ours.awayTeam, away.team.shortDisplayName),
          teamSimilarity(ours.awayTeam, away.team.abbreviation),
        );
        const combined = (homeSim + awaySim) / 2;
        if (combined < AI_MAYBE_FLOOR) continue; // Too different even for AI

        if (!best || combined > best.score) {
          best = { event: theirs, score: combined };
        }
      }

      if (!best) continue;

      // If the best match is below the deterministic threshold, ask AI
      // to verify. This is the bridge between Matcher Lab AI and settlement.
      if (best.score < MATCH_SCORE_THRESHOLD) {
        const comp = best.event.competitions?.[0];
        const home = comp?.competitors.find((c) => c.homeAway === "home");
        const away = comp?.competitors.find((c) => c.homeAway === "away");
        if (!home || !away) continue;

        const aiResult = await verifySettlementMatch({
          ourHomeTeam: ours.homeTeam,
          ourAwayTeam: ours.awayTeam,
          ourCompetition: ours.competition,
          ourStartTime: ours.startTime,
          theirHomeTeam: home.team.displayName,
          theirAwayTeam: away.team.displayName,
          theirStartTime: best.event.date,
          fuzzySimilarity: best.score,
          sourceProvider: "espn",
        });

        if (!aiResult?.confirmed) continue; // AI rejected or unavailable
        // AI confirmed — bump the effective score for confidence calc
        best.score = Math.max(best.score, 0.85);
      }
      const confidence = 0.6 + best.score * 0.35;
      const score = eventToScore(best.event, ours.eventId, confidence);
      if (score) {
        out.set(ours.eventId, score);

        // ── Learn on match success ───────────────────────────────────────
        // Remember the slug we just used for this competition string so
        // later runs skip the hand-maintained alias scan. Also persist
        // team-name equivalences whenever our team name differs from
        // ESPN's — next time the normalizer applies the alias directly.
        if (ours.competition) {
          learnCompetitionSlug(ours.competition, "espn", slug);
        }
        try {
          const home = best.event.competitions?.[0]?.competitors?.find(
            (c) => c.homeAway === "home",
          );
          const away = best.event.competitions?.[0]?.competitors?.find(
            (c) => c.homeAway === "away",
          );
          if (home?.team?.displayName) {
            learnTeamAlias(ours.homeTeam, home.team.displayName);
          }
          if (away?.team?.displayName) {
            learnTeamAlias(ours.awayTeam, away.team.displayName);
          }
        } catch (err) {
          logger.debug(
            "EspnSource",
            `learnTeamAlias failed (non-fatal): ${(err as Error).message}`,
          );
        }
      }
    }
  }

  if (out.size > 0) {
    logger.info(
      "EspnSource",
      `Resolved ${out.size}/${events.length} events via ESPN (${bySlug.size} leagues queried)`,
    );
  }
  return out;
}

// ─── Match-level stats (cards, corners) via /summary ─────────────────────────

/**
 * ESPN `/summary` boxscore shape. Each team has a flat array of stat rows;
 * we only need a handful.
 */
interface EspnBoxscoreTeam {
  team: { displayName: string };
  homeAway: "home" | "away";
  statistics: { label: string; displayValue: string }[];
}

interface EspnSummary {
  boxscore?: {
    teams?: EspnBoxscoreTeam[];
  };
}

interface EspnCardStats {
  yellowCardsHome: number;
  redCardsHome: number;
  yellowCardsAway: number;
  redCardsAway: number;
  cornersHome: number;
  cornersAway: number;
}

/**
 * Fetch match-level statistics (cards, corners) for a single ESPN event.
 * The `/summary` endpoint is free, unauthenticated, and not
 * Cloudflare-protected — unlike SofaScore.
 *
 * Returns null when the endpoint 404s (event not found / league not
 * supported for summary data) or the boxscore is missing stats.
 */
async function fetchEspnMatchStats(
  espnEventId: string,
  leagueSlug: string,
): Promise<EspnCardStats | null> {
  const url = `${BASE_URL}/${leagueSlug}/summary`;
  try {
    const { data } = await axios.get<EspnSummary>(url, {
      params: { event: espnEventId },
      timeout: HTTP_TIMEOUT_MS,
    });

    const teams = data.boxscore?.teams;
    if (!teams || teams.length < 2) return null;

    const home = teams.find((t) => t.homeAway === "home");
    const away = teams.find((t) => t.homeAway === "away");
    if (!home || !away) return null;

    const stat = (team: EspnBoxscoreTeam, label: string): number => {
      const row = team.statistics.find(
        (s) => s.label.toLowerCase() === label.toLowerCase(),
      );
      if (!row) return 0;
      const n = Number.parseInt(row.displayValue, 10);
      return Number.isFinite(n) ? n : 0;
    };

    return {
      yellowCardsHome: stat(home, "Yellow Cards"),
      redCardsHome: stat(home, "Red Cards"),
      yellowCardsAway: stat(away, "Yellow Cards"),
      redCardsAway: stat(away, "Red Cards"),
      cornersHome: stat(home, "Corner Kicks"),
      cornersAway: stat(away, "Corner Kicks"),
    };
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status;
    // 400/404 = league or event not available — silent skip, not an error.
    if (status === 400 || status === 404) return null;
    logger.warn(
      "EspnSource",
      `GET /${leagueSlug}/summary?event=${espnEventId} failed: ${(err as Error).message}`,
    );
    return null;
  }
}

/**
 * Enrich an existing map of scores with card/corner data from ESPN.
 * Expects scores that were originally resolved by ESPN (i.e. have a
 * sourceUrl like `https://www.espn.com/soccer/match/_/gameId/{espnId}`).
 *
 * This is the **primary** enrichment path for bookings and corners,
 * replacing the SofaScore dependency. ESPN `/summary` is free, unlimited,
 * and not behind Cloudflare.
 *
 * @param scores   Map of eventId → MatchScore (mutated in-place)
 * @param events   Original settle events (for competition → slug lookup)
 * @param opts     Which stats to fetch
 */
export async function enrichEspnStats(
  scores: Map<string, MatchScore>,
  events: SettleEvent[],
  opts: { withCorners?: boolean; withBookings?: boolean },
): Promise<{ enriched: number; skipped: number }> {
  let enriched = 0;
  let skipped = 0;

  const metaById = new Map(events.map((e) => [e.eventId, e]));

  for (const [eventId, score] of scores) {
    // Only enrich scores that came from ESPN (sourceUrl contains espnId).
    const m = score.sourceUrl?.match(/gameId\/(\d+)/);
    if (!m) {
      skipped++;
      continue;
    }

    // Check if enrichment is actually needed
    const needsCorners =
      opts.withCorners &&
      (score.cornersHome == null || score.cornersAway == null);
    const needsBookings =
      opts.withBookings &&
      (score.bookingsHome == null || score.bookingsAway == null);
    if (!needsCorners && !needsBookings) continue;

    // Find the ESPN league slug for this event
    const meta = metaById.get(eventId);
    const slug = meta ? espnSlug(meta.competition) : null;
    if (!slug) {
      skipped++;
      continue;
    }

    const espnId = m[1];
    const stats = await fetchEspnMatchStats(espnId, slug);
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
  }

  if (enriched > 0) {
    const extras: string[] = [];
    if (opts.withCorners) extras.push("corners");
    if (opts.withBookings) extras.push("bookings");
    logger.info(
      "EspnSource",
      `Enriched ${enriched} events with ${extras.join("+")} via ESPN /summary (${skipped} skipped)`,
    );
  }
  return { enriched, skipped };
}
