
import { describe, it, expect, beforeAll } from "vitest";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const MODEL = process.env.AI_PLAYGROUND_MODEL ?? "deepseek-v4-flash";

const LLM_TIMEOUT_MS = 60_000;

const QUERY = "today cricket match bd";

interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

interface SearchResp {
  query: string;
  provider_used: string;
  results: SearchResult[];
}

interface GroundedResp {
  answer: string;
  reasoning: string;
  sources: { url: string; title: string; snippet: string }[];
  model: string;
}

async function isUp(url: string, timeoutMs = 10_000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function postJson<T>(
  path: string,
  body: object,
  timeoutMs: number,
): Promise<{
  status: number;
  body: T;
}> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
  }
  return { status: res.status, body: parsed as T };
}

async function getJson<T>(
  path: string,
  timeoutMs = 8_000,
): Promise<{
  status: number;
  body: T;
}> {
  const res = await fetch(`${BASE_URL}${path}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
  }
  return { status: res.status, body: parsed as T };
}

describe("AI Playground (e2e)", () => {
  let servicesUp = false;

  beforeAll(async () => {
    const next = await isUp(`${BASE_URL}/api/ai-search/healthz`);
    servicesUp = next;
    if (!servicesUp) {
      console.warn(
        `[ai-playground.e2e] Skipping — Next.js AI search is not healthy. ` +
          `Start with \`npm run dev:all\` to run these tests.`,
      );
    }
  });

  describe("health probes", () => {
    it("Next.js proxy: /api/ai-search/healthz reports the LLM engine + at least one healthy search provider", async () => {
      if (!servicesUp) return;

      const { status, body } = await getJson<{
        status: string;
        llm_engine: { healthy: boolean; model: string };
        search_providers: { total: number; healthy: number };
      }>("/api/ai-search/healthz");

      expect(status).toBe(200);
      expect(body.llm_engine.healthy).toBe(true);
      expect(body.llm_engine.model).toBeTruthy();
      expect(body.search_providers.total).toBeGreaterThan(0);
      expect(body.search_providers.healthy).toBeGreaterThan(0);
    });

    it("Next.js proxy: /api/ai-search/llm-stats includes both deepseek + gemini providers", async () => {
      if (!servicesUp) return;

      const { status, body } = await getJson<{
        usage: {
          providers: Record<string, { model: string; disabled: boolean }>;
        };
      }>("/api/ai-search/llm-stats");

      expect(status).toBe(200);
      const providers = body.usage.providers;
      expect(providers).toBeTruthy();
      expect(providers.deepseek).toBeTruthy();
      expect(providers.gemini).toBeTruthy();
      const usedProvider = MODEL.startsWith("gemini") ? "gemini" : "deepseek";
      expect(providers[usedProvider].disabled).toBe(false);
    });
  });

  describe("step 1 — web grounding", () => {
    it("POST /api/ai-search/search returns at least one result from a real provider", async () => {
      if (!servicesUp) return;

      const { status, body } = await postJson<SearchResp>(
        "/api/ai-search/search",
        { query: QUERY, max_results: 5, service: "PlaygroundTest" },
        15_000,
      );

      expect(status).toBe(200);
      expect(body.provider_used).not.toBe("none");
      expect(body.provider_used).toBeTruthy();
      expect(Array.isArray(body.results)).toBe(true);
      expect(body.results.length).toBeGreaterThan(0);

      for (const r of body.results) {
        expect(r.url).toMatch(/^https?:\/\//);
        expect(typeof r.title).toBe("string");
        expect(typeof r.snippet).toBe("string");
      }
    }, 20_000);
  });

  describe("step 2 — AI synthesis", () => {
    it(
      "POST /api/ai-search/grounded-query (skip_search=true, with context) returns clean prose, never raw JSON",
      async () => {
        if (!servicesUp) return;

        const search = await postJson<SearchResp>(
          "/api/ai-search/search",
          { query: QUERY, max_results: 5, service: "PlaygroundTest" },
          15_000,
        );
        expect(search.body.provider_used).not.toBe("none");

        const { status, body } = await postJson<GroundedResp>(
          "/api/ai-search/grounded-query",
          {
            question: QUERY,
            context: { web_search_results: search.body.results },
            skip_search: true,
            model: MODEL,
            service: "PlaygroundTest",
          },
          LLM_TIMEOUT_MS,
        );

        expect(status).toBe(200);
        expect(body.model).toBeTruthy();

        const answer = body.answer.trim();
        expect(answer.length).toBeGreaterThan(20);
        expect(answer.startsWith("{")).toBe(false);
        expect(answer).not.toMatch(/^\s*\{?\s*"answer"\s*:/);

        expect(answer.endsWith('"')).toBe(false);
        expect(answer.endsWith("\\")).toBe(false);

        if (body.reasoning) {
          expect(body.reasoning.startsWith("{")).toBe(false);
        }
      },
      LLM_TIMEOUT_MS + 20_000,
    );

    it(
      "POST /api/ai-search/grounded-query (skip_search=false) populates sources from the service-side search",
      async () => {
        if (!servicesUp) return;

        const { status, body } = await postJson<GroundedResp>(
          "/api/ai-search/grounded-query",
          {
            question: QUERY,
            skip_search: false,
            model: MODEL,
            service: "PlaygroundTest",
          },
          LLM_TIMEOUT_MS,
        );

        expect(status).toBe(200);
        expect(body.answer.trim().length).toBeGreaterThan(20);
        expect(body.answer.startsWith("{")).toBe(false);

        expect(Array.isArray(body.sources)).toBe(true);
        expect(body.sources.length).toBeGreaterThan(0);
        for (const src of body.sources) {
          expect(src.url).toMatch(/^https?:\/\//);
        }
      },
      LLM_TIMEOUT_MS + 20_000,
    );
  });

  describe("error handling", () => {
    it("Unknown sub-path returns 404 (proxy whitelist is enforced)", async () => {
      if (!servicesUp) return;

      const { status } = await postJson(
        "/api/ai-search/this-endpoint-does-not-exist",
        { foo: "bar" },
        5_000,
      );
      expect(status).toBe(404);
    });
  });
});
