/**
 * AI Playground — end-to-end test.
 *
 * Drives the same two-step flow the /ai-playground page uses:
 *   1. POST /api/ai-search/search           (Web Grounding panel)
 *   2. POST /api/ai-search/grounded-query   (AI Synthesis panel)
 *
 * Plus health probes (/healthz, /llm-stats) and a control run with
 * skip_search=false to confirm the service-side search path also
 * returns proper sources + readable answers.
 *
 * Skips silently if the Next.js dev server (3000) or the ai-search
 * Python service (8090) isn't reachable, so it never blocks CI.
 *
 * Guards against the regression we just fixed:
 *   - Truncated answers leaking raw JSON (`{"answer": "Today, Bangladesh…`)
 *     to the UI when the LLM exceeds max_tokens.
 *
 * Run:
 *   npx vitest run tests/ai-playground.e2e.test.ts
 *   BASE_URL=http://localhost:3000 npx vitest run tests/ai-playground.e2e.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const MODEL = process.env.AI_PLAYGROUND_MODEL ?? "deepseek-v4-flash";

// LLM calls are slow; allow up to 60s like the proxy route does.
const LLM_TIMEOUT_MS = 60_000;

// Single, well-known query that reliably produces a non-empty answer.
// Picked because cricket fixture pages have rich snippets, so Vertex
// Search returns useful evidence and the LLM has something concrete to say.
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

async function postJson<T>(path: string, body: object, timeoutMs: number): Promise<{
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
    /* leave as text */
  }
  return { status: res.status, body: parsed as T };
}

async function getJson<T>(path: string, timeoutMs = 8_000): Promise<{
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
    /* leave as text */
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
      // Whichever engine is selected by the playground must not be disabled.
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
      // provider_used="none" means every search backend failed — the
      // playground UI swaps that into a hard error, so the e2e must too.
      expect(body.provider_used).not.toBe("none");
      expect(body.provider_used).toBeTruthy();
      expect(Array.isArray(body.results)).toBe(true);
      expect(body.results.length).toBeGreaterThan(0);

      // Sanity-check shape: every result has a url + title + snippet.
      for (const r of body.results) {
        expect(r.url).toMatch(/^https?:\/\//);
        expect(typeof r.title).toBe("string");
        expect(typeof r.snippet).toBe("string");
      }
    }, 20_000);
  });

  describe("step 2 — AI synthesis", () => {
    it("POST /api/ai-search/grounded-query (skip_search=true, with context) returns clean prose, never raw JSON", async () => {
      if (!servicesUp) return;

      // Mirror exactly what app/ai-playground/page.tsx does:
      // run search first, then pass results as `context.web_search_results`.
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

      // Core regression guards — bug we just fixed:
      // 1. Answer must NOT be the raw JSON envelope leaking through
      //    (e.g. `{"answer": "Today, Bangladesh is playing the 2nd`).
      const answer = body.answer.trim();
      expect(answer.length).toBeGreaterThan(20);
      expect(answer.startsWith("{")).toBe(false);
      expect(answer).not.toMatch(/^\s*\{?\s*"answer"\s*:/);

      // 2. Truncation heuristic: the answer should end with normal
      //    punctuation, not be cut off mid-word or mid-quoted-string.
      //    A trailing lone double-quote with no closing brace is a
      //    classic JSON-truncation tell.
      expect(answer.endsWith('"')).toBe(false);
      expect(answer.endsWith("\\")).toBe(false);

      // 3. Reasoning is optional but if present must also be clean.
      if (body.reasoning) {
        expect(body.reasoning.startsWith("{")).toBe(false);
      }
    }, LLM_TIMEOUT_MS + 20_000);

    it("POST /api/ai-search/grounded-query (skip_search=false) populates sources from the service-side search", async () => {
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

      // When the service does its own search, sources MUST be populated.
      expect(Array.isArray(body.sources)).toBe(true);
      expect(body.sources.length).toBeGreaterThan(0);
      for (const src of body.sources) {
        expect(src.url).toMatch(/^https?:\/\//);
      }
    }, LLM_TIMEOUT_MS + 20_000);
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
