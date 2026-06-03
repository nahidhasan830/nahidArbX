import OpenAI from "openai";
import { logAiActivity } from "@/lib/ai/activity-logger";
import { singleton } from "@/lib/util/singleton";
import type { SearchQueryVariant } from "./query-rewrites";

const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";

type RefinerState = {
  cache: Map<string, SearchQueryVariant[]>;
};

const state = singleton(
  "ai:vertex-query-refiner",
  (): RefinerState => ({
    cache: new Map(),
  }),
);

function getDeepSeekClient(): OpenAI {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not configured");
  return new OpenAI({ baseURL: "https://api.deepseek.com", apiKey });
}

function normalizeQuery(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function shouldUseDeepSeekVertexRefiner(query: string): boolean {
  if (!process.env.DEEPSEEK_API_KEY) return false;
  const clean = normalizeQuery(query);
  if (!clean || clean.length < 45) return false;
  if (
    /^Classify the football betting-market efficiency context for this competition:/i.test(
      clean,
    )
  ) {
    return false;
  }
  return (
    clean.length > 80 ||
    /site:|"|same football|the same football team as|\bfixture\b|\?\s*$|\bRes\b|\bEstud\.?\b|\bInd\.?\b|\bAtl\.?\b/i.test(
      clean,
    )
  );
}

export async function refineVertexSearchQueries(input: {
  originalQuery: string;
  attemptedQueries: string[];
}): Promise<SearchQueryVariant[]> {
  const originalQuery = normalizeQuery(input.originalQuery);
  if (!shouldUseDeepSeekVertexRefiner(originalQuery)) return [];

  const cacheKey = JSON.stringify({
    originalQuery,
    attemptedQueries: input.attemptedQueries.map(normalizeQuery),
  });
  const cached = state.cache.get(cacheKey);
  if (cached) return cached;

  const client = getDeepSeekClient();
  const systemPrompt = `You rewrite football web search queries for Vertex AI Search over a curated corpus of sports sites.
Return only strict JSON with this shape:
{"queries":["query 1","query 2"]}

Rules:
- Return at most 2 queries.
- Keep team names, competition names, and dates when they are useful.
- Remove site: operators, instructional prompt text, and question phrasing.
- Prefer short keyword searches over sentences.
- Expand common football abbreviations when useful, such as Estud.=Estudiantes, Ind.=Independiente, Atl.=Atletico, Res=reserve.
- Do not explain anything.`;

  const userPrompt = `Original query: ${originalQuery}

Already attempted:
${input.attemptedQueries.map((q) => `- ${normalizeQuery(q)}`).join("\n")}

Return better Vertex-friendly search queries now.`;

  const response = await logAiActivity(
    {
      system: "llm",
      provider: "deepseek-flash",
      endpoint: "vertex-query-refiner",
      model: DEEPSEEK_MODEL,
      query: originalQuery.slice(0, 200),
      itemCount: 2,
      request: {
        systemPrompt,
        userPrompt,
        originalQuery,
        attemptedQueries: input.attemptedQueries,
      },
      response: (raw: unknown) => {
        const choice = (
          raw as {
            choices?: Array<{ message?: { content?: string | null } }>;
          }
        )?.choices?.[0];
        return { content: choice?.message?.content ?? "" };
      },
      metadata: {
        attemptedQueryCount: input.attemptedQueries.length,
      },
    },
    async () =>
      client.chat.completions.create({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 200,
        response_format: { type: "json_object" },
      }),
  );

  const raw = response.choices[0]?.message?.content || "{}";
  const parsed = parseRefinedQueries(raw, input.attemptedQueries);
  state.cache.set(cacheKey, parsed);
  return parsed;
}

function parseRefinedQueries(
  raw: string,
  attemptedQueries: string[],
): SearchQueryVariant[] {
  const attempted = new Set(attemptedQueries.map((q) => normalizeQuery(q).toLowerCase()));
  const seen = new Set<string>();
  let value: unknown = {};
  try {
    value = JSON.parse(raw);
  } catch {
    value = {};
  }

  const queries = Array.isArray((value as { queries?: unknown[] }).queries)
    ? ((value as { queries?: unknown[] }).queries ?? [])
    : [];

  const refined: SearchQueryVariant[] = [];
  for (const item of queries) {
    if (typeof item !== "string") continue;
    const query = normalizeQuery(item);
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key) || attempted.has(key)) continue;
    seen.add(key);
    refined.push({
      query,
      reason: "deepseek-refined",
    });
  }
  return refined.slice(0, 2);
}
