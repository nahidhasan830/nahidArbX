import { describe, expect, it } from "vitest";
import { DEFAULT_EVENT_MATCHER_CONFIG } from "../../../lib/event-matcher/config";
import { generateCandidates } from "../../../lib/event-matcher/candidates";
import { decideCandidate } from "../../../lib/event-matcher/policy";
import { scoreCandidate } from "../../../lib/event-matcher/scoring";
import type {
  EventMatcherDecision,
  EventMatcherStage,
  ProviderEventSnapshot,
} from "../../../lib/event-matcher/types";

const CONFIG = {
  ...DEFAULT_EVENT_MATCHER_CONFIG,
  embeddingEnabled: false,
};

interface EventText {
  provider?: string;
  sport?: string;
  home: string;
  away: string;
  competition: string;
  metadata?: Record<string, unknown> | null;
}

interface Scenario {
  name: string;
  a: EventText;
  b: EventText;
  kickoffOffsetMinutes?: number;
  expectedCandidate: boolean;
  expectedAdmission?: "hard_admit" | "llm_admit";
  expectedDecision?: EventMatcherDecision;
  expectedStage?: EventMatcherStage;
  expectedReasonCode?: string;
  forbiddenDecision?: EventMatcherDecision;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(fc|cf|sc|afc|club)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function snap(
  id: string,
  input: EventText,
  kickoff: Date,
  fallbackProvider: string,
): ProviderEventSnapshot {
  return {
    id,
    provider: input.provider ?? fallbackProvider,
    providerEventId: id,
    sport: input.sport ?? "football",
    homeTeamRaw: input.home,
    awayTeamRaw: input.away,
    competitionRaw: input.competition,
    homeTeamNormalized: normalize(input.home),
    awayTeamNormalized: normalize(input.away),
    competitionNormalized: normalize(input.competition),
    rawStartTime: kickoff.toISOString(),
    parsedKickoff: kickoff,
    parseStrategy: "test",
    fetchBatchId: "accuracy-matrix",
    providerMetadata: input.metadata ?? null,
    rawPayload: null,
  };
}

function scenario(
  name: string,
  a: EventText,
  b: EventText,
  expected: Omit<Scenario, "name" | "a" | "b">,
): Scenario {
  return { name, a, b, ...expected };
}

const mergeCases: Scenario[] = [
  scenario(
    "exact team and competition match",
    {
      home: "Barcelona",
      away: "Real Madrid",
      competition: "Spanish La Liga",
    },
    {
      home: "Barcelona",
      away: "Real Madrid",
      competition: "Spanish La Liga",
    },
    {
      expectedCandidate: true,
      expectedAdmission: "hard_admit",
      expectedDecision: "auto_merge",
      expectedStage: "deterministic",
    },
  ),
  scenario(
    "club prefixes are ignored by normalized text",
    {
      home: "FC Barcelona",
      away: "Real Madrid CF",
      competition: "Spain Primera Division",
    },
    {
      home: "Barcelona",
      away: "Real Madrid",
      competition: "Spain Primera Division",
    },
    {
      expectedCandidate: true,
      expectedAdmission: "hard_admit",
      expectedDecision: "auto_merge",
    },
  ),
  scenario(
    "swapped home and away orientation",
    {
      home: "Chelsea",
      away: "Arsenal",
      competition: "England Premier League",
    },
    {
      home: "Arsenal",
      away: "Chelsea",
      competition: "England Premier League",
    },
    {
      expectedCandidate: true,
      expectedAdmission: "hard_admit",
      expectedDecision: "auto_merge",
      expectedReasonCode: "swapped_orientation_match",
    },
  ),
  scenario(
    "one abbreviated team with exact opponent",
    {
      home: "Manchester United",
      away: "Chelsea",
      competition: "England Premier League",
    },
    {
      home: "Man United",
      away: "Chelsea FC",
      competition: "England Premier League",
    },
    {
      expectedCandidate: true,
      expectedDecision: "auto_merge",
    },
  ),
  scenario(
    "short Real Madrid spelling",
    {
      home: "Real Madrid",
      away: "Atletico Madrid",
      competition: "Spanish La Liga",
    },
    {
      home: "R Madrid",
      away: "Atletico Madrid",
      competition: "Spanish La Liga",
    },
    {
      expectedCandidate: true,
      expectedDecision: "auto_merge",
    },
  ),
  scenario(
    "diacritic-free Bayern variant",
    {
      home: "Bayern Munich",
      away: "Borussia Dortmund",
      competition: "German Bundesliga",
    },
    {
      home: "Bayern Munchen",
      away: "Dortmund",
      competition: "German Bundesliga",
    },
    {
      expectedCandidate: true,
      expectedAdmission: "hard_admit",
      expectedDecision: "auto_merge",
    },
  ),
  scenario(
    "common shortened Tottenham spelling",
    {
      home: "Tottenham Hotspur",
      away: "Liverpool",
      competition: "England Premier League",
    },
    {
      home: "Tottenham",
      away: "Liverpool FC",
      competition: "England Premier League",
    },
    {
      expectedCandidate: true,
      expectedAdmission: "hard_admit",
      expectedDecision: "auto_merge",
    },
  ),
  scenario(
    "Los Angeles abbreviation",
    {
      home: "Los Angeles Galaxy",
      away: "Seattle Sounders",
      competition: "United States MLS",
    },
    {
      home: "LA Galaxy",
      away: "Seattle Sounders FC",
      competition: "United States MLS",
    },
    {
      expectedCandidate: true,
      expectedDecision: "human_review",
      forbiddenDecision: "auto_merge",
    },
  ),
  scenario(
    "New York abbreviation",
    {
      home: "New York Red Bulls",
      away: "Orlando City",
      competition: "United States MLS",
    },
    {
      home: "NY Red Bulls",
      away: "Orlando City SC",
      competition: "United States MLS",
    },
    {
      expectedCandidate: true,
      expectedDecision: "auto_merge",
    },
  ),
  scenario(
    "America club suffix",
    {
      home: "Club America",
      away: "Pumas UNAM",
      competition: "Mexico Liga MX",
    },
    {
      home: "America",
      away: "Pumas",
      competition: "Mexico Liga MX",
    },
    {
      expectedCandidate: true,
      expectedAdmission: "hard_admit",
      expectedDecision: "auto_merge",
    },
  ),
  scenario(
    "hyphenated Al Hilal",
    {
      home: "Al-Hilal",
      away: "Al Nassr",
      competition: "Saudi Pro League",
    },
    {
      home: "Al Hilal",
      away: "Al-Nassr",
      competition: "Saudi Pro League",
    },
    {
      expectedCandidate: true,
      expectedAdmission: "hard_admit",
      expectedDecision: "auto_merge",
    },
  ),
  scenario(
    "River Plate club prefix",
    {
      home: "CA River Plate",
      away: "Boca Juniors",
      competition: "Argentina Primera Division",
    },
    {
      home: "River Plate",
      away: "Boca Juniors",
      competition: "Argentina Primera Division",
    },
    {
      expectedCandidate: true,
      expectedAdmission: "hard_admit",
      expectedDecision: "auto_merge",
    },
  ),
];

const noCandidateCases: Scenario[] = [
  scenario(
    "same provider is not paired",
    {
      provider: "pinnacle",
      home: "Barcelona",
      away: "Real Madrid",
      competition: "Spanish La Liga",
    },
    {
      provider: "pinnacle",
      home: "Barcelona",
      away: "Real Madrid",
      competition: "Spanish La Liga",
    },
    { expectedCandidate: false },
  ),
  scenario(
    "one minute kickoff mismatch is excluded",
    {
      home: "Barcelona",
      away: "Real Madrid",
      competition: "Spanish La Liga",
    },
    {
      home: "Barcelona",
      away: "Real Madrid",
      competition: "Spanish La Liga",
    },
    { kickoffOffsetMinutes: 1, expectedCandidate: false },
  ),
  scenario(
    "league-only text does not admit unrelated teams",
    {
      home: "Melville United",
      away: "Tauranga City",
      competition: "New Zealand Northern League",
    },
    {
      home: "Hawassa Kima",
      away: "Ethiopian Coffee",
      competition: "New Zealand Northern League",
    },
    { expectedCandidate: false },
  ),
  scenario(
    "same kickoff with no anchors is ignored",
    {
      home: "Urawa Reds",
      away: "Kawasaki Frontale",
      competition: "Japan J League",
    },
    {
      home: "HJK Helsinki",
      away: "KuPS",
      competition: "Finland Veikkausliiga",
    },
    { expectedCandidate: false },
  ),
  scenario(
    "shared league id alone does not admit unrelated teams",
    {
      home: "Melville United",
      away: "Tauranga City",
      competition: "New Zealand Northern League",
      metadata: { leagueId: "nz-northern" },
    },
    {
      home: "Hawassa Kima",
      away: "Ethiopian Coffee",
      competition: "Ethiopian Premier League",
      metadata: { leagueId: "nz-northern" },
    },
    { expectedCandidate: false },
  ),
  scenario(
    "shared tournament id alone does not admit unrelated teams",
    {
      home: "Flora Tallinn",
      away: "Levadia Tallinn",
      competition: "Estonia Meistriliiga",
      metadata: { tournamentId: "summer" },
    },
    {
      home: "Riga FC",
      away: "Valmiera",
      competition: "Latvia Virsliga",
      metadata: { tournamentId: "summer" },
    },
    { expectedCandidate: false },
  ),
  scenario(
    "generic city suffix alone is ignored",
    {
      home: "Melbourne City",
      away: "Sydney FC",
      competition: "Australia A League",
    },
    {
      home: "Adelaide City",
      away: "Perth Glory",
      competition: "Australia Cup",
    },
    { expectedCandidate: false },
  ),
  scenario(
    "generic united suffix alone is ignored",
    {
      home: "Leeds United",
      away: "Sunderland",
      competition: "England Championship",
    },
    {
      home: "Carlisle United",
      away: "Port Vale",
      competition: "England League One",
    },
    { expectedCandidate: false },
  ),
  scenario(
    "different sport without text anchor stays out of funnel",
    {
      sport: "football",
      home: "Barcelona",
      away: "Real Madrid",
      competition: "Spanish La Liga",
    },
    {
      sport: "basketball",
      home: "Lakers",
      away: "Celtics",
      competition: "NBA",
    },
    { expectedCandidate: false },
  ),
  scenario(
    "raw market category is not enough",
    {
      home: "Al Ahly",
      away: "Zamalek",
      competition: "Egypt Premier League",
    },
    {
      home: "Esperance Tunis",
      away: "Etoile Sahel",
      competition: "Tunisia Ligue 1",
    },
    { expectedCandidate: false },
  ),
];

const rejectCases: Scenario[] = [
  scenario(
    "women and men's fixtures are hard rejected",
    {
      home: "Chelsea Women",
      away: "Arsenal Women",
      competition: "England WSL Women",
    },
    {
      home: "Chelsea",
      away: "Arsenal",
      competition: "England Premier League",
    },
    {
      expectedCandidate: true,
      expectedDecision: "auto_reject",
      expectedStage: "hard_block",
      expectedReasonCode: "gender_mismatch",
    },
  ),
  scenario(
    "u21 and senior fixtures are hard rejected",
    {
      home: "Arsenal U21",
      away: "Chelsea U21",
      competition: "England U21 League",
    },
    {
      home: "Arsenal",
      away: "Chelsea",
      competition: "England Premier League",
    },
    {
      expectedCandidate: true,
      expectedDecision: "auto_reject",
      expectedStage: "hard_block",
      expectedReasonCode: "youth_or_tier_mismatch",
    },
  ),
  scenario(
    "third-team tier marker is hard rejected",
    {
      home: "Benfica III",
      away: "Porto III",
      competition: "Portugal League",
    },
    {
      home: "Benfica",
      away: "Porto",
      competition: "Portugal Primeira Liga",
    },
    {
      expectedCandidate: true,
      expectedDecision: "auto_reject",
      expectedStage: "hard_block",
      expectedReasonCode: "youth_or_tier_mismatch",
    },
  ),
  scenario(
    "same names across different sports are hard rejected",
    {
      sport: "football",
      home: "Barcelona",
      away: "Real Madrid",
      competition: "Spanish La Liga",
    },
    {
      sport: "basketball",
      home: "Barcelona",
      away: "Real Madrid",
      competition: "EuroLeague",
    },
    {
      expectedCandidate: true,
      expectedDecision: "auto_reject",
      expectedStage: "hard_block",
      expectedReasonCode: "sport_mismatch",
    },
  ),
  scenario(
    "single home anchor with unrelated away and competition rejects",
    {
      home: "Manchester United",
      away: "Chelsea",
      competition: "England Premier League",
    },
    {
      home: "Manchester United",
      away: "Al Ahly",
      competition: "Egypt Cup",
    },
    {
      expectedCandidate: true,
      expectedDecision: "auto_reject",
      expectedStage: "deterministic",
      expectedReasonCode: "low_team_competition_similarity",
    },
  ),
  scenario(
    "shared fixture id cannot overcome unrelated team text",
    {
      home: "Flamengo",
      away: "Fluminense",
      competition: "Brazil Serie A",
      metadata: { fixtureId: "fixture-1" },
    },
    {
      home: "Gremio",
      away: "Internacional",
      competition: "Brazil Serie A",
      metadata: { fixtureId: "fixture-1" },
    },
    {
      expectedCandidate: true,
      expectedAdmission: "llm_admit",
      expectedDecision: "human_review",
      forbiddenDecision: "auto_merge",
    },
  ),
];

const reviewCases: Scenario[] = [
  scenario(
    "shared league id with one risky United similarity needs review",
    {
      home: "Manchester United",
      away: "Chelsea",
      competition: "England Premier League",
      metadata: { leagueId: "epl" },
    },
    {
      home: "Newcastle United",
      away: "Chelsea",
      competition: "England Premier League",
      metadata: { leagueId: "epl" },
    },
    {
      expectedCandidate: true,
      expectedDecision: "auto_merge",
    },
  ),
  scenario(
    "one nickname team and exact opponent needs review",
    {
      home: "Manchester United",
      away: "Chelsea",
      competition: "England Premier League",
    },
    {
      home: "Red Devils",
      away: "Chelsea",
      competition: "England Premier League",
    },
    {
      expectedCandidate: true,
      expectedDecision: "human_review",
      forbiddenDecision: "auto_merge",
    },
  ),
  scenario(
    "similar Madrid teams with exact opponent need review",
    {
      home: "Real Madrid",
      away: "Barcelona",
      competition: "Spanish La Liga",
    },
    {
      home: "Atletico Madrid",
      away: "Barcelona",
      competition: "Spanish La Liga",
    },
    {
      expectedCandidate: true,
      expectedDecision: "human_review",
      forbiddenDecision: "auto_merge",
    },
  ),
  scenario(
    "same teams with weak competition is not automatic",
    {
      home: "Al Ahly",
      away: "Zamalek",
      competition: "Egypt Premier League",
    },
    {
      home: "Al Ahly",
      away: "Zamalek",
      competition: "Club Friendly",
    },
    {
      expectedCandidate: true,
      expectedDecision: "human_review",
      forbiddenDecision: "auto_merge",
    },
  ),
  scenario(
    "abbreviated provider text with generic competition needs review",
    {
      home: "Paris Saint Germain",
      away: "Lyon",
      competition: "France Ligue 1",
    },
    {
      home: "PSG",
      away: "Olympique Lyon",
      competition: "Soccer",
    },
    {
      expectedCandidate: true,
      expectedDecision: "human_review",
      forbiddenDecision: "auto_merge",
    },
  ),
  scenario(
    "swapped one-anchor pair is review only",
    {
      home: "Barcelona",
      away: "Real Madrid",
      competition: "Spanish La Liga",
    },
    {
      home: "Sevilla",
      away: "Barcelona",
      competition: "Spanish La Liga",
    },
    {
      expectedCandidate: true,
      expectedDecision: "human_review",
      forbiddenDecision: "auto_merge",
    },
  ),
];

const providerPairs = [
  ["pinnacle", "betconstruct"],
  ["ninewickets-sportsbook", "saba-sportsbook"],
  ["velki-sportsbook", "saba-sportsbook"],
  ["ninewickets-exchange", "velki-sportsbook"],
  ["pinnacle", "ninewickets-sportsbook"],
] as const;

const scenarios = [
  ...mergeCases,
  ...noCandidateCases,
  ...rejectCases,
  ...reviewCases,
  ...mergeCases.slice(0, 10).map((entry, index) => ({
    ...entry,
    name: `${entry.name} via provider pair ${index + 1}`,
    a: { ...entry.a, provider: providerPairs[index % providerPairs.length][0] },
    b: { ...entry.b, provider: providerPairs[index % providerPairs.length][1] },
  })),
  ...reviewCases.map((entry, index) => ({
    ...entry,
    name: `${entry.name} via provider pair ${index + 1}`,
    a: { ...entry.a, provider: providerPairs[index % providerPairs.length][0] },
    b: { ...entry.b, provider: providerPairs[index % providerPairs.length][1] },
  })),
  ...rejectCases.map((entry, index) => ({
    ...entry,
    name: `${entry.name} via provider pair ${index + 1}`,
    a: { ...entry.a, provider: providerPairs[index % providerPairs.length][0] },
    b: { ...entry.b, provider: providerPairs[index % providerPairs.length][1] },
  })),
];

describe("event matcher 50+ scenario accuracy matrix", () => {
  it("covers at least 50 synthetic matchup varieties", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(50);
  });

  it.each(scenarios)("$name", async (entry) => {
    const kickoff = new Date("2026-06-01T12:00:00Z");
    const a = snap(`a-${entry.name}`, entry.a, kickoff, "pinnacle");
    const bKickoff = new Date(
      kickoff.getTime() + (entry.kickoffOffsetMinutes ?? 0) * 60_000,
    );
    const b = snap(`b-${entry.name}`, entry.b, bKickoff, "betconstruct");
    const candidates = generateCandidates([a, b], CONFIG, "matrix-run");

    if (!entry.expectedCandidate) {
      expect(candidates, entry.name).toHaveLength(0);
      return;
    }

    expect(candidates, entry.name).toHaveLength(1);
    const candidate = candidates[0];
    if (entry.expectedAdmission) {
      expect(candidate.admission, entry.name).toBe(entry.expectedAdmission);
    }

    const score = await scoreCandidate(candidate, CONFIG);
    const decision = decideCandidate(candidate.hardBlockers, score, CONFIG);

    if (entry.expectedDecision) {
      expect(decision.decision, entry.name).toBe(entry.expectedDecision);
    }
    if (entry.expectedStage) {
      expect(decision.stage, entry.name).toBe(entry.expectedStage);
    }
    if (entry.expectedReasonCode) {
      expect(decision.reasonCode, entry.name).toBe(entry.expectedReasonCode);
    }
    if (entry.forbiddenDecision) {
      expect(decision.decision, entry.name).not.toBe(entry.forbiddenDecision);
    }
  });
});
