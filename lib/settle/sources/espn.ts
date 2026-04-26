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

const BASE_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const MATCH_SCORE_THRESHOLD = 0.65;
const KICKOFF_WINDOW_MS = 90 * 60 * 1000; // 90 minutes — covers timezone skew + leagues where Pinnacle times differ from ESPN
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

const yyyymmdd = (d: Date): string =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

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
    // on both sides. Pad 1 day each side to tolerate timezone skew.
    const stamps = bucket
      .map((e) => new Date(e.startTime).getTime())
      .sort((a, b) => a - b);
    const earliest = new Date(stamps[0] - 86_400_000);
    const latest = new Date(stamps[stamps.length - 1] + 86_400_000);
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
        if (combined < MATCH_SCORE_THRESHOLD) continue;

        if (!best || combined > best.score) {
          best = { event: theirs, score: combined };
        }
      }

      if (!best) continue;
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
