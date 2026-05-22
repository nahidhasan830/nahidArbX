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
  BatchMatchVerdict,
  SettlementVerdict,
  GroundedAnswer,
  SearchResult,
  SourceCitation,
  PairVerdict,
} from "./search/types";
import {
  ENTITY_MATCH_SYSTEM,
  ENTITY_MATCH_BATCH_SYSTEM,
  SETTLEMENT_SYSTEM,
  buildGenericSystem,
  entityMatchPrompt,
  entityMatchBatchPrompt,
  settlementPrompt,
  genericQueryPrompt,
} from "./prompts";
import { getSearchRouter, type SearchRouter } from "./search/router";
import { logAiActivity } from "./activity-logger";
import { bestSim } from "../matching/string-sim";
import { normalize, normalizeCompetition } from "../matching/normalize";
import { format, isValid, parseISO } from "date-fns";

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
      return {
        date: format(d, "yyyy-MM-dd"),
        time: format(d, "HH:mm"),
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

export function buildMatchQueries(
  eventA: EventInfo,
  eventB: EventInfo,
): string[] {
  const queries: string[] = [];
  const { date, time } = getGroundingDates(eventA.startTime);

  queries.push(
    `${eventA.homeTeam} ${eventA.awayTeam} ${date} ${eventA.competition} football fixture`,
    `${eventB.homeTeam} ${eventB.awayTeam} ${date} ${eventB.competition} football fixture`,
    `${eventA.homeTeam} ${eventA.awayTeam} ${eventB.homeTeam} ${eventB.awayTeam} ${date} same football match`,
  );

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
    `"${eventA.homeTeam}" vs "${eventA.awayTeam}" "${eventB.homeTeam}" vs "${eventB.awayTeam}" ${date} ${time} football match`,
  );

  return queries;
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

export function buildSettlementQueries(event: EventInfo): string[] {
  const { date } = getGroundingDates(event.startTime);

  return [
    `${event.homeTeam} vs ${event.awayTeam} ${event.competition} ${date} final score result`,
    `${event.homeTeam} vs ${event.awayTeam} ${event.competition} ${date} full time score football`,
    `${event.homeTeam} ${event.awayTeam} ${date} score flashscore livescore sofascore`,
    `${event.homeTeam} ${event.awayTeam} ${date} result ESPN BBC Sport`,
    `${event.homeTeam} ${event.awayTeam} resultado ${date} futebol football`,
    `"${event.homeTeam}" "${event.awayTeam}" "${date}" "FT" score`,
  ];
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

    for (const q of queries.slice(0, 5)) {
      const { results } = await this.search.search(q, 3);
      allEvidence.push(...results);
      queriesUsed.push(q);
    }

    const evidenceText = formatEvidence(allEvidence);
    let prompt = entityMatchPrompt(
      {
        homeTeam: eventA.homeTeam,
        awayTeam: eventA.awayTeam,
        competition: eventA.competition,
        startTime: eventA.startTime,
        provider: eventA.provider,
      },
      {
        homeTeam: eventB.homeTeam,
        awayTeam: eventB.awayTeam,
        competition: eventB.competition,
        startTime: eventB.startTime,
        provider: eventB.provider,
      },
    );
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
        itemCount: 1,
        response: { promptLength: prompt.length },
      },
      async () => {
        const r = await llm.chat.completions.create({
          model,
          messages: [
            { role: "system", content: ENTITY_MATCH_SYSTEM },
            { role: "user", content: prompt },
          ],
          temperature: 0,
          max_tokens: 256,
          response_format: { type: "json_object" },
        });
        raw = r.choices[0]?.message?.content || "{}";
        return r;
      },
    );

    raw = resp.choices[0]?.message?.content || "{}";
    return this._parseMatchVerdict(
      raw,
      model,
      allEvidence,
      queriesUsed,
      eventA,
      eventB,
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

    const evidenceText = formatEvidence(allEvidence, 15);
    let prompt = entityMatchBatchPrompt(indexedPairs);
    if (evidenceText) {
      prompt += `\n\nWEB SEARCH EVIDENCE:\n${evidenceText}`;
    }

    const llm = getDeepSeekClient();
    const model = getDeepSeekModel();
    const maxTokens = Math.min(256 * pairs.length, 4096);

    let rawBatch = "";
    const resp = await logAiActivity(
      {
        system: "llm",
        provider: "deepseek-flash",
        endpoint: "entity-match",
        model,
        itemCount: pairs.length,
        response: { promptLength: prompt.length },
      },
      async () => {
        const r = await llm.chat.completions.create({
          model,
          messages: [
            { role: "system", content: ENTITY_MATCH_BATCH_SYSTEM },
            { role: "user", content: prompt },
          ],
          temperature: 0,
          max_tokens: maxTokens,
          response_format: { type: "json_object" },
        });
        rawBatch = r.choices[0]?.message?.content || "[]";
        return r;
      },
    );

    rawBatch = resp.choices[0]?.message?.content || "[]";
    return this._parseBatchVerdict(
      rawBatch,
      model,
      pairs.length,
      allEvidence,
      queriesUsed,
    );
  }

  // ── Settlement verification ────────────────────────────────────────

  async verifySettlement(
    event: EventInfo,
    question: string,
  ): Promise<SettlementVerdict> {
    const queries = buildSettlementQueries(event);

    const allResults: SearchResult[] = [];
    const seen = new Set<string>();

    for (const q of queries) {
      try {
        const { results } = await this.search.search(q, 5);
        for (const r of results) {
          const key = r.url.replace(/\/$/, "").toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            allResults.push(r);
          }
        }
      } catch {
        // Ignore search errors for individual queries
      }
    }

    const evidenceText = formatEvidence(allResults, 12);
    let prompt = settlementPrompt(
      event.homeTeam,
      event.awayTeam,
      event.competition,
      event.startTime,
      question,
    );
    if (evidenceText) {
      prompt += `\n\nWEB SEARCH EVIDENCE:\n${evidenceText}`;
    } else {
      prompt += `\n\nNo web search results were found. Based on your knowledge, if you are confident about the result of this match, provide the score. Only say UNKNOWN if you have no reliable information at all.`;
    }

    const llm = getDeepSeekClient();
    const model = getDeepSeekModel();

    let rawSettle = "";
    const resp = await logAiActivity(
      {
        system: "llm",
        provider: "deepseek-flash",
        endpoint: "verify-settlement",
        model,
        itemCount: 1,
        response: { promptLength: prompt.length },
      },
      async () => {
        const r = await llm.chat.completions.create({
          model,
          messages: [
            { role: "system", content: SETTLEMENT_SYSTEM },
            { role: "user", content: prompt },
          ],
          temperature: 0,
          max_tokens: 512,
          response_format: { type: "json_object" },
        });
        rawSettle = r.choices[0]?.message?.content || "{}";
        return r;
      },
    );

    rawSettle = resp.choices[0]?.message?.content || "{}";
    return this._parseSettlementVerdict(rawSettle, model, allResults);
  }

  // ── Generic grounded query ─────────────────────────────────────────

  async query(
    question: string,
    context?: Record<string, unknown>,
    opts?: {
      provider?: "deepseek" | "gemini";
      model?: string;
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
      const r = await this.search.search(question, 8);
      internalResults = r.results;
    }

    const evidence = callerResults.length > 0 ? callerResults : internalResults;
    const evidenceText = formatEvidence(evidence, 10);
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
          itemCount: 1,
          response: { promptLength: prompt.length },
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
        itemCount: 1,
        response: { promptLength: prompt.length },
      },
      async () => {
        const r = await llm.chat.completions.create({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
          temperature: 0,
          max_tokens: 4096,
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
  ): MatchVerdict {
    const data = parseJson(raw);
    let decisionValue: unknown =
      data?.decision ??
      data?.verdict ??
      data?.answer ??
      data?.match ??
      data?.same_match ??
      data?.is_same_match;

    if (typeof decisionValue === "boolean") {
      decisionValue = decisionValue ? "SAME" : "DIFFERENT";
    }

    let decision = (decisionValue || "UNCERTAIN").toString().toUpperCase();
    // Handle common LLM synonyms
    if (
      decision === "TRUE" ||
      decision === "YES" ||
      decision === "MATCH" ||
      decision === "SAME_MATCH"
    )
      decision = "SAME";
    if (
      decision === "FALSE" ||
      decision === "NO" ||
      decision === "MISMATCH" ||
      decision === "NOT_SAME" ||
      decision === "DIFFERENT_MATCH"
    )
      decision = "DIFFERENT";
    if (!["SAME", "DIFFERENT", "UNCERTAIN"].includes(decision))
      decision = "UNCERTAIN";
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
      "";

    if (decision === "UNCERTAIN" && confidence <= 60) {
      const heuristic = heuristicMatchVerdict(eventA, eventB);
      if (heuristic) {
        return {
          decision: heuristic.decision,
          confidence: heuristic.confidence,
          reasoning: heuristic.reasoning,
          sources: resultsToCitations(evidence),
          searchQueriesUsed: queriesUsed,
          model,
        };
      }
    }

    return {
      decision: decision as MatchVerdict["decision"],
      confidence,
      reasoning,
      sources: resultsToCitations(evidence),
      searchQueriesUsed: queriesUsed,
      model,
    };
  }

  private _parseBatchVerdict(
    raw: string,
    model: string,
    pairCount: number,
    evidence: SearchResult[],
    queriesUsed: string[],
  ): BatchMatchVerdict {
    const arr = parseJson(raw);
    const items = Array.isArray(arr) ? arr : [];

    const verdicts: PairVerdict[] = items.map(
      (item: Record<string, unknown>) => ({
        pairIndex: (typeof item.pair === "number"
          ? item.pair
          : typeof item.pair_index === "number"
            ? item.pair_index
            : 0) as number,
        decision: ((item.decision as string) ||
          "UNCERTAIN") as PairVerdict["decision"],
        confidence: clampConfidence(item.confidence),
        reasoning: (item.reasoning as string) || "",
      }),
    );

    if (verdicts.length < pairCount) {
      for (let i = verdicts.length + 1; i <= pairCount; i++) {
        verdicts.push({
          pairIndex: i,
          decision: "UNCERTAIN",
          confidence: 50,
          reasoning: "",
        });
      }
    }

    return {
      verdicts: verdicts.slice(0, pairCount),
      sources: resultsToCitations(evidence),
      searchQueriesUsed: queriesUsed,
      model,
    };
  }

  private _parseSettlementVerdict(
    raw: string,
    model: string,
    evidence: SearchResult[],
  ): SettlementVerdict {
    const data = parseJson(raw);
    const answer =
      data?.answer ??
      data?.score ??
      data?.final_score ??
      data?.ft_score ??
      data?.result ??
      "";
    return {
      answer: String(answer),
      confidence: clampConfidence(data?.confidence),
      reasoning: (data?.reasoning as string) || "",
      sources: resultsToCitations(evidence),
      model,
    };
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

function parseJson(raw: string): Record<string, unknown> {
  let text = raw.trim();
  // Strip markdown fences
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(text);
  } catch {
    // Greedy bracket extraction
    const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        // ignore
      }
    }
    return {};
  }
}

function clampConfidence(val: unknown): number {
  const n = typeof val === "number" ? val : parseInt(String(val), 10);
  if (isNaN(n)) return 50;
  if (n > 0 && n <= 1) return Math.round(n * 100);
  return Math.max(0, Math.min(100, n));
}

function formatEvidence(results: SearchResult[], maxItems = 8): string {
  if (!results.length) return "";

  const seen = new Set<string>();
  const unique: SearchResult[] = [];
  for (const r of results) {
    const key = r.url.replace(/\/$/, "").toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(r);
    }
  }

  const lines: string[] = [];
  for (let i = 0; i < Math.min(unique.length, maxItems); i++) {
    const r = unique[i];
    lines.push(`[${i + 1}] ${r.title}`);
    lines.push(`    URL: ${r.url}`);
    lines.push(`    ${r.snippet.slice(0, 300)}`);
    lines.push("");
  }
  return lines.join("\n");
}

function resultsToCitations(results: SearchResult[]): SourceCitation[] {
  const seen = new Set<string>();
  const citations: SourceCitation[] = [];
  for (const r of results) {
    const key = r.url.replace(/\/$/, "").toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      citations.push({ url: r.url, title: r.title, snippet: r.snippet });
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
        const source = typeof it.source === "string" ? it.source : "caller";
        if (url) out.push({ url, title, snippet, source });
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
