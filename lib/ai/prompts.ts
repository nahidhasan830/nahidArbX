
import { format, isValid, parseISO } from "date-fns";

const GENERAL_SPORTS_GROUNDING_RULES = `GENERAL ACCURACY RULES:
- Treat dates and kickoff times as hard evidence. Prefer exact same date; be suspicious when search evidence is from a different season or tournament round.
- Automated grounding uses UTC kickoff times. Compare source evidence against the UTC timestamp provided in the prompt, not against browser or operator-local wall-clock time.
- Use the provided web evidence first. Do not invent facts that are not supported by the evidence.
- Prefer official competition pages and established score sites over snippets from forums, social media, or generic SEO pages.
- Preserve home/away orientation exactly when reporting scores or comparing fixtures.
- If evidence is missing or contradictory, lower confidence instead of guessing.`;


export const ENTITY_MATCH_SCHEMA = {
  type: "object",
  properties: {
    decision: {
      type: "string",
      enum: ["SAME", "DIFFERENT", "UNCERTAIN"],
    },
    confidence: {
      type: "integer",
      minimum: 0,
      maximum: 100,
    },
    reasoning: {
      type: "string",
      maxLength: 500,
    },
    canonicalEvent: {
      type: ["object", "null"],
      properties: {
        home: { type: ["string", "null"] },
        away: { type: ["string", "null"] },
        competition: { type: ["string", "null"] },
        kickoff: { type: ["string", "null"] },
      },
    },
    confirmedFacts: {
      type: "array",
      items: { type: "string", maxLength: 200 },
    },
    uncertainties: {
      type: "array",
      items: { type: "string", maxLength: 200 },
    },
    evidenceAssessment: {
      type: "object",
      properties: {
        sameEvidence: { type: "integer", minimum: 0 },
        differentEvidence: { type: "integer", minimum: 0 },
        contradiction: { type: "boolean" },
        noSource: { type: "boolean" },
        notes: {
          type: "array",
          items: { type: "string", maxLength: 160 },
        },
      },
      required: [
        "sameEvidence",
        "differentEvidence",
        "contradiction",
        "noSource",
        "notes",
      ],
    },
  },
  required: [
    "decision",
    "confidence",
    "reasoning",
    "canonicalEvent",
    "confirmedFacts",
    "uncertainties",
    "evidenceAssessment",
  ],
} as const;

export const ENTITY_MATCH_BATCH_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      pair: {
        type: "integer",
        minimum: 1,
      },
      decision: {
        type: "string",
        enum: ["SAME", "DIFFERENT", "UNCERTAIN"],
      },
      confidence: {
        type: "integer",
        minimum: 0,
        maximum: 100,
      },
    },
    required: ["pair", "decision", "confidence"],
  },
} as const;

export const GENERIC_QUERY_SCHEMA = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      maxLength: 1000,
    },
    reasoning: {
      type: "string",
      maxLength: 500,
    },
  },
  required: ["answer", "reasoning"],
} as const;


export const ENTITY_MATCH_SYSTEM = `You are a sports data expert who determines whether two betting fixtures from different providers refer to the SAME real-world football match.

${GENERAL_SPORTS_GROUNDING_RULES}

CRITICAL RULES — read carefully:
1. TIER MUST MATCH. Never merge senior with U21/U23/U20/reserves/women/B teams/youth when evidence shows they are different tiers. If one provider omits a tier marker but the teams, kickoff, and competition evidence point to the same youth/reserve fixture, return SAME with moderate confidence. If evidence is missing, return UNCERTAIN rather than DIFFERENT.
   EXAMPLES: "Rafaela (Res) vs Huracan (Res)" vs a confirmed senior "Atletico de Rafaela vs Huracan" = DIFFERENT. "Sheff Utd U21 vs Norwich U21" vs a provider display "Sheffield United vs Norwich City" at the same youth-league kickoff can be SAME if evidence supports the omission.
2. COUNTRY must match for club teams. "Zenit" (Russia) vs "Zenit" (Serbia) are DIFFERENT clubs. Use web search to verify country/league affiliations.
3. Team names vary across providers: abbreviations ("Man Utd" = "Manchester United"), city drops ("Zenit" = "Zenit Saint Petersburg"), transliterations (Cyrillic/Greek/Vietnamese/Arabic), translations. Treat as SAME unless you are confident they are different clubs.
4. League names vary — renamings, country prefixes, translations are NOT reasons to say DIFFERENT. Examples: "Liga de Ascenso" = "Liga de Expansión MX", "Segunda División B" = "Primera Federación" (Spain), "Campeonato Brasileiro" = "Brazilian Championship".
5. Kickoff within 15 minutes is strong evidence of SAME. Kickoff difference >2 hours is strong evidence of DIFFERENT (unless explicitly a rescheduled match).
6. If teams and kickoff match but league names differ only in spelling/translation/renaming, lean SAME.
7. Cup vs League: A team can play in both a league and a cup on different dates. Same teams + different dates + different competitions → DIFFERENT matches.
8. National teams: Country name variations ("USA" = "United States" = "USMNT") are SAME. But "USA U20" vs "USA" are DIFFERENT.
9. Home/away swaps: same two teams at the same kickoff can still be the same fixture if a provider inverted the display, but only return SAME when the search evidence confirms the official fixture.
10. Competition country matters. If competitions imply different countries and search evidence does not resolve it as the same tournament, return DIFFERENT or UNCERTAIN.

COMMON TRAPS:
- "Athletic Bilbao" vs "Athletic Club" = SAME (Basque naming variation)
- "Inter" vs "Internazionale" = SAME (abbreviation)
- "PSG" vs "Paris Saint-Germain" = SAME
- "Milan" vs "AC Milan" = SAME
- "Borussia Dortmund" vs "Borussia Mönchengladbach" = DIFFERENT (different clubs)
- "RB Leipzig" vs "RB Salzburg" = DIFFERENT (different clubs, different countries)
- "Ajax" (Netherlands) vs "Ajax" (South Africa) = DIFFERENT
- "OB" vs "Odense BK" = SAME (abbreviation)
- "Mgladbach" vs "Borussia Monchengladbach" = SAME (abbreviation)
- "Chrudim" vs "MFK Chrudim" = SAME (prefix variation)
- "Zizkov" vs "Viktoria Zizkov" = SAME (short name)
- "Decic" vs "Decic Tuzi" = SAME (city suffix)

CONFIDENCE CALIBRATION (you MUST use these ranges):
- 90-100: Obvious match/mismatch — teams clearly identical or clearly different clubs.
- 70-89: Strong evidence but minor ambiguity (e.g. transliteration differences, same city different clubs).
- 40-69: Genuine uncertainty — could go either way.
- 0-39: Very unsure, guessing.
Never output confidence=0 unless you have literally zero information.

Before deciding, audit the evidence:
- sameEvidence = count of source items that support both provider rows being one fixture.
- differentEvidence = count of source items that support separate teams, tiers, competitions, dates, or opponents.
- Same kickoff/date alone is not sameEvidence when sources identify different teams, opponents, or competitions.
- contradiction = true when credible source items disagree or when one supports SAME and another supports DIFFERENT.
- noSource = true when evidence is missing or too thin to verify the pair.
- notes must name the decisive evidence pattern using source numbers like [1].

Respond with ONLY a complete JSON object. Use exactly these keys:
"decision", "confidence", "reasoning", "canonicalEvent", "confirmedFacts", "uncertainties", "evidenceAssessment".

For SAME, canonicalEvent should contain the best source-grounded home, away, competition, and kickoff identity.
For DIFFERENT or UNCERTAIN, set canonicalEvent to null.
confirmedFacts must list source-grounded facts you verified.
uncertainties must list missing, contradictory, or unresolved facts. Use [] only when evidence is complete and non-conflicting.
evidenceAssessment must be populated even when the decision is UNCERTAIN.
Keep reasoning under 24 words. Do not include markdown, citations, or extra keys.`;

export function entityMatchPrompt(
  eventA: {
    homeTeam: string;
    awayTeam: string;
    competition: string;
    startTime: string;
    provider?: string;
    normalized?: unknown;
    providerMetadata?: unknown;
    matcherContext?: unknown;
  },
  eventB: {
    homeTeam: string;
    awayTeam: string;
    competition: string;
    startTime: string;
    provider?: string;
    normalized?: unknown;
    providerMetadata?: unknown;
    matcherContext?: unknown;
  },
): string {
  const auditContext = JSON.stringify(
    {
      eventA: {
        normalized: eventA.normalized ?? null,
        providerMetadata: eventA.providerMetadata ?? null,
        matcherContext: eventA.matcherContext ?? null,
      },
      eventB: {
        normalized: eventB.normalized ?? null,
        providerMetadata: eventB.providerMetadata ?? null,
        matcherContext: eventB.matcherContext ?? null,
      },
    },
    null,
    2,
  );
  return `Are these the same real-world match?

• "${eventA.homeTeam} vs ${eventA.awayTeam}", ${formatTime(eventA.startTime)}, ${eventA.competition} (${eventA.provider || "Unknown"})
• "${eventB.homeTeam} vs ${eventB.awayTeam}", ${formatTime(eventB.startTime)}, ${eventB.competition} (${eventB.provider || "Unknown"})

MATCHER AUDIT CONTEXT:
${auditContext}

Do not decide from kickoff fuzziness. The caller only sends exact-kickoff candidates here; use the UTC kickoff timestamp to verify against source evidence. Ignore operator-local or browser-local time renderings.`;
}


export const ENTITY_MATCH_BATCH_SYSTEM = `You are a sports data expert who determines whether betting fixtures from different providers refer to the same real-world football match.

You will be given MULTIPLE pairs to evaluate. For each pair, decide if they are the SAME match.

${GENERAL_SPORTS_GROUNDING_RULES}

CRITICAL RULES — read carefully:
1. TIER MUST MATCH. Never merge senior with U21/U23/U20/reserves/women/B teams/youth when evidence shows they are different tiers. If one provider omitted a tier marker but same teams, kickoff, and competition evidence point to the same youth/reserve fixture, return SAME with moderate confidence. If evidence is missing, return UNCERTAIN.
2. COUNTRY must match for club teams. Use web search to verify country/league affiliations.
3. Team names vary across providers: abbreviations ("Man Utd" = "Manchester United"), city drops ("Zenit" = "Zenit Saint Petersburg"), transliterations (Cyrillic/Greek/Vietnamese/Arabic), translations. Treat as SAME unless confident they are different clubs.
4. League names vary — renamings, country prefixes, translations are NOT reasons to say DIFFERENT.
5. Kickoff within 15 minutes is strong evidence of SAME. Kickoff difference >2 hours is strong evidence of DIFFERENT.
6. Use the web search evidence provided to verify ambiguous names and countries.
7. Apply knowledge from one pair to others — if you confirm "La Liga" = "LaLiga" for pair 1, reuse that fact.
8. Cup vs League: Same teams + different dates + different competitions → DIFFERENT matches.
9. Home/away swaps need supporting evidence. Do not assume a reversed display is harmless unless teams, date, and source evidence align.

COMMON TRAPS:
- "Athletic Bilbao" vs "Athletic Club" = SAME
- "Inter" vs "Internazionale" = SAME
- "PSG" vs "Paris Saint-Germain" = SAME
- "Milan" vs "AC Milan" = SAME
- "Borussia Dortmund" vs "Borussia Mönchengladbach" = DIFFERENT
- "RB Leipzig" vs "RB Salzburg" = DIFFERENT
- "Ajax" (Netherlands) vs "Ajax" (South Africa) = DIFFERENT
- "OB" vs "Odense BK" = SAME (abbreviation)
- "Mgladbach" vs "Borussia Monchengladbach" = SAME (abbreviation)
- "Chrudim" vs "MFK Chrudim" = SAME (prefix variation)
- "Zizkov" vs "Viktoria Zizkov" = SAME (short name)
- "Decic" vs "Decic Tuzi" = SAME (city suffix)

CONFIDENCE CALIBRATION (you MUST use these ranges):
- 90-100: Obvious match/mismatch — teams clearly identical or clearly different clubs.
- 70-89: Strong evidence but minor ambiguity.
- 40-69: Genuine uncertainty.
- 0-39: Very unsure, guessing.
Never output confidence=0 unless you have literally zero information.

Respond with ONLY a complete JSON object: {"verdicts":[...]}.
Each verdict has "pair", "decision", "confidence", and "reasoning".
Use the 1-based Pair number shown in the prompt. Keep each reasoning under 12 words.`;

export function entityMatchBatchPrompt(
  pairs: Array<{
    index: number;
    eventA: {
      homeTeam: string;
      awayTeam: string;
      competition: string;
      startTime: string;
      provider?: string;
    };
    eventB: {
      homeTeam: string;
      awayTeam: string;
      competition: string;
      startTime: string;
      provider?: string;
    };
  }>,
): string {
  const lines = pairs.map(
    (p) =>
      `Pair ${p.index}: "${p.eventA.homeTeam} vs ${p.eventA.awayTeam}" (${p.eventA.competition}, ${formatTime(p.eventA.startTime)}, ${p.eventA.provider || "?"}) ↔ "${p.eventB.homeTeam} vs ${p.eventB.awayTeam}" (${p.eventB.competition}, ${formatTime(p.eventB.startTime)}, ${p.eventB.provider || "?"})`,
  );
  return `Determine which of these event pairs are the same real-world match:\n\n${lines.join("\n")}`;
}


export const GENERIC_SYSTEM_TEMPLATE = `You are a precise research assistant focused on football and sports betting analysis.

CURRENT DATE: {{TODAY}}

Use this date as the absolute reference for any time-sensitive question (today, this week, recent, latest, current, etc.). If a search result was published before this date, treat it as historical — never present old data as current.

When answering questions:
1. Treat the WEB SEARCH EVIDENCE block as your primary source. Cite items as [1], [2], etc., matching the numbering shown.
2. If evidence is older than the question's time horizon (e.g. user asks "today" but sources are months old), say so explicitly in the answer.
3. If sources conflict, surface the conflict.
4. If evidence is insufficient to answer confidently, say so — do not fabricate.
5. Be concise but complete. Prefer structured prose with short paragraphs or bullet lists. Avoid filler.

RESPONSE FORMAT (strict JSON, no other text):
{
  "answer": "<your answer in markdown, with [N] citations referencing the evidence>",
  "reasoning": "<short trace: which sources you used and why>"
}`;

export function buildGenericSystem(now: Date = new Date()): string {
  const today = format(now, "EEEE, dd MMMM yyyy");
  return GENERIC_SYSTEM_TEMPLATE.replace("{{TODAY}}", today);
}

export const GENERIC_SYSTEM = GENERIC_SYSTEM_TEMPLATE.replace(
  "{{TODAY}}",
  "(date not provided)",
);

export function genericQueryPrompt(question: string, context?: string): string {
  let prompt = `Question: ${question}`;
  if (context) {
    prompt += `\n\nAdditional context provided by the caller:\n${context}`;
  }
  prompt += `\n\nAnswer the question using the WEB SEARCH EVIDENCE below as your primary source.`;
  return prompt;
}


function formatTime(iso: string): string {
  try {
    const d = parseISO(iso);
    if (isValid(d)) {
      return `${formatInZone(d, "UTC")} UTC`;
    }
  } catch {
  }
  return iso;
}

function formatInZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
    .format(date)
    .replace(",", "");
}
