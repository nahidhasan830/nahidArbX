import OpenAI from "openai";
import { logAiActivity } from "@/lib/ai/activity-logger";
import type { SearchResult } from "./types";

const DEFAULT_MAX_QUERIES = 5;
const DEFAULT_RESULTS_PER_QUERY = 5;
const DEFAULT_TIME_ZONE = "Asia/Dhaka";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";

export type SearchPlanFacet =
  | "score_status"
  | "kickoff_time"
  | "venue"
  | "lineups_stats"
  | "competition_context"
  | "general";

export interface PlannedSearchQuery {
  facet: SearchPlanFacet;
  query: string;
  reason: string;
}

export interface SearchPlanningContext {
  now?: Date;
  timeZone?: string;
  maxQueries?: number;
}

export interface SearchQueryPlan {
  originalQuery: string;
  timeZone: string;
  localDate: string;
  localDateLabel: string;
  previousLocalDateLabel: string;
  utcNow: string;
  searchNeeded: boolean;
  intent: string;
  noSearchReason?: string;
  queries: PlannedSearchQuery[];
  usedFallback: boolean;
  model: string;
  rawResponse?: string;
}

export interface PlannedSearchResult extends SearchResult {
  facet: SearchPlanFacet;
  plannedQuery: string;
  rankScore: number;
  providerUsed: string;
}

export interface PlannedSearchRun {
  query: string;
  plan: SearchQueryPlan;
  results: PlannedSearchResult[];
  providerUsed: string;
  resultsByQuery: Array<{
    facet: SearchPlanFacet;
    query: string;
    providerUsed: string;
    results: PlannedSearchResult[];
  }>;
}

type PlannerFn = (input: {
  systemPrompt: string;
  userPrompt: string;
  question: string;
  context: ReturnType<typeof buildTemporalContext>;
  maxQueries: number;
}) => Promise<unknown>;

type SearchFn = (
  query: string,
  maxResults: number,
  preferredProviders?: string[],
) => Promise<{ results: SearchResult[]; provider: string }>;

function getDeepSeekClient(): OpenAI {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not configured");
  return new OpenAI({ baseURL: "https://api.deepseek.com", apiKey });
}

export async function planSearchQueries(
  question: string,
  opts: SearchPlanningContext & {
    planner?: PlannerFn;
  } = {},
): Promise<SearchQueryPlan> {
  const maxQueries = clampQueryCount(opts.maxQueries);
  const timeZone = opts.timeZone || DEFAULT_TIME_ZONE;
  const now = opts.now ?? new Date();
  const context = buildTemporalContext(now, timeZone);
  const { systemPrompt, userPrompt } = buildQueryPlannerPrompt(
    question,
    context,
    maxQueries,
  );

  let rawResponse = "";
  let llmQueries: PlannedSearchQuery[] = [];
  let llmDecision: PlannerDecision | null = null;
  let usedFallback = false;

  try {
    const raw = opts.planner
      ? await opts.planner({
          systemPrompt,
          userPrompt,
          question,
          context,
          maxQueries,
        })
      : await callDeepSeekPlanner({
          systemPrompt,
          userPrompt,
          question,
          context,
          maxQueries,
        });
    rawResponse = stringifyRawPlannerResponse(raw);
    llmDecision = parsePlannerDecision(raw, maxQueries);
    llmQueries = llmDecision.queries;
  } catch {
    usedFallback = true;
  }

  const noSearch = deterministicNoSearchDecision(question);
  const searchNeeded = noSearch ? false : llmDecision?.searchNeeded !== false;
  const safetyQueries = buildDeterministicQueries(question, context, maxQueries);
  const queries = searchNeeded
    ? mergePlannedQueries(llmQueries, safetyQueries, maxQueries)
    : [];
  if (searchNeeded && queries.length === 0) {
    usedFallback = true;
    queries.push(...safetyQueries.slice(0, maxQueries));
  }

  return {
    originalQuery: question,
    timeZone,
    localDate: context.localDate,
    localDateLabel: context.localDateLabel,
    previousLocalDateLabel: context.previousLocalDateLabel,
    utcNow: context.utcNow,
    searchNeeded,
    intent: noSearch?.intent ?? llmDecision?.intent ?? "unknown",
    noSearchReason: noSearch?.reason ?? llmDecision?.noSearchReason,
    queries,
    usedFallback: usedFallback || llmQueries.length === 0,
    model: DEEPSEEK_MODEL,
    rawResponse: rawResponse || undefined,
  };
}

export async function runPlannedSearch(
  question: string,
  opts: SearchPlanningContext & {
    planner?: PlannerFn;
    search: SearchFn;
    preferredProviders?: string[];
    resultsPerQuery?: number;
    maxResults?: number;
  },
): Promise<PlannedSearchRun> {
  const plan = await planSearchQueries(question, opts);
  const maxResults = Math.max(1, Math.min(25, opts.maxResults ?? 10));
  const resultsPerQuery = Math.max(
    1,
    Math.min(10, opts.resultsPerQuery ?? DEFAULT_RESULTS_PER_QUERY),
  );
  const preferredProviders =
    opts.preferredProviders && opts.preferredProviders.length > 0
      ? opts.preferredProviders
      : ["vertex"];

  if (!plan.searchNeeded) {
    return {
      query: question,
      plan,
      results: [],
      providerUsed: "none",
      resultsByQuery: [],
    };
  }

  const settled = await Promise.allSettled(
    plan.queries.map(async (planned) => {
      const found = await opts.search(
        planned.query,
        resultsPerQuery,
        preferredProviders,
      );
      return {
        planned,
        providerUsed: found.provider,
        results: found.results.map((result) =>
          attachPlanMetadata(result, planned, found.provider, plan),
        ),
      };
    }),
  );

  const resultsByQuery: PlannedSearchRun["resultsByQuery"] = [];
  const providers = new Set<string>();
  const allResults: PlannedSearchResult[] = [];

  for (const item of settled) {
    if (item.status !== "fulfilled") continue;
    if (item.value.providerUsed && item.value.providerUsed !== "none") {
      for (const p of item.value.providerUsed.split("+")) providers.add(p);
    }
    resultsByQuery.push({
      facet: item.value.planned.facet,
      query: item.value.planned.query,
      providerUsed: item.value.providerUsed,
      results: item.value.results,
    });
    allResults.push(...item.value.results);
  }

  const results = rankPlannedResults(dedupePlannedResults(allResults)).slice(
    0,
    maxResults,
  );

  return {
    query: question,
    plan,
    results,
    providerUsed: providers.size > 0 ? [...providers].join("+") : "none",
    resultsByQuery,
  };
}

export function buildQueryPlannerPrompt(
  question: string,
  context: ReturnType<typeof buildTemporalContext>,
  maxQueries = DEFAULT_MAX_QUERIES,
) {
  const systemPrompt = `You are a search query planner for a football and sports betting AI playground.
Return only strict JSON. Do not answer the user.

The goal is recall: produce diverse web search queries that cover likely user intent.
For fixture-shaped questions, cover score/status, kickoff time, venue, lineups/stats, and general context.
Respect time zones. The user may say today while search pages show UTC or official fixture dates. Include local date and nearby UTC/previous-date wording when useful.
If the user is only greeting, chatting, thanking, testing, or asking a timeless non-web question, set "search_needed": false and return no queries.

JSON shape:
{
  "search_needed": true,
  "intent": "fixture_lookup",
  "no_search_reason": "",
  "queries": [
    {"facet":"score_status","query":"...","reason":"..."}
  ]
}

Allowed facets: score_status, kickoff_time, venue, lineups_stats, competition_context, general.
Return at most ${maxQueries} queries.`;

  const userPrompt = `Question: ${question}

User time context:
- Time zone: ${context.timeZone}
- Local now: ${context.localNowLabel}
- Local date: ${context.localDateLabel}
- Previous local date: ${context.previousLocalDateLabel}
- UTC now: ${context.utcNow}
- Local day as UTC window: ${context.utcWindowLabel}

Plan search queries now.`;

  return { systemPrompt, userPrompt };
}

export function buildTemporalContext(
  now: Date,
  timeZone = DEFAULT_TIME_ZONE,
) {
  const localDate = formatDatePart(now, timeZone);
  const previous = shiftDateUtc(localDate, -1);
  const next = shiftDateUtc(localDate, 1);
  const startUtc = localDateBoundaryUtc(localDate, timeZone);
  const endUtc = localDateBoundaryUtc(next, timeZone);

  return {
    timeZone,
    localDate,
    localDateLabel: formatSearchDate(localDate),
    previousLocalDate: previous,
    previousLocalDateLabel: formatSearchDate(previous),
    localNowLabel: formatDateTime(now, timeZone),
    utcNow: now.toISOString(),
    utcWindowLabel: `${startUtc.toISOString()} to ${new Date(
      endUtc.getTime() - 1,
    ).toISOString()}`,
  };
}

function buildDeterministicQueries(
  question: string,
  context: ReturnType<typeof buildTemporalContext>,
  maxQueries: number,
): PlannedSearchQuery[] {
  const base = normalizeQuestionBase(question);
  const fixtureLike = isFixtureLike(question);
  const wantsScore = /\b(score|result|finished|full[- ]?time|ft|live)\b/i.test(
    question,
  );
  const wantsVenue = /\b(venue|stadium|where)\b/i.test(question);
  const wantsKickoff = /\b(kickoff|kick[- ]?off|ko|start time|when)\b/i.test(
    question,
  );

  const queries: PlannedSearchQuery[] = [];
  const add = (facet: SearchPlanFacet, query: string, reason: string) => {
    queries.push({ facet, query: cleanupQuery(query), reason });
  };

  if (fixtureLike || wantsScore) {
    add(
      "score_status",
      `${base} result today full time`,
      "Find final score or live status if the match has finished.",
    );
    add(
      "score_status",
      `${base} final score ${context.previousLocalDateLabel} ${context.localDateLabel}`,
      "Cover official UTC or previous-date fixture pages for late local matches.",
    );
  }

  if (fixtureLike || wantsKickoff) {
    add(
      "kickoff_time",
      `${base} kickoff time ${context.previousLocalDateLabel} ${context.localDateLabel}`,
      "Confirm kickoff time across local and UTC date wording.",
    );
  }

  if (fixtureLike || wantsVenue) {
    add(
      "venue",
      `${base} venue stadium ${context.previousLocalDateLabel} ${context.localDateLabel}`,
      "Find the stadium or match venue.",
    );
  }

  if (fixtureLike) {
    add(
      "lineups_stats",
      `${base} lineups match stats ${context.previousLocalDateLabel} ${context.localDateLabel}`,
      "Collect lineups and match-stat pages when available.",
    );
  }

  add("general", question, "Preserve the user's original wording.");

  const ordered = orderSafetyQueries(queries, {
    wantsScore,
    wantsVenue,
    wantsKickoff,
  });
  return dedupeQueries(ordered).slice(0, maxQueries);
}

function orderSafetyQueries(
  queries: PlannedSearchQuery[],
  intent: { wantsScore: boolean; wantsVenue: boolean; wantsKickoff: boolean },
) {
  const facetPriority: Record<SearchPlanFacet, number> = {
    score_status: intent.wantsScore ? 0 : 1,
    kickoff_time: intent.wantsKickoff ? 0 : 2,
    venue: intent.wantsVenue ? 0 : 3,
    lineups_stats: 4,
    competition_context: 5,
    general: 6,
  };
  return [...queries].sort(
    (a, b) => facetPriority[a.facet] - facetPriority[b.facet],
  );
}

type PlannerDecision = {
  searchNeeded: boolean;
  intent: string;
  noSearchReason?: string;
  queries: PlannedSearchQuery[];
};

async function callDeepSeekPlanner(input: {
  systemPrompt: string;
  userPrompt: string;
  question: string;
  context: ReturnType<typeof buildTemporalContext>;
  maxQueries: number;
}): Promise<string> {
  const client = getDeepSeekClient();
  const response = await logAiActivity(
    {
      system: "llm",
      provider: "deepseek-flash",
      endpoint: "search-query-planner",
      model: DEEPSEEK_MODEL,
      query: input.question.slice(0, 200),
      itemCount: input.maxQueries,
      request: {
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        timeZone: input.context.timeZone,
      },
      response: (raw: unknown) => {
        const choice = (raw as {
          choices?: Array<{ message?: { content?: string | null } }>;
        })?.choices?.[0];
        return { content: choice?.message?.content ?? "" };
      },
      metadata: {
        timeZone: input.context.timeZone,
        localDate: input.context.localDate,
        maxQueries: input.maxQueries,
      },
    },
    async () =>
      client.chat.completions.create({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: input.userPrompt },
        ],
        temperature: 0,
        max_tokens: 900,
        response_format: { type: "json_object" },
      }),
  );
  return response.choices[0]?.message?.content || "";
}

function parsePlannerDecision(
  raw: unknown,
  maxQueries: number,
): PlannerDecision {
  const value = parsePlannerJson(raw);
  const root = value && typeof value === "object" ? value : {};
  const record = root as Record<string, unknown>;
  const searchNeeded =
    typeof record.search_needed === "boolean"
      ? record.search_needed
      : typeof record.searchNeeded === "boolean"
        ? record.searchNeeded
        : true;
  const intent =
    typeof record.intent === "string" && record.intent.trim()
      ? record.intent.trim().slice(0, 80)
      : "unknown";
  const noSearchReason =
    typeof record.no_search_reason === "string"
      ? record.no_search_reason.slice(0, 160)
      : typeof record.noSearchReason === "string"
        ? record.noSearchReason.slice(0, 160)
        : undefined;
  const candidates = Array.isArray(root)
    ? root
    : Array.isArray(record.queries)
      ? record.queries
      : [];
  const out: PlannedSearchQuery[] = [];

  if (!searchNeeded) {
    return { searchNeeded, intent, noSearchReason, queries: [] };
  }

  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const query = typeof obj.query === "string" ? cleanupQuery(obj.query) : "";
    if (!query) continue;
    out.push({
      facet: normalizeFacet(obj.facet),
      query,
      reason:
        typeof obj.reason === "string"
          ? obj.reason.slice(0, 160)
          : "Planned by DeepSeek.",
    });
  }

  return {
    searchNeeded,
    intent,
    noSearchReason,
    queries: dedupeQueries(out).slice(0, maxQueries),
  };
}

function parsePlannerResponse(
  raw: unknown,
  maxQueries: number,
): PlannedSearchQuery[] {
  return parsePlannerDecision(raw, maxQueries).queries;
}

function parsePlannerJson(raw: unknown): unknown {
  if (typeof raw === "object" && raw !== null) return raw;
  const text = String(raw || "").trim();
  if (!text) return {};
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(stripped);
  } catch {
    const match = stripped.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!match) return {};
    try {
      return JSON.parse(match[0]);
    } catch {
      return {};
    }
  }
}

function mergePlannedQueries(
  llmQueries: PlannedSearchQuery[],
  safetyQueries: PlannedSearchQuery[],
  maxQueries: number,
): PlannedSearchQuery[] {
  const merged = dedupeQueries([...llmQueries, ...safetyQueries]);
  const hasFixtureSafety = safetyQueries.some((q) => q.facet === "score_status");
  if (!hasFixtureSafety) return merged.slice(0, maxQueries);

  const requiredFacets: SearchPlanFacet[] = [
    "score_status",
    "kickoff_time",
    "venue",
  ];
  const byFacet = new Map<SearchPlanFacet, PlannedSearchQuery[]>();
  for (const q of merged) {
    const list = byFacet.get(q.facet) ?? [];
    list.push(q);
    byFacet.set(q.facet, list);
  }

  const out: PlannedSearchQuery[] = [];
  const scoreSafety = safetyQueries.find(
    (q) => q.facet === "score_status" && /result today full time/i.test(q.query),
  );
  if (scoreSafety) out.push(scoreSafety);

  for (const facet of requiredFacets) {
    if (out.some((existing) => existing.facet === facet)) continue;
    const item = byFacet.get(facet)?.[0];
    if (item) out.push(item);
  }
  for (const q of merged) {
    if (out.some((existing) => sameQuery(existing.query, q.query))) continue;
    out.push(q);
    if (out.length >= maxQueries) break;
  }
  return out.slice(0, maxQueries);
}

function attachPlanMetadata(
  result: SearchResult,
  planned: PlannedSearchQuery,
  providerUsed: string,
  plan: SearchQueryPlan,
): PlannedSearchResult {
  return {
    ...result,
    facet: planned.facet,
    plannedQuery: planned.query,
    providerUsed,
    rankScore: scoreEvidence(result, planned, plan),
  };
}

function scoreEvidence(
  result: SearchResult,
  planned: PlannedSearchQuery,
  plan: SearchQueryPlan,
): number {
  const text = `${result.title} ${result.snippet} ${result.content ?? ""}`;
  const lower = text.toLowerCase();
  const host = hostname(result.url);
  let score = 0;

  if (planned.facet === "score_status") score += 18;
  if (planned.facet === "kickoff_time") score += 8;
  if (planned.facet === "venue") score += 6;

  if (/\b(full[- ]?time|match ends?|final score|ft\b|ended)\b/i.test(text)) {
    score += 45;
  }
  if (/\b\d+\s*[-,]\s*\d+\b/.test(text)) score += 18;
  if (/\b(live score|score updates|match summary)\b/i.test(text)) score += 10;
  if (text.includes(plan.localDateLabel)) score += 8;
  if (text.includes(plan.previousLocalDateLabel)) score += 10;
  if (/\b\d{1,2}:\d{2}\s*utc\b/i.test(text)) score += 6;

  const teamCoverage = scoreTeamCoverage(plan.originalQuery, text);
  score += teamCoverage;

  if (/(bbc\.com|espn\.com|sofascore\.com|flashscore\.com|fotmob\.com)/i.test(host)) {
    score += 10;
  }
  if (/(goal\.com|vavel\.com)/i.test(host)) score -= 5;
  if (/\b(predictions?|betting tips?|odds|watch|live stream|where to watch)\b/i.test(lower)) {
    score -= 18;
  }
  if (/\bschedule\b/i.test(lower) && teamCoverage < 20) score -= 25;
  if (/\b(2020|2021|2022|2023|2024|2025)\b/.test(lower)) score -= 20;
  if (mentionsWrongFixturePair(plan.originalQuery, text)) score -= 50;
  if (mentionsWrongOpponent(plan.originalQuery, text)) score -= 30;

  return score;
}

function rankPlannedResults(results: PlannedSearchResult[]) {
  return [...results].sort((a, b) => b.rankScore - a.rankScore);
}

function dedupePlannedResults(results: PlannedSearchResult[]) {
  const seen = new Map<string, PlannedSearchResult>();
  for (const result of results) {
    const key = (result.url || `${result.source}:${result.title}`)
      .replace(/\/$/, "")
      .toLowerCase();
    const existing = seen.get(key);
    if (!existing || result.rankScore > existing.rankScore) {
      seen.set(key, result);
    }
  }
  return [...seen.values()];
}

function dedupeQueries(queries: PlannedSearchQuery[]) {
  const seen = new Set<string>();
  const out: PlannedSearchQuery[] = [];
  for (const query of queries) {
    const key = query.query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(query);
  }
  return out;
}

function normalizeFacet(value: unknown): SearchPlanFacet {
  const facet = String(value || "").toLowerCase();
  if (
    facet === "score_status" ||
    facet === "kickoff_time" ||
    facet === "venue" ||
    facet === "lineups_stats" ||
    facet === "competition_context" ||
    facet === "general"
  ) {
    return facet;
  }
  return "general";
}

function normalizeQuestionBase(question: string) {
  return cleanupQuery(
    question
      .replace(/\?+$/g, "")
      .replace(/\b(today|tonight|tomorrow|yesterday|right now|latest)\b/gi, "")
      .replace(/\b(score|result|finished|full[- ]?time|venue|stadium|kickoff|kick[- ]?off|ko)\b/gi, ""),
  );
}

function cleanupQuery(query: string) {
  return query.replace(/\s+/g, " ").trim();
}

function sameQuery(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

function isFixtureLike(question: string) {
  return /\b(vs\.?|v\.?|versus)\b/i.test(question);
}

function deterministicNoSearchDecision(
  question: string,
): { intent: string; reason: string } | null {
  const normalized = question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return { intent: "empty", reason: "No user query was provided." };
  }

  if (
    /^(hi|hello|hey|yo|sup|salam|assalamu alaikum|thanks|thank you|ok|okay|test|testing)$/.test(
      normalized,
    )
  ) {
    return {
      intent: "small_talk",
      reason: "Greeting or small-talk does not need web grounding.",
    };
  }

  if (
    /^(how are you|what's up|whats up|good morning|good afternoon|good evening)$/.test(
      normalized,
    )
  ) {
    return {
      intent: "small_talk",
      reason: "Conversational opener does not need web grounding.",
    };
  }

  return null;
}

function clampQueryCount(value: unknown) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MAX_QUERIES;
  return Math.max(1, Math.min(DEFAULT_MAX_QUERIES, Math.floor(n)));
}

function stringifyRawPlannerResponse(raw: unknown) {
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function mentionsWrongOpponent(originalQuery: string, text: string) {
  const teams = extractFixtureTeams(originalQuery);
  if (!teams) return false;
  const home = simplifyTeamName(teams.home);
  const away = simplifyTeamName(teams.away);
  const haystack = simplifyTeamName(text);
  if (!home || !away) return false;
  const mentionsHome = haystack.includes(home);
  const mentionsAway = haystack.includes(away);
  return mentionsHome && !mentionsAway && /\bvs\b|\bv\b|versus/i.test(text);
}

function mentionsWrongFixturePair(originalQuery: string, text: string) {
  const teams = extractFixtureTeams(originalQuery);
  if (!teams) return false;
  const home = simplifyTeamName(teams.home);
  const away = simplifyTeamName(teams.away);
  const awayAliases =
    away === "inter milan" ? ["inter milan", "internazionale", "inter"] : [away];
  const simplified = simplifyTeamName(text);
  const vsMatches = simplified.matchAll(
    /\b([a-z0-9 ]{2,40})\s+(?:vs|v|versus)\s+([a-z0-9 ]{2,40})\b/g,
  );

  for (const match of vsMatches) {
    const left = match[1].trim();
    const right = match[2].trim();
    const leftHasHome = left.includes(home);
    const rightHasHome = right.includes(home);
    const leftHasAway = awayAliases.some((alias) => left.includes(alias));
    const rightHasAway = awayAliases.some((alias) => right.includes(alias));
    const correctPair =
      (leftHasHome && rightHasAway) || (leftHasAway && rightHasHome);
    const mentionsOneTarget =
      leftHasHome || rightHasHome || leftHasAway || rightHasAway;
    if (mentionsOneTarget && !correctPair) return true;
  }

  return false;
}

function simplifyTeamName(value: string) {
  return value
    .toLowerCase()
    .replace(/\b(today|tonight|tomorrow|yesterday|score|result|full time|venue|stadium|kickoff|ko)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function scoreTeamCoverage(originalQuery: string, text: string) {
  const teams = extractFixtureTeams(originalQuery);
  if (!teams) return 0;
  const haystack = simplifyTeamName(text);
  const home = simplifyTeamName(teams.home);
  const away = simplifyTeamName(teams.away);
  const awayAliases =
    away === "inter milan" ? ["inter milan", "internazionale"] : [away];
  const mentionsHome = home ? haystack.includes(home) : false;
  const mentionsAway = awayAliases.some((alias) => haystack.includes(alias));
  if (mentionsHome && mentionsAway) return 20;
  if (mentionsHome || mentionsAway) return -15;
  return -35;
}

function extractFixtureTeams(question: string) {
  const match = question.match(/(.+?)\s+\b(?:vs\.?|v\.?|versus)\b\s+(.+)/i);
  if (!match) return null;
  return {
    home: stripIntentWords(match[1]),
    away: stripIntentWords(match[2]),
  };
}

function stripIntentWords(value: string) {
  return value.replace(
    /\b(today|tonight|tomorrow|yesterday|score|result|full time|venue|stadium|kickoff|ko|latest|now)\b/gi,
    "",
  );
}

function formatDatePart(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function formatDateTime(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(date);
}

function formatSearchDate(isoDate: string) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function shiftDateUtc(isoDate: string, days: number) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function localDateBoundaryUtc(isoDate: string, timeZone: string) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const utcGuess = new Date(Date.UTC(year, month - 1, day));
  const localAtGuess = formatDatePart(utcGuess, timeZone);
  const diffDays = dateDiffDays(localAtGuess, isoDate);
  const adjusted = new Date(utcGuess.getTime() + diffDays * 86_400_000);
  const localHour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      hour12: false,
    }).format(adjusted),
  );
  return new Date(adjusted.getTime() - localHour * 3_600_000);
}

function dateDiffDays(a: string, b: string) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000,
  );
}

export const __queryPlannerTestHooks = {
  buildDeterministicQueries,
  buildTemporalContext,
  deterministicNoSearchDecision,
  parsePlannerDecision,
  parsePlannerResponse,
  scoreEvidence,
};
