/**
 * Grounding engine — search-grounded inference orchestrator.
 *
 * Combines SearchRouter (Vertex/Brave) with DeepSeek (primary) or
 * Gemini to produce verdicts backed by web evidence.
 * Ported from services/ai-search/app/grounding.py.
 */

import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import type {
  EventInfo,
  MatchVerdict,
  MatchCanonicalEvent,
  BatchMatchVerdict,
  GroundedAnswer,
  SearchResult,
  SourceCitation,
  PairVerdict,
  MatchDecision,
  AiParseDiagnostics,
  EvidenceAssessment,
  SourceBackedAliasEvidence,
} from "./search/types";
import {
  ENTITY_MATCH_SYSTEM,
  ENTITY_MATCH_BATCH_SYSTEM,
  buildGenericSystem,
  entityMatchPrompt,
  entityMatchBatchPrompt,
  genericQueryPrompt,
} from "./prompts";
import { getSearchRouter, type SearchRouter } from "./search/router";
import { logAiActivity } from "./activity-logger";
import { bestSim } from "../matching/string-sim";
import { normalize, normalizeCompetition } from "../matching/normalize";
import { isValid, parseISO } from "date-fns";

// DeepSeek v4 currently supports up to 384K output tokens. Keep the app from
// imposing small local caps; prompt shape + JSON parsing define the response.
const DEEPSEEK_MAX_OUTPUT_TOKENS = 384_000;
const ENTITY_MATCH_QUERY_LIMIT = 10;
const ENTITY_MATCH_RESULTS_PER_QUERY = 4;
const ENTITY_MATCH_EVIDENCE_ITEMS = 12;
const ENTITY_MATCH_EVIDENCE_CHARS = 560;
const ENTITY_MATCH_MIN_EVIDENCE_RESULTS = 4;
const ENTITY_MATCH_MIN_EVIDENCE_CHARS = 1_200;

type MatchSide = SourceBackedAliasEvidence["side"];

function getDeepSeekClient(): OpenAI {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not configured");
  return new OpenAI({ baseURL: "https://api.deepseek.com", apiKey });
}

function getDeepSeekModel(): string {
  return process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
}

let _geminiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  if (!_geminiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not configured");
    _geminiClient = new GoogleGenAI({ apiKey });
  }
  return _geminiClient;
}

function getGeminiModel(tier?: string): string {
  if (tier === "pro") return process.env.GEMINI_PRO_MODEL || "gemini-3.1-pro";
  if (tier === "lite")
    return process.env.GEMINI_LITE_MODEL || "gemini-3.1-flash-lite";
  return process.env.GEMINI_FLASH_MODEL || "gemini-3-flash";
}

function getGroundingDates(iso: string) {
  try {
    const d = parseISO(iso);
    if (isValid(d)) {
      const utcParts = datePartsInTimeZone(d, "UTC");
      return {
        date: utcParts.date,
        time: utcParts.time,
      };
    }
  } catch {}
  const fallback = iso.length >= 10 ? iso.slice(0, 10) : "";
  const timeFallback = iso.length >= 16 ? iso.slice(11, 16) : "";
  return {
    date: fallback,
    time: timeFallback,
  };
}

function datePartsInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return {
    date: `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`,
    time: `${byType.get("hour")}:${byType.get("minute")}`,
  };
}

function textForAliasMatch(value: string): string {
  let out = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\bhcmc\b/g, "ho chi minh city")
    .replace(/\bhcm\b/g, "ho chi minh")
    .replace(/\btp hcm\b/g, "ho chi minh city")
    .replace(/\btp ho chi minh\b/g, "ho chi minh city")
    .replace(/\s+/g, " ")
    .trim();
  out = out.replace(/\b(fc|cf|sc|club)\b/g, "").replace(/\s+/g, " ").trim();
  return out;
}

function aliasSurfaceVariants(surface: string): string[] {
  const base = textForAliasMatch(surface);
  const variants = new Set([base]);
  if (base.includes("ho chi minh city")) {
    variants.add(base.replace(/\bho chi minh city\b/g, "hcmc"));
  }
  if (base.includes("hcmc")) {
    variants.add(base.replace(/\bhcmc\b/g, "ho chi minh city"));
  }
  return [...variants].filter(Boolean);
}

function containsAliasSurface(text: string, variants: string[]): boolean {
  const normalizedText = ` ${textForAliasMatch(text)} `;
  return variants.some((variant) => normalizedText.includes(` ${variant} `));
}

function sourceLooksLikeOppositionFixture(
  result: SearchResult,
  aVariants: string[],
  bVariants: string[],
): boolean {
  const title = textForAliasMatch(result.title);
  const url = textForAliasMatch(decodeURIComponent(result.url));
  const haystacks = [title, url];
  return haystacks.some((haystack) => {
    const hasA = aVariants.some((variant) => haystack.includes(variant));
    const hasB = bVariants.some((variant) => haystack.includes(variant));
    return hasA && hasB && /\b(vs?|versus|x)\b/.test(haystack);
  });
}

function sourceBacksAlias(
  result: SearchResult,
  eventASurface: string,
  eventBSurface: string,
): boolean {
  const aVariants = aliasSurfaceVariants(eventASurface);
  const bVariants = aliasSurfaceVariants(eventBSurface);
  if (sourceLooksLikeOppositionFixture(result, aVariants, bVariants)) {
    return false;
  }

  const url = decodeURIComponent(result.url);
  const title = result.title;
  const aInUrl = containsAliasSurface(url, aVariants);
  const bInUrl = containsAliasSurface(url, bVariants);
  const aInTitle = containsAliasSurface(title, aVariants);
  const bInTitle = containsAliasSurface(title, bVariants);

  return (aInUrl && bInTitle) || (bInUrl && aInTitle);
}

function extractAliasEvidenceForSide(
  side: MatchSide,
  eventASurface: string,
  eventBSurface: string,
  evidence: SearchResult[],
): SourceBackedAliasEvidence[] {
  if (textForAliasMatch(eventASurface) === textForAliasMatch(eventBSurface)) {
    return [];
  }

  const matches: SourceBackedAliasEvidence[] = [];
  const seen = new Set<string>();
  for (const result of evidence) {
    if (!sourceBacksAlias(result, eventASurface, eventBSurface)) continue;
    const key = `${side}|${result.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({
      side,
      eventASurface,
      eventBSurface,
      canonicalSurface: result.title,
      sourceTitle: result.title,
      sourceUrl: result.url,
      reason:
        "Source URL slug contains one provider label while the page title uses the other label.",
    });
  }
  return matches;
}

function extractSourceBackedAliasEvidence(
  eventA: EventInfo,
  eventB: EventInfo,
  evidence: SearchResult[],
): SourceBackedAliasEvidence[] {
  return [
    ...extractAliasEvidenceForSide(
      "home",
      eventA.homeTeam,
      eventB.homeTeam,
      evidence,
    ),
    ...extractAliasEvidenceForSide(
      "away",
      eventA.awayTeam,
      eventB.awayTeam,
      evidence,
    ),
  ];
}

function formatAliasEvidence(
  aliasEvidence: SourceBackedAliasEvidence[],
): string {
  if (aliasEvidence.length === 0) return "";
  return aliasEvidence
    .map(
      (e, index) =>
        `[A${index + 1}] ${e.side.toUpperCase()} alias: "${e.eventASurface}" ~= "${e.eventBSurface}"\n` +
        `    Source: ${e.sourceTitle}\n` +
        `    URL: ${e.sourceUrl}\n` +
        `    Reason: ${e.reason}`,
    )
    .join("\n\n");
}

export function buildMatchQueries(
  eventA: EventInfo,
  eventB: EventInfo,
): string[] {
  const queries: string[] = [];
  const { date, time } = getGroundingDates(eventA.startTime);
  const displayPairA = `${eventA.homeTeam} ${eventA.awayTeam}`;
  const displayPairB = `${eventB.homeTeam} ${eventB.awayTeam}`;
  const normalizedPairA = [
    eventA.normalized?.homeTeam,
    eventA.normalized?.awayTeam,
  ]
    .filter(Boolean)
    .join(" ");
  const normalizedPairB = [
    eventB.normalized?.homeTeam,
    eventB.normalized?.awayTeam,
  ]
    .filter(Boolean)
    .join(" ");

  queries.push(
    `${displayPairA} ${date} ${eventA.competition} football fixture`,
    `${displayPairB} ${date} ${eventB.competition} football fixture`,
    `${displayPairA} ${displayPairB} ${date} same football match`,
  );

  if (normalizedPairA && normalizedPairA !== displayPairA.toLowerCase()) {
    queries.push(`${normalizedPairA} ${date} ${eventA.competition} fixture`);
  }

  if (normalizedPairB && normalizedPairB !== displayPairB.toLowerCase()) {
    queries.push(`${normalizedPairB} ${date} ${eventB.competition} fixture`);
  }

  if (eventA.homeTeam.toLowerCase() !== eventB.homeTeam.toLowerCase()) {
    queries.push(
      `Is "${eventA.homeTeam}" the same football team as "${eventB.homeTeam}"? ${eventA.competition} ${eventB.competition}`,
    );
  }

  if (eventA.awayTeam.toLowerCase() !== eventB.awayTeam.toLowerCase()) {
    queries.push(
      `Is "${eventA.awayTeam}" the same football team as "${eventB.awayTeam}"? ${eventA.competition} ${eventB.competition}`,
    );
  }

  if (eventA.competition.toLowerCase() !== eventB.competition.toLowerCase()) {
    queries.push(
      `"${eventA.competition}" "${eventB.competition}" same football league tournament country tier`,
    );
  }

  queries.push(
    `"${eventA.homeTeam}" vs "${eventA.awayTeam}" "${eventB.homeTeam}" vs "${eventB.awayTeam}" ${date} ${time} UTC football match`,
    `"${eventA.homeTeam}" "${eventA.awayTeam}" ${date} site:espn.com/soccer`,
    `"${eventA.homeTeam}" "${eventA.awayTeam}" ${date} site:sofascore.com`,
    `"${eventB.homeTeam}" "${eventB.awayTeam}" ${date} site:flashscore.com`,
  );

  return uniqueStrings(queries);
}

export function buildBatchMatchQueries(
  pairs: Array<{ eventA: EventInfo; eventB: EventInfo }>,
): string[] {
  const names = new Set<string>();
  const comps = new Set<string>();
  const dates = new Set<string>();

  for (const { eventA, eventB } of pairs) {
    names.add(eventA.homeTeam);
    names.add(eventA.awayTeam);
    names.add(eventB.homeTeam);
    names.add(eventB.awayTeam);
    if (eventA.competition !== eventB.competition) {
      comps.add(eventA.competition);
      comps.add(eventB.competition);
    }
    const datesA = getGroundingDates(eventA.startTime);
    if (datesA.date) dates.add(datesA.date);

    const datesB = getGroundingDates(eventB.startTime);
    if (datesB.date) dates.add(datesB.date);
  }

  const queries: string[] = [];
  const nameList = [...names].slice(0, 8).join(", ");
  const dateList = [...dates].slice(0, 4).join(" ");
  if (nameList) {
    queries.push(
      `football teams official names league affiliations ${dateList}: ${nameList}`,
    );
  }
  const compList = [...comps].slice(0, 4).join(", ");
  if (compList) {
    queries.push(`football leagues full names country tier: ${compList}`);
  }

  return queries;
}

function buildMatchDrilldownQueries(
  eventA: EventInfo,
  eventB: EventInfo,
): string[] {
  const { date, time } = getGroundingDates(eventA.startTime);
  return uniqueStrings([
    `"${eventA.homeTeam}" "${eventA.awayTeam}" "${date}" "${time}" UTC official fixture`,
    `"${eventB.homeTeam}" "${eventB.awayTeam}" "${date}" "${time}" UTC official fixture`,
    `"${eventA.homeTeam}" "${eventA.awayTeam}" "${eventA.competition}" "${date}" score`,
    `"${eventB.homeTeam}" "${eventB.awayTeam}" "${eventB.competition}" "${date}" score`,
    `"${eventA.homeTeam}" "${eventA.awayTeam}" "${eventB.homeTeam}" "${eventB.awayTeam}" "${date}" same match`,
  ]);
}

function compactEventInfo(event: EventInfo) {
  return {
    homeTeam: event.homeTeam,
    awayTeam: event.awayTeam,
    competition: event.competition,
    startTime: event.startTime,
    provider: event.provider,
  };
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value.replace(/\s+/g, " ").trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    unique.push(trimmed);
  }
  return unique;
}

function evidenceQuality(results: SearchResult[]): {
  strong: boolean;
  resultCount: number;
  contentChars: number;
} {
  const unique = uniqueSearchResults(results);
  const contentChars = unique.reduce(
    (sum, r) => sum + searchResultText(r).trim().length,
    0,
  );
  return {
    strong:
      unique.length >= ENTITY_MATCH_MIN_EVIDENCE_RESULTS &&
      contentChars >= ENTITY_MATCH_MIN_EVIDENCE_CHARS,
    resultCount: unique.length,
    contentChars,
  };
}

function searchResultText(r: SearchResult): string {
  return r.content || r.snippet || "";
}

function fullSearchResults(results: SearchResult[]) {
  return uniqueSearchResults(results).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.snippet,
    content: searchResultText(r),
    source: r.source,
    score: r.score ?? null,
  }));
}

function compactChatResponse(resp: unknown) {
  const choice = (
    resp as {
      choices?: Array<{
        finish_reason?: string;
        message?: { content?: string | null };
      }>;
    }
  )?.choices?.[0];
  const content = choice?.message?.content ?? "";
  const r = resp as {
    id?: string;
    model?: string;
    usage?: unknown;
  };
  return {
    id: r.id,
    model: r.model,
    finishReason: choice?.finish_reason,
    truncated: choice?.finish_reason === "length",
    content,
    contentChars: content.length,
    usage: r.usage ?? null,
  };
}

class GroundingEngine {
  private search: SearchRouter;

  constructor() {
    this.search = getSearchRouter();
  }

  // ── Entity matching (single) ───────────────────────────────────────

  async matchSingle(
    eventA: EventInfo,
    eventB: EventInfo,
  ): Promise<MatchVerdict> {
    const queries = buildMatchQueries(eventA, eventB);
    const allEvidence: SearchResult[] = [];
    const queriesUsed: string[] = [];
    const searchProvidersUsed: string[] = [];
    let searchFailureCount = 0;

    for (const q of queries.slice(0, ENTITY_MATCH_QUERY_LIMIT)) {
      const { results, provider } = await this.search.search(
        q,
        ENTITY_MATCH_RESULTS_PER_QUERY,
      );
      allEvidence.push(...results);
      queriesUsed.push(q);
      searchProvidersUsed.push(provider);
      if (provider === "none" || results.length === 0) {
        searchFailureCount++;
      }
    }

    const initialEvidenceQuality = evidenceQuality(allEvidence);
    if (!initialEvidenceQuality.strong) {
      for (const q of buildMatchDrilldownQueries(eventA, eventB).slice(0, 3)) {
        if (queriesUsed.includes(q)) continue;
        const { results, provider } = await this.search.fanOutSearch(q, 3, 2);
        allEvidence.push(...results);
        queriesUsed.push(q);
        searchProvidersUsed.push(provider);
        if (provider === "none" || results.length === 0) {
          searchFailureCount++;
        }
      }
    }
    const finalEvidenceQuality = evidenceQuality(allEvidence);
    const aliasEvidence = extractSourceBackedAliasEvidence(
      eventA,
      eventB,
      allEvidence,
    );

    const evidenceText = formatEvidence(
      allEvidence,
      ENTITY_MATCH_EVIDENCE_ITEMS,
      ENTITY_MATCH_EVIDENCE_CHARS,
    );
    let prompt = entityMatchPrompt(
      {
        homeTeam: eventA.homeTeam,
        awayTeam: eventA.awayTeam,
        competition: eventA.competition,
        startTime: eventA.startTime,
        provider: eventA.provider,
        normalized: eventA.normalized,
        providerMetadata: eventA.providerMetadata,
        matcherContext: eventA.matcherContext,
      },
      {
        homeTeam: eventB.homeTeam,
        awayTeam: eventB.awayTeam,
        competition: eventB.competition,
        startTime: eventB.startTime,
        provider: eventB.provider,
        normalized: eventB.normalized,
        providerMetadata: eventB.providerMetadata,
        matcherContext: eventB.matcherContext,
      },
    );
    const aliasEvidenceText = formatAliasEvidence(aliasEvidence);
    if (aliasEvidenceText) {
      prompt += `\n\nSOURCE-BACKED ALIAS EVIDENCE:\n${aliasEvidenceText}\n\nTreat source-backed alias evidence as stronger than raw provider label differences. If alias evidence covers a team slot, do not classify that slot as a different club solely because the provider labels differ.`;
    }
    if (evidenceText) {
      prompt += `\n\nWEB SEARCH EVIDENCE:\n${evidenceText}`;
    }

    const llm = getDeepSeekClient();
    const model = getDeepSeekModel();

    let raw = "";
    const resp = await logAiActivity(
      {
        system: "llm",
        provider: "deepseek-flash",
        endpoint: "entity-match",
        model,
        query: `${eventA.homeTeam} vs ${eventA.awayTeam} ↔ ${eventB.homeTeam} vs ${eventB.awayTeam}`,
        itemCount: 1,
        request: {
          systemPrompt: ENTITY_MATCH_SYSTEM,
          userPrompt: prompt,
          eventA: compactEventInfo(eventA),
          eventB: compactEventInfo(eventB),
          searchQueriesUsed: queriesUsed,
          searchProvidersUsed,
          searchFailureCount,
          evidence: fullSearchResults(allEvidence),
          aliasEvidence,
          evidenceText,
        },
        response: compactChatResponse,
        metadata: {
          promptLength: prompt.length,
          searchQueryCount: queriesUsed.length,
          searchFailureCount,
          evidenceCount: allEvidence.length,
          uniqueEvidenceCount: uniqueSearchResults(allEvidence).length,
          initialEvidenceQuality,
          finalEvidenceQuality,
          evidenceTextLength: evidenceText.length,
          aliasEvidenceCount: aliasEvidence.length,
        },
      },
      async () => {
        const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming =
          {
            model,
            messages: [
              { role: "system", content: ENTITY_MATCH_SYSTEM },
              { role: "user", content: prompt },
            ],
            temperature: 0,
            max_tokens: DEEPSEEK_MAX_OUTPUT_TOKENS,
            response_format: { type: "json_object" },
          };
        const r = await llm.chat.completions.create(params);
        raw = r.choices[0]?.message?.content || "{}";
        return r;
      },
    );

    raw = resp.choices[0]?.message?.content || "{}";
    const finishReason = resp.choices[0]?.finish_reason;
    return this._parseMatchVerdict(
      raw,
      model,
      allEvidence,
      queriesUsed,
      eventA,
      eventB,
      finishReason,
      {
        searchFailureCount,
        searchQueryCount: queriesUsed.length,
        searchProvidersUsed,
      },
    );
  }

  // ── Entity matching (batch) ────────────────────────────────────────

  async matchBatch(
    pairs: Array<{ eventA: EventInfo; eventB: EventInfo }>,
  ): Promise<BatchMatchVerdict> {
    if (pairs.length === 0) {
      return { verdicts: [], sources: [], searchQueriesUsed: [], model: "" };
    }

    const indexedPairs = pairs.map((p, i) => ({
      index: i + 1,
      eventA: {
        homeTeam: p.eventA.homeTeam,
        awayTeam: p.eventA.awayTeam,
        competition: p.eventA.competition,
        startTime: p.eventA.startTime,
        provider: p.eventA.provider,
      },
      eventB: {
        homeTeam: p.eventB.homeTeam,
        awayTeam: p.eventB.awayTeam,
        competition: p.eventB.competition,
        startTime: p.eventB.startTime,
        provider: p.eventB.provider,
      },
    }));

    const queries = buildBatchMatchQueries(pairs);
    const allEvidence: SearchResult[] = [];
    const queriesUsed: string[] = [];

    for (const q of queries.slice(0, 6)) {
      const { results } = await this.search.search(q, 3);
      allEvidence.push(...results);
      queriesUsed.push(q);
    }

    const evidenceText = formatEvidence(
      allEvidence,
      ENTITY_MATCH_EVIDENCE_ITEMS,
      ENTITY_MATCH_EVIDENCE_CHARS,
    );
    let prompt = entityMatchBatchPrompt(indexedPairs);
    if (evidenceText) {
      prompt += `\n\nWEB SEARCH EVIDENCE:\n${evidenceText}`;
    }

    const llm = getDeepSeekClient();
    const model = getDeepSeekModel();

    let rawBatch = "";
    const resp = await logAiActivity(
      {
        system: "llm",
        provider: "deepseek-flash",
        endpoint: "entity-match",
        model,
        query: `${pairs.length} entity-match pairs`,
        itemCount: pairs.length,
        request: {
          systemPrompt: ENTITY_MATCH_BATCH_SYSTEM,
          userPrompt: prompt,
          pairCount: pairs.length,
          pairs: pairs.slice(0, 20).map((p) => ({
            eventA: compactEventInfo(p.eventA),
            eventB: compactEventInfo(p.eventB),
          })),
          searchQueriesUsed: queriesUsed,
          evidence: fullSearchResults(allEvidence),
          evidenceText,
        },
        response: compactChatResponse,
        metadata: {
          promptLength: prompt.length,
          searchQueryCount: queriesUsed.length,
          evidenceCount: allEvidence.length,
          evidenceTextLength: evidenceText.length,
        },
      },
      async () => {
        const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming =
          {
            model,
            messages: [
              { role: "system", content: ENTITY_MATCH_BATCH_SYSTEM },
              { role: "user", content: prompt },
            ],
            temperature: 0,
            max_tokens: DEEPSEEK_MAX_OUTPUT_TOKENS,
            response_format: { type: "json_object" },
          };
        const r = await llm.chat.completions.create(params);
        rawBatch = r.choices[0]?.message?.content || "[]";
        return r;
      },
    );

    rawBatch = resp.choices[0]?.message?.content || "[]";
    const finishReason = resp.choices[0]?.finish_reason;
    return this._parseBatchVerdict(
      rawBatch,
      model,
      pairs.length,
      allEvidence,
      queriesUsed,
      finishReason,
    );
  }

  // ── Generic grounded query ─────────────────────────────────────────

  async query(
    question: string,
    context?: Record<string, unknown>,
    opts?: {
      provider?: "deepseek" | "gemini";
      model?: string;
      searchQuery?: string;
      searchProviders?: string[];
      /**
       * When true, skip the engine's internal web search and use only the
       * `context.web_search_results` array (if present) as evidence.
       * The Playground sets this so it can show the user the same sources
       * the LLM is citing, without doubling search calls.
       */
      skipSearch?: boolean;
    },
  ): Promise<GroundedAnswer> {
    const provider = opts?.provider || "deepseek";
    const skipSearch = opts?.skipSearch === true;

    // Pull caller-supplied results (from /api/ai-search/search step) first.
    const callerResults = extractResults(context);

    // Run internal search only when the caller didn't already provide
    // evidence and didn't explicitly opt out.
    let internalResults: SearchResult[] = [];
    if (!skipSearch && callerResults.length === 0) {
      const r = await this.search.search(
        opts?.searchQuery ?? question,
        8,
        opts?.searchProviders,
      );
      internalResults = r.results;
    }

    const evidence = callerResults.length > 0 ? callerResults : internalResults;
    const evidenceText = formatEvidence(evidence);
    const sources = resultsToCitations(evidence);

    // Strip web_search_results from the leftover context — they're already
    // formatted as numbered evidence below. Pass the rest (if any) for
    // additional caller-supplied hints.
    const sideContext = stripWebResults(context);
    const sideContextStr =
      sideContext && Object.keys(sideContext).length > 0
        ? JSON.stringify(sideContext)
        : undefined;

    let prompt = genericQueryPrompt(question, sideContextStr);
    if (evidenceText) {
      prompt += `\n\nWEB SEARCH EVIDENCE (cite as [N]):\n${evidenceText}`;
    } else {
      prompt += `\n\n(No web search evidence available — answer from general knowledge and clearly note the limitation.)`;
    }

    const systemPrompt = buildGenericSystem(new Date());

    if (provider === "gemini") {
      const client = getGeminiClient();
      const modelId = opts?.model || getGeminiModel();

      const resp = await logAiActivity(
        {
          system: "llm",
          provider: "gemini-lite",
          endpoint: "grounded-query",
          model: modelId,
          query: question.slice(0, 200),
          itemCount: 1,
          request: {
            systemPrompt,
            userPrompt: prompt,
            question,
            evidence: fullSearchResults(evidence),
            evidenceText,
          },
          response: (r: unknown) => ({
            text:
              typeof r === "object" && r !== null && "text" in r
                ? (r as { text?: string }).text
                : "",
          }),
          metadata: {
            promptLength: prompt.length,
            evidenceCount: evidence.length,
            evidenceTextLength: evidenceText.length,
            provider,
          },
        },
        async () => {
          const r = await client.models.generateContent({
            model: modelId,
            contents: [
              {
                role: "user",
                parts: [{ text: `${systemPrompt}\n\n${prompt}` }],
              },
            ],
          });
          return r;
        },
      );
      const raw = resp.text || "";

      try {
        const data = JSON.parse(raw) as { answer?: string; reasoning?: string };
        return {
          answer: data.answer || raw,
          reasoning: data.reasoning || "",
          sources,
          model: modelId,
        };
      } catch {
        return { answer: raw, reasoning: "", sources, model: modelId };
      }
    }

    const llm = getDeepSeekClient();
    const model = opts?.model || getDeepSeekModel();

    const resp = await logAiActivity(
      {
        system: "llm",
        provider: "deepseek-flash",
        endpoint: "grounded-query",
        model,
        query: question.slice(0, 200),
        itemCount: 1,
        request: {
          systemPrompt,
          userPrompt: prompt,
          question,
          evidence: fullSearchResults(evidence),
          evidenceText,
        },
        response: compactChatResponse,
        metadata: {
          promptLength: prompt.length,
          evidenceCount: evidence.length,
          evidenceTextLength: evidenceText.length,
          provider,
        },
      },
      async () => {
        const r = await llm.chat.completions.create({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
          temperature: 0,
          max_tokens: DEEPSEEK_MAX_OUTPUT_TOKENS,
          response_format: { type: "json_object" },
        });
        return r;
      },
    );

    const raw = resp.choices[0]?.message?.content || "{}";

    try {
      const data = JSON.parse(raw) as { answer?: string; reasoning?: string };
      const answer = (data.answer || "").trim();
      // If the JSON parsed but answer is empty (e.g. truncated), surface raw.
      if (!answer) {
        return { answer: raw, reasoning: data.reasoning || "", sources, model };
      }
      return { answer, reasoning: data.reasoning || "", sources, model };
    } catch {
      return { answer: raw, reasoning: "", sources, model };
    }
  }

  // ── Stats ──────────────────────────────────────────────────────────

  getStats() {
    return this.search.getStats();
  }

  toggleProvider(name: string, enabled: boolean): boolean {
    this.search.toggleProvider(name, enabled).catch((err) => {
      console.warn(`toggleProvider failed for ${name}:`, err);
    });
    return enabled;
  }

  // ── Query builders ─────────────────────────────────────────────────

  // ── JSON parsers ───────────────────────────────────────────────────

  private _parseMatchVerdict(
    raw: string,
    model: string,
    evidence: SearchResult[],
    queriesUsed: string[],
    eventA: EventInfo,
    eventB: EventInfo,
    finishReason?: string,
    searchDiagnostics?: SearchDiagnostics,
  ): MatchVerdict {
    return parseMatchVerdictFromRaw({
      raw,
      model,
      evidence,
      queriesUsed,
      eventA,
      eventB,
      finishReason,
      searchDiagnostics,
    });
  }

  private _parseBatchVerdict(
    raw: string,
    model: string,
    pairCount: number,
    evidence: SearchResult[],
    queriesUsed: string[],
    finishReason?: string,
  ): BatchMatchVerdict {
    return parseBatchVerdictFromRaw({
      raw,
      model,
      pairCount,
      evidence,
      queriesUsed,
      finishReason,
    });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function heuristicMatchVerdict(
  eventA: EventInfo,
  eventB: EventInfo,
): {
  decision: MatchVerdict["decision"];
  confidence: number;
  reasoning: string;
} | null {
  const startA = Date.parse(eventA.startTime);
  const startB = Date.parse(eventB.startTime);
  const timeDiffMs =
    Number.isFinite(startA) && Number.isFinite(startB)
      ? Math.abs(startA - startB)
      : Number.POSITIVE_INFINITY;
  const timeClose = timeDiffMs <= 15 * 60 * 1000;
  const timeFar = timeDiffMs > 2 * 60 * 60 * 1000;

  const homeHome = bestSim(
    normalize(eventA.homeTeam),
    normalize(eventB.homeTeam),
  );
  const awayAway = bestSim(
    normalize(eventA.awayTeam),
    normalize(eventB.awayTeam),
  );
  const homeAway = bestSim(
    normalize(eventA.homeTeam),
    normalize(eventB.awayTeam),
  );
  const awayHome = bestSim(
    normalize(eventA.awayTeam),
    normalize(eventB.homeTeam),
  );
  const sameOrientation = (homeHome + awayAway) / 2;
  const swappedOrientation = (homeAway + awayHome) / 2;
  const bestTeamScore = Math.max(sameOrientation, swappedOrientation);
  const compScore = bestSim(
    normalizeCompetition(eventA.competition),
    normalizeCompetition(eventB.competition),
  );

  if (timeClose && sameOrientation >= 0.82 && compScore >= 0.45) {
    return {
      decision: "SAME",
      confidence: Math.max(72, Math.min(95, Math.round(sameOrientation * 100))),
      reasoning:
        "Deterministic fallback: team-name variants, kickoff, and competition context align.",
    };
  }

  if (timeClose && swappedOrientation >= 0.88 && compScore >= 0.55) {
    return {
      decision: "SAME",
      confidence: Math.max(
        70,
        Math.min(90, Math.round(swappedOrientation * 100)),
      ),
      reasoning:
        "Deterministic fallback: teams align under swapped display order at the same kickoff.",
    };
  }

  if (timeFar && bestTeamScore < 0.75) {
    return {
      decision: "DIFFERENT",
      confidence: 90,
      reasoning:
        "Deterministic fallback: kickoff times are more than two hours apart and teams do not align.",
    };
  }

  if (timeClose && bestTeamScore <= 0.48 && compScore < 0.8) {
    return {
      decision: "DIFFERENT",
      confidence: 88,
      reasoning:
        "Deterministic fallback: same kickoff window but both team names differ strongly.",
    };
  }

  return null;
}

function parseMatchVerdictFromRaw(input: {
  raw: string;
  model: string;
  evidence: SearchResult[];
  queriesUsed: string[];
  eventA: EventInfo;
  eventB: EventInfo;
  finishReason?: string;
  searchDiagnostics?: SearchDiagnostics;
}): MatchVerdict {
  const parsed = parseJsonValue(input.raw, input.finishReason);
  const data = objectFromJsonValue(parsed.value) ?? {};
  const decisionValue =
    data?.decision ??
    data?.verdict ??
    data?.answer ??
    data?.match ??
    data?.same_match ??
    data?.is_same_match;
  const decision = normalizeDecision(decisionValue);
  const confidence = clampConfidence(
    data?.confidence ??
      data?.confidence_score ??
      data?.confidenceScore ??
      data?.score,
  );
  const reasoning =
    (data?.reasoning as string) ||
    (data?.explanation as string) ||
    (data?.rationale as string) ||
    parsed.warning ||
    "";
  const confirmedFacts = stringArrayFromJsonValue(
    data?.confirmedFacts ?? data?.confirmed_facts ?? data?.facts,
  );
  const uncertainties = stringArrayFromJsonValue(
    data?.uncertainties ?? data?.uncertainFacts ?? data?.unknowns,
  );
  const evidenceAssessment =
    evidenceAssessmentFromJsonValue(
      data?.evidenceAssessment ?? data?.evidence_assessment,
    ) ?? fallbackEvidenceAssessment(input.evidence, decision);
  const aliasEvidence = extractSourceBackedAliasEvidence(
    input.eventA,
    input.eventB,
    input.evidence,
  );
  const canonicalEvent =
    decision === "SAME"
      ? (canonicalEventFromJsonValue(
          data?.canonicalEvent ?? data?.canonical_event,
        ) ?? fallbackCanonicalEvent(input.eventA))
      : null;

  if (decision === "UNCERTAIN" && confidence <= 60) {
    const heuristic = heuristicMatchVerdict(input.eventA, input.eventB);
    if (heuristic && parsed.status !== "invalid") {
      return {
        decision: heuristic.decision,
        confidence: heuristic.confidence,
        reasoning: heuristic.reasoning,
        canonicalEvent:
          heuristic.decision === "SAME"
            ? fallbackCanonicalEvent(input.eventA)
            : null,
        confirmedFacts:
          heuristic.decision === "SAME"
            ? [
                "Deterministic fallback found aligned teams, competition context, and kickoff.",
              ]
            : [],
        uncertainties:
          heuristic.decision === "SAME"
            ? []
            : ["Deterministic fallback did not identify a shared fixture."],
        evidenceAssessment:
          heuristic.decision === "SAME"
            ? {
                ...evidenceAssessment,
                sameEvidence: Math.max(1, evidenceAssessment.sameEvidence),
              }
            : evidenceAssessment,
        aliasEvidence,
        sources: resultsToCitations(input.evidence),
        searchQueriesUsed: input.queriesUsed,
        model: input.model,
        diagnostics: diagnosticsFromParsed(parsed, input.searchDiagnostics),
      };
    }
  }

  return {
    decision,
    confidence,
    reasoning,
    canonicalEvent,
    confirmedFacts,
    uncertainties,
    evidenceAssessment,
    aliasEvidence,
    sources: resultsToCitations(input.evidence),
    searchQueriesUsed: input.queriesUsed,
    model: input.model,
    diagnostics: diagnosticsFromParsed(parsed, input.searchDiagnostics),
  };
}

function parseBatchVerdictFromRaw(input: {
  raw: string;
  model: string;
  pairCount: number;
  evidence: SearchResult[];
  queriesUsed: string[];
  finishReason?: string;
}): BatchMatchVerdict {
  const parsed = parseJsonValue(input.raw, input.finishReason);
  const parsedObject = objectFromJsonValue(parsed.value);
  const items = Array.isArray(parsed.value)
    ? parsed.value
    : Array.isArray(parsedObject?.verdicts)
      ? parsedObject.verdicts
      : Array.isArray(parsedObject?.results)
        ? parsedObject.results
        : Array.isArray(parsedObject?.pairs)
          ? parsedObject.pairs
          : parsedObject?.decision !== undefined ||
              parsedObject?.confidence !== undefined
            ? [parsedObject]
            : [];

  const verdicts: PairVerdict[] = items.map((item: unknown, index) => {
    const obj = objectFromJsonValue(item) ?? {};
    return {
      pairIndex: normalizePairIndex(
        obj.pair ?? obj.pair_index ?? obj.pairIndex,
        index,
        input.pairCount,
      ),
      decision: normalizeDecision(obj.decision),
      confidence: clampConfidence(obj.confidence),
      reasoning:
        (obj.reasoning as string) ||
        (obj.explanation as string) ||
        parsed.warning ||
        "",
      diagnostics: diagnosticsFromParsed(parsed),
    };
  });

  if (verdicts.length < input.pairCount) {
    for (let i = verdicts.length; i < input.pairCount; i++) {
      verdicts.push({
        pairIndex: i,
        decision: "UNCERTAIN",
        confidence: 50,
        reasoning:
          parsed.warning ||
          "AI response did not include a verdict for this pair.",
        diagnostics: diagnosticsFromParsed(parsed),
      });
    }
  }

  return {
    verdicts: verdicts.slice(0, input.pairCount),
    sources: resultsToCitations(input.evidence),
    searchQueriesUsed: input.queriesUsed,
    model: input.model,
  };
}

type JsonRecord = Record<string, unknown>;
type ParsedJsonValue = {
  value: unknown;
  status: AiParseDiagnostics["parseStatus"];
  finishReason?: string;
  warning?: string;
};
type SearchDiagnostics = {
  searchQueryCount: number;
  searchFailureCount: number;
  searchProvidersUsed: string[];
};

function normalizeDecision(value: unknown): MatchDecision {
  let decisionValue = value;
  if (typeof decisionValue === "boolean") {
    decisionValue = decisionValue ? "SAME" : "DIFFERENT";
  }

  let decision = (decisionValue || "UNCERTAIN").toString().toUpperCase();
  if (
    decision === "TRUE" ||
    decision === "YES" ||
    decision === "MATCH" ||
    decision === "SAME_MATCH"
  ) {
    decision = "SAME";
  }
  if (
    decision === "FALSE" ||
    decision === "NO" ||
    decision === "MISMATCH" ||
    decision === "NOT_SAME" ||
    decision === "DIFFERENT_MATCH"
  ) {
    decision = "DIFFERENT";
  }
  if (!["SAME", "DIFFERENT", "UNCERTAIN"].includes(decision)) {
    return "UNCERTAIN";
  }
  return decision as MatchDecision;
}

function objectFromJsonValue(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function stringArrayFromJsonValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function stringOrNullFromJsonValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function canonicalEventFromJsonValue(
  value: unknown,
): MatchCanonicalEvent | null {
  const record = objectFromJsonValue(value);
  if (!record) return null;
  return {
    home: stringOrNullFromJsonValue(record.home ?? record.homeTeam),
    away: stringOrNullFromJsonValue(record.away ?? record.awayTeam),
    competition: stringOrNullFromJsonValue(record.competition),
    kickoff: stringOrNullFromJsonValue(record.kickoff ?? record.startTime),
  };
}

function evidenceAssessmentFromJsonValue(
  value: unknown,
): EvidenceAssessment | null {
  const record = objectFromJsonValue(value);
  if (!record) return null;
  return {
    sameEvidence: nonNegativeInteger(record.sameEvidence),
    differentEvidence: nonNegativeInteger(record.differentEvidence),
    contradiction: record.contradiction === true,
    noSource: record.noSource === true,
    notes: stringArrayFromJsonValue(record.notes),
  };
}

function nonNegativeInteger(value: unknown): number {
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function fallbackEvidenceAssessment(
  evidence: SearchResult[],
  decision: MatchDecision = "UNCERTAIN",
): EvidenceAssessment {
  const sourceCount = uniqueSearchResults(evidence).length;
  if (sourceCount > 0 && decision === "DIFFERENT") {
    return {
      sameEvidence: 0,
      differentEvidence: 1,
      contradiction: false,
      noSource: false,
      notes: [
        "Structured evidence assessment was malformed; search-backed DIFFERENT verdict was preserved for policy routing.",
      ],
    };
  }

  return {
    sameEvidence: 0,
    differentEvidence: 0,
    contradiction: false,
    noSource: sourceCount === 0,
    notes:
      sourceCount === 0
        ? ["No usable search evidence was available."]
        : ["Structured evidence assessment was not returned by the model."],
  };
}

function fallbackCanonicalEvent(event: EventInfo): MatchCanonicalEvent {
  return {
    home: event.homeTeam || null,
    away: event.awayTeam || null,
    competition: event.competition || null,
    kickoff: event.startTime || null,
  };
}

function diagnosticsFromParsed(
  parsed: ParsedJsonValue,
  searchDiagnostics?: SearchDiagnostics,
): AiParseDiagnostics | undefined {
  if (
    parsed.status === "valid" &&
    parsed.finishReason !== "length" &&
    !searchDiagnostics
  ) {
    return undefined;
  }
  const diagnostics: AiParseDiagnostics = {
    parseStatus: parsed.status,
    finishReason: parsed.finishReason,
    warning: parsed.warning,
  };
  if (searchDiagnostics) {
    diagnostics.searchQueryCount = searchDiagnostics.searchQueryCount;
    diagnostics.searchFailureCount = searchDiagnostics.searchFailureCount;
    diagnostics.searchFailureRate =
      searchDiagnostics.searchQueryCount > 0
        ? Number(
            (
              searchDiagnostics.searchFailureCount /
              searchDiagnostics.searchQueryCount
            ).toFixed(3),
          )
        : 0;
    diagnostics.searchProvidersUsed = [
      ...new Set(searchDiagnostics.searchProvidersUsed),
    ];
  }
  return diagnostics;
}

function parseJsonValue(raw: string, finishReason?: string): ParsedJsonValue {
  let text = raw.trim();
  // Strip markdown fences
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return { value: JSON.parse(text), status: "valid", finishReason };
  } catch {
    // Greedy bracket extraction
    const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) {
      try {
        return {
          value: JSON.parse(m[0]),
          status: "recovered",
          finishReason,
          warning: "Recovered JSON from surrounding text.",
        };
      } catch {
        // ignore
      }
    }
    const recoveredObject = recoverPartialJsonObject(text);
    if (recoveredObject) {
      return {
        value: recoveredObject,
        status: "recovered",
        finishReason,
        warning:
          finishReason === "length"
            ? "Recovered fields from a truncated AI JSON response."
            : "Recovered fields from malformed AI JSON.",
      };
    }
    const recoveredVerdicts = recoverPartialBatchVerdicts(text);
    if (recoveredVerdicts.length > 0) {
      return {
        value: { verdicts: recoveredVerdicts },
        status: "recovered",
        finishReason,
        warning:
          finishReason === "length"
            ? "Recovered batch verdicts from a truncated AI JSON response."
            : "Recovered batch verdicts from malformed AI JSON.",
      };
    }
    return {
      value: {},
      status: "invalid",
      finishReason,
      warning:
        finishReason === "length"
          ? "AI response was truncated before valid JSON could be parsed."
          : "AI response was not valid JSON.",
    };
  }
}

function recoverPartialJsonObject(text: string): JsonRecord | null {
  const decisionMatch = text.match(
    /"(?:decision|verdict|answer|match|same_match|is_same_match)"\s*:\s*("([^"]*)"|true|false)/i,
  );
  const confidenceMatch = text.match(
    /"(?:confidence|confidence_score|confidenceScore|score)"\s*:\s*("?)(\d+(?:\.\d+)?)\1/i,
  );
  if (!decisionMatch && !confidenceMatch) return null;

  const reasoningMatch = text.match(
    /"(?:reasoning|explanation|rationale)"\s*:\s*"([^"]*)/i,
  );
  const recovered: JsonRecord = {};
  if (decisionMatch) {
    const rawDecision = decisionMatch[2] ?? decisionMatch[1];
    recovered.decision =
      rawDecision === "true"
        ? true
        : rawDecision === "false"
          ? false
          : rawDecision;
  }
  if (confidenceMatch) {
    recovered.confidence = Number(confidenceMatch[2]);
  }
  if (reasoningMatch) {
    recovered.reasoning = `${reasoningMatch[1].trim()} [truncated]`;
  }
  return recovered;
}

function recoverPartialBatchVerdicts(text: string): JsonRecord[] {
  const verdicts: JsonRecord[] = [];
  const decisionMatches = text.matchAll(/"(?:decision|verdict)"\s*:/gi);
  for (const match of decisionMatches) {
    const decisionAt = match.index ?? 0;
    const objectStart = text.lastIndexOf("{", decisionAt);
    if (objectStart < 0) continue;
    const nextObjectStart = text.indexOf("{", decisionAt + 1);
    const objectEnd = text.indexOf("}", decisionAt + 1);
    const sliceEnd =
      objectEnd >= 0 && (nextObjectStart < 0 || objectEnd < nextObjectStart)
        ? objectEnd + 1
        : nextObjectStart >= 0
          ? nextObjectStart
          : text.length;
    const fragment = text.slice(objectStart, sliceEnd);
    const recovered = recoverPartialJsonObject(fragment);
    if (!recovered) continue;
    const pairMatch = fragment.match(
      /"(?:pair|pair_index|pairIndex)"\s*:\s*("?)(\d+)\1/i,
    );
    if (pairMatch) recovered.pair = Number(pairMatch[2]);
    verdicts.push(recovered);
  }
  return verdicts;
}

function normalizePairIndex(
  value: unknown,
  fallbackIndex: number,
  pairCount: number,
): number {
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallbackIndex;
  // Prompted pair numbers are 1-based. Accept zero-based values only when the
  // model explicitly emits 0, which is outside the prompt contract.
  if (n >= 1 && n <= pairCount) return n - 1;
  if (n >= 0 && n < pairCount) return n;
  return fallbackIndex;
}

function clampConfidence(val: unknown): number {
  const n = typeof val === "number" ? val : parseInt(String(val), 10);
  if (isNaN(n)) return 50;
  if (n > 0 && n <= 1) return Math.round(n * 100);
  return Math.max(0, Math.min(100, n));
}

function uniqueSearchResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const unique: SearchResult[] = [];
  for (const r of results) {
    const key = (r.url || `${r.source}:${r.title}`)
      .replace(/\/$/, "")
      .toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(r);
    }
  }
  return unique;
}

function formatEvidence(
  results: SearchResult[],
  maxItems = Number.POSITIVE_INFINITY,
  maxContentChars = Number.POSITIVE_INFINITY,
): string {
  const unique = uniqueSearchResults(results);
  if (!unique.length) return "";
  const lines: string[] = [];
  for (let i = 0; i < Math.min(unique.length, maxItems); i++) {
    const r = unique[i];
    lines.push(`[${i + 1}] ${r.title}`);
    lines.push(`    URL: ${r.url}`);
    lines.push(`    Source: ${r.source}`);
    const rawContent = searchResultText(r).trim();
    const content =
      rawContent.length > maxContentChars
        ? `${rawContent.slice(0, maxContentChars).trim()}...`
        : rawContent;
    if (content) {
      lines.push(`    Content:`);
      lines.push(indentEvidenceContent(content));
    }
    lines.push("");
  }
  return lines.join("\n");
}

function indentEvidenceContent(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => `    ${line}`)
    .join("\n");
}

function resultsToCitations(results: SearchResult[]): SourceCitation[] {
  const seen = new Set<string>();
  const citations: SourceCitation[] = [];
  for (const r of results) {
    const key = r.url.replace(/\/$/, "").toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      citations.push({
        url: r.url,
        title: r.title,
        snippet: r.snippet || searchResultText(r),
      });
    }
  }
  return citations;
}

/**
 * Pull a SearchResult[] out of a free-form context object. The Playground
 * wraps results as `{ web_search_results: [...] }`; some callers pass them
 * under `results` directly. Anything malformed falls through as [].
 */
function extractResults(context: unknown): SearchResult[] {
  if (!context || typeof context !== "object") return [];
  const obj = context as Record<string, unknown>;
  const candidates = [obj.web_search_results, obj.results, obj.evidence];
  for (const c of candidates) {
    if (!Array.isArray(c)) continue;
    const out: SearchResult[] = [];
    for (const item of c) {
      if (item && typeof item === "object") {
        const it = item as Record<string, unknown>;
        const url = typeof it.url === "string" ? it.url : "";
        const title = typeof it.title === "string" ? it.title : "";
        const snippet = typeof it.snippet === "string" ? it.snippet : "";
        const content =
          typeof it.content === "string"
            ? it.content
            : typeof it.raw_content === "string"
              ? it.raw_content
              : snippet;
        const source = typeof it.source === "string" ? it.source : "caller";
        if (url) out.push({ url, title, snippet, content, source });
      }
    }
    if (out.length > 0) return out;
  }
  return [];
}

/** Drop the web_search_results / results keys; keep any other side context. */
function stripWebResults(context: unknown): Record<string, unknown> | null {
  if (!context || typeof context !== "object") return null;
  const obj = context as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "web_search_results" || k === "results" || k === "evidence")
      continue;
    cleaned[k] = v;
  }
  return cleaned;
}

// ── Singleton ────────────────────────────────────────────────────────

let _instance: GroundingEngine | null = null;

export function getGroundingEngine(): GroundingEngine {
  if (!_instance) {
    _instance = new GroundingEngine();
  }
  return _instance;
}

export const grounding = new Proxy({} as GroundingEngine, {
  get(_target, prop) {
    const engine = getGroundingEngine();
    return (engine as unknown as Record<string, unknown>)[prop as string];
  },
});

export const __groundingTestHooks = {
  extractSourceBackedAliasEvidence,
  parseMatchVerdict(
    raw: string,
    opts?: {
      finishReason?: string;
      model?: string;
      eventA?: EventInfo;
      eventB?: EventInfo;
      evidence?: SearchResult[];
      queriesUsed?: string[];
      searchDiagnostics?: SearchDiagnostics;
    },
  ): MatchVerdict {
    return parseMatchVerdictFromRaw({
      raw,
      model: opts?.model ?? "deepseek-v4-flash",
      evidence: opts?.evidence ?? [],
      queriesUsed: opts?.queriesUsed ?? [],
      eventA: opts?.eventA ?? {
        homeTeam: "Dukla Prague",
        awayTeam: "Banik Ostrava",
        competition: "Czech 1 Liga",
        startTime: "2026-05-23 12:00:00+00",
      },
      eventB: opts?.eventB ?? {
        homeTeam: "Banik Ostrava B",
        awayTeam: "Sparta Prague B",
        competition: "Czech 2 Liga",
        startTime: "2026-05-23 12:00:00+00",
      },
      finishReason: opts?.finishReason,
      searchDiagnostics: opts?.searchDiagnostics,
    });
  },
  parseBatchVerdict(
    raw: string,
    pairCount: number,
    opts?: {
      finishReason?: string;
      model?: string;
      evidence?: SearchResult[];
      queriesUsed?: string[];
    },
  ): BatchMatchVerdict {
    return parseBatchVerdictFromRaw({
      raw,
      pairCount,
      model: opts?.model ?? "deepseek-v4-flash",
      evidence: opts?.evidence ?? [],
      queriesUsed: opts?.queriesUsed ?? [],
      finishReason: opts?.finishReason,
    });
  },
};
