
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
import { addDays, format } from "date-fns";

const BASE_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const MATCH_SCORE_THRESHOLD = 0.65;
const KICKOFF_WINDOW_MS = 90 * 60 * 1000;
const HTTP_TIMEOUT_MS = 12_000;

const LEAGUE_ALIASES: Record<string, string> = {
  allsvenskan: "swe.1",
  "sweden allsvenskan": "swe.1",
  superettan: "swe.2",
  "sweden superettan": "swe.2",

  bundesliga: "ger.1",
  "german bundesliga": "ger.1",
  "germany bundesliga": "ger.1",
  "bundesliga 2": "ger.2",
  "2. bundesliga": "ger.2",
  "germany bundesliga 2": "ger.2",
  "3. liga": "ger.3",
  "germany 3. liga": "ger.3",
  "germany 3 liga": "ger.3",

  "premier league": "eng.1",
  "england premier league": "eng.1",
  "english premier league": "eng.1",
  championship: "eng.2",
  "england championship": "eng.2",
  "league 1": "eng.3",
  "england league 1": "eng.3",
  "league one": "eng.3",

  "serie a": "ita.1",
  "italy serie a": "ita.1",
  "serie b": "ita.2",
  "italy serie b": "ita.2",

  "la liga": "esp.1",
  "primera division": "esp.1",
  "spain la liga": "esp.1",
  "la liga 2": "esp.2",
  segunda: "esp.2",

  "ligue 1": "fra.1",
  "france ligue 1": "fra.1",
  "ligue 2": "fra.2",
  "france ligue 2": "fra.2",

  "super lig": "tur.1",
  "super league": "tur.1",
  "turkey super lig": "tur.1",
  "turkey super league": "tur.1",

  psl: "rsa.1",
  "south africa psl": "rsa.1",
  "premier soccer league": "rsa.1",

  eliteserien: "nor.1",
  "norway eliteserien": "nor.1",
  "1st division": "nor.2",
  "norway 1st division": "nor.2",
  obosligaen: "nor.2",

  "primeira liga": "por.1",
  "portugal primeira liga": "por.1",

  eredivisie: "ned.1",
  "netherlands eredivisie": "ned.1",

  premiership: "sco.1",
  "scotland premiership": "sco.1",
  "scotland championship": "sco.2",

  superliga: "den.1",
  "denmark superliga": "den.1",
  "denmark division 1": "den.2",
  "denmark 1st division": "den.2",
  "1 division": "den.2",

  veikkausliiga: "fin.1",
  "finland veikkausliiga": "fin.1",
  ykkonen: "fin.2",
  "finland ykkonen": "fin.2",

  ekstraklasa: "pol.1",
  "poland ekstraklasa": "pol.1",
  "1 liga": "pol.2",
  "poland 1st liga": "pol.2",

  "pro league": "bel.1",
  "jupiler pro league": "bel.1",
  "belgium pro league": "bel.1",

  "premier liga": "rus.1",
  "russian premier liga": "rus.1",

  "albania superliga": "alb.1",
  "albanian superliga": "alb.1",
  "bosnia premier league": "bih.1",
  "bulgarian a league": "bul.1",

  "thai league 1": "tha.1",
  "thailand league 1": "tha.1",
  "thailand league 2": "tha.2",
  "thai league 2": "tha.2",

  "friendlies women": "fifa.friendlies.w",
  "international friendlies": "fifa.friendlies",
  "club friendlies": "club.friendlies",

  "lithuania a lyga": "ltu.1",
  "latvia higher league": "lva.1",
  "israeli premier league": "isr.1",
  "saudi pro league": "ksa.1",
  "iran persian gulf pro league": "irn.1",

  brasileirao: "bra.1",
  "brazil serie a": "bra.1",
  "brazilian serie a": "bra.1",
  "brazil serie b": "bra.2",
  "brazilian serie b": "bra.2",
  "brazil serie c": "bra.3",
  "brazilian serie c": "bra.3",
  "brazil serie d": "bra.4",

  "liga profesional": "arg.1",
  "argentine primera": "arg.1",

  "chinese super league": "chn.1",
  "china super league": "chn.1",

  "j league": "jpn.1",
  "j1 league": "jpn.1",
  "k league": "kor.1",
  "k league 1": "kor.1",

  mls: "usa.1",
  "major league soccer": "usa.1",

  "champions league": "uefa.champions",
  "uefa champions league": "uefa.champions",
  "europa league": "uefa.europa",
  "uefa europa league": "uefa.europa",
  "conference league": "uefa.europa.conf",
  "uefa conference league": "uefa.europa.conf",

  "singapore premier league": "sgp.1",
  "singapore league 1": "sgp.1",
  spfl: "sgp.1",
  "singapore premier league 1": "sgp.1",

  "uae pro league": "uae.1",
  "uae league": "uae.1",

  "world cup": "fifa.world",
  "fifa world cup": "fifa.world",
  "world cup qualifiers europe": "fifa.worldq.uefa",
  "world cup qualifiers europe women": "fifa.worldq.uefa.w",
  "fifa wcq europe women": "fifa.worldq.uefa.w",

  "caf champions league": "caf.champions",
  "caf confederation cup": "caf.confed",

  "copa libertadores": "conmebol.libertadores",
  libertadores: "conmebol.libertadores",
  "copa sudamericana": "conmebol.sudamericana",

  "croatian hnl": "cro.1",
  "croatia hnl": "cro.1",

  "czech first league": "cze.1",
  "czech liga": "cze.1",

  "romania liga 1": "rou.1",

  "nb i": "hun.1",
  "hungary nb i": "hun.1",

  "super league greece": "gre.1",
  "greece super league": "gre.1",

  "austrian bundesliga": "aut.1",
  "austria bundesliga": "aut.1",

  "swiss super league": "sui.1",
  "switzerland super league": "sui.1",

  "serbian superliga": "srb.1",

  "ukrainian premier league": "ukr.1",

  "egyptian premier league": "egy.1",

  "liga mx": "mex.1",
  "mexico liga mx": "mex.1",

  "colombian primera a": "col.1",
  "colombia primera a": "col.1",

  "chilean primera": "chi.1",

  "peruvian primera": "per.1",

  "paraguay primera": "par.1",

  "uruguayan primera": "uru.1",

  "a league": "aus.1",
  "a league men": "aus.1",

  "indian super league": "ind.1",

  "iceland 1 deild": "ice.1",
  "iceland 1. deild": "ice.1",
  "1. deild": "ice.1",
  "iceland division 1": "ice.1",

  "kuwait premier league": "kwt.1",
  "kuwait premier": "kwt.1",

  "australia cup qualifiers": "aus.cup",
  "australia cup": "aus.cup",

  "usa women premier soccer league": "usa.w.1",
  "women premier soccer league": "usa.w.1",
  "wpsl": "usa.w.1",
};

const espnSlug = (raw: string | null): string | null => {
  if (!raw) return null;
  const learned = lookupCompetitionSlug(raw, "espn");
  if (learned) return learned;
  const norm = normalizeCompetition(raw);
  if (LEAGUE_ALIASES[norm]) return LEAGUE_ALIASES[norm];
  for (const [alias, slug] of Object.entries(LEAGUE_ALIASES)) {
    if (norm.includes(alias)) return slug;
  }
  const stripped = norm
    .replace(/\b(women|ladies|w|division|deild|cup|qualifiers?|1\.?|first)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped && stripped !== norm) {
    if (LEAGUE_ALIASES[stripped]) return LEAGUE_ALIASES[stripped];
    for (const [alias, slug] of Object.entries(LEAGUE_ALIASES)) {
      if (stripped.includes(alias) || alias.includes(stripped)) return slug;
    }
  }
  return null;
};


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


const yyyymmdd = (d: Date): string => format(d, "yyyyMMdd");

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
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === 400) return [];
    logger.warn(
      "EspnSource",
      `GET /${slug}/scoreboard failed: ${(err as Error).message}`,
    );
    return [];
  }
};


export async function fetchEspnScores(
  events: SettleEvent[],
): Promise<Map<string, MatchScore>> {
  const out = new Map<string, MatchScore>();
  if (events.length === 0) return out;

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
    const stamps = bucket
      .map((e) => new Date(e.startTime).getTime())
      .sort((a, b) => a - b);
    const earliest = addDays(new Date(stamps[0]), -1);
    const latest = addDays(new Date(stamps[stamps.length - 1]), 1);
    const dateFrom = yyyymmdd(earliest);
    const dateTo = yyyymmdd(latest);

    const espnEvents = await fetchLeagueScoreboard(slug, dateFrom, dateTo);
    if (espnEvents.length === 0) continue;

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
    if (status === 400 || status === 404) return null;
    logger.warn(
      "EspnSource",
      `GET /${leagueSlug}/summary?event=${espnEventId} failed: ${(err as Error).message}`,
    );
    return null;
  }
}

export async function enrichEspnStats(
  scores: Map<string, MatchScore>,
  events: SettleEvent[],
  opts: { withCorners?: boolean; withBookings?: boolean },
): Promise<{ enriched: number; skipped: number }> {
  let enriched = 0;
  let skipped = 0;

  const metaById = new Map(events.map((e) => [e.eventId, e]));

  for (const [eventId, score] of scores) {
    const m = score.sourceUrl?.match(/gameId\/(\d+)/);
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
