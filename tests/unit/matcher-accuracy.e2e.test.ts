/**
 * Event Matching AI Accuracy Test (DeepSeek Flash Only)
 *
 * Frontend-style reverse check:
 *   1. GET /api/ai-accuracy?kind=event-match&sampleSize=20
 *   2. POST /api/matcher-lab/verify-ai for each sampled pair
 *   3. Compare the DeepSeek verdict against the historical DB decision
 *
 * Run:
 *   BASE_URL=http://localhost:3000 npx vitest run tests/unit/matcher-accuracy.e2e.test.ts
 */

import { beforeAll, describe, expect, it } from "vitest";

const BASE_URL = (() => {
  const env = process.env.BASE_URL;
  if (env && env.startsWith("http")) return env;
  return "http://localhost:3000";
})();

const LLM_TIMEOUT_MS = 90_000;
const SAMPLE_SIZE = 20;
const MAX_RETRIES = 2;

interface EventInfo {
  homeTeam: string;
  awayTeam: string;
  competition: string;
  startTime: string;
  provider?: string;
}

interface MatchSample {
  id: string;
  expected: "SAME" | "DIFFERENT";
  decision: string;
  decidedBy: string | null;
  stringScore: number;
  eventA: EventInfo;
  eventB: EventInfo;
  request: {
    endpoint: string;
    body: { id: string; engine: string };
    searchQueries: string[];
  };
}

interface SamplesResponse {
  count: number;
  samples: MatchSample[];
}

interface VerifyAiResult {
  decision: "SAME" | "DIFFERENT" | "UNCERTAIN";
  confidence: number;
  model?: string;
  engine?: string;
  reasoning?: string;
  sources?: { url: string; title: string; snippet: string }[];
  searchQueriesUsed?: string[];
}

interface VerifyAiResponse {
  result?: VerifyAiResult;
  error?: string;
}

interface TestResult {
  idx: number;
  id: string;
  request: string;
  expected: string;
  response: string;
  rating: "correct" | "incorrect" | "uncertain" | "error";
  confidence: number;
  model: string;
  sources: number;
  decidedBy: string;
}

async function isUp(url: string, timeoutMs = 10_000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function getJson<T>(path: string, timeoutMs: number): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`${path} returned HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function postJson<T>(
  path: string,
  body: object,
  timeoutMs: number,
): Promise<{ status: number; body: T }> {
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
    // Keep raw text for error reporting.
  }
  return { status: res.status, body: parsed as T };
}

async function postJsonWithRetry<T>(
  path: string,
  body: object,
  timeoutMs: number,
  retries = MAX_RETRIES,
): Promise<{ status: number; body: T }> {
  let lastErr: Error | null = null;
  for (let i = 0; i <= retries; i++) {
    try {
      return await postJson<T>(path, body, timeoutMs);
    } catch (err) {
      lastErr = err as Error;
      if (i < retries) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw lastErr;
}

function eventLabel(event: EventInfo): string {
  return `${event.homeTeam} vs ${event.awayTeam}`;
}

function compact(value: string, max = 42): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

function printTable(results: TestResult[]) {
  console.log(
    "| # | Request | Expected | Response | Rating | Conf | Model | Src | By |",
  );
  console.log(
    "|---|---------|----------|----------|--------|------|-------|-----|----|",
  );
  for (const r of results) {
    console.log(
      `| ${r.idx} | ${compact(r.request)} | ${r.expected} | ${compact(r.response)} | ${r.rating} | ${r.confidence} | ${compact(r.model, 22)} | ${r.sources} | ${r.decidedBy} |`,
    );
  }
}

describe("Event Matching AI Accuracy (HTTP e2e)", () => {
  let servicesUp = false;
  let samples: MatchSample[] = [];

  beforeAll(async () => {
    servicesUp = await isUp(`${BASE_URL}/api/ai-search/healthz`);
    if (!servicesUp) {
      console.warn(
        "[matcher-accuracy.e2e] Skipping because /api/ai-search/healthz is unavailable. Start `npm run dev` first.",
      );
      return;
    }

    const data = await getJson<SamplesResponse>(
      `/api/ai-accuracy?kind=event-match&sampleSize=${SAMPLE_SIZE}`,
      120_000,
    );
    samples = data.samples;
    console.log(`[matcher-accuracy.e2e] Loaded ${samples.length} HTTP samples`);
  }, 150_000);

  it(
    `verifies ${SAMPLE_SIZE} historical match pairs via DeepSeek`,
    async () => {
      if (!servicesUp || samples.length === 0) return;

      let correct = 0;
      let incorrect = 0;
      let uncertain = 0;
      let errors = 0;
      const results: TestResult[] = [];

      for (let idx = 0; idx < samples.length; idx++) {
        const sample = samples[idx];
        let response = "ERROR";
        let rating: TestResult["rating"] = "error";
        let confidence = 0;
        let model = "";
        let sources = 0;

        try {
          const { status, body } = await postJsonWithRetry<VerifyAiResponse>(
            sample.request.endpoint,
            sample.request.body,
            LLM_TIMEOUT_MS,
          );

          if (status === 200 && body.result) {
            const decision = body.result.decision;
            confidence = body.result.confidence;
            model = body.result.model ?? "";
            sources = body.result.sources?.length ?? 0;
            response = `${decision} ${confidence}% ${body.result.reasoning ?? ""}`;

            expect(model.toLowerCase()).toContain("deepseek");
            expect(model.toLowerCase()).not.toContain("gemini");

            if (decision === "UNCERTAIN") {
              uncertain++;
              rating = "uncertain";
            } else if (decision === sample.expected) {
              correct++;
              rating = "correct";
            } else {
              incorrect++;
              rating = "incorrect";
            }
          } else {
            errors++;
            response = body.error ?? `HTTP ${status}`;
          }
        } catch (err) {
          errors++;
          response = (err as Error).message;
        }

        results.push({
          idx: idx + 1,
          id: sample.id,
          request: `${eventLabel(sample.eventA)} <> ${eventLabel(sample.eventB)} | ${sample.request.searchQueries[0] ?? ""}`,
          expected: sample.expected,
          response,
          rating,
          confidence,
          model,
          sources,
          decidedBy: sample.decidedBy ?? "unknown",
        });

        console.log(
          `[${idx + 1}/${samples.length}] ${sample.expected} -> ${rating} (${confidence}%) ${eventLabel(sample.eventA)} <> ${eventLabel(sample.eventB)}`,
        );
      }

      const decided = correct + incorrect;
      const accuracy = decided > 0 ? (correct / decided) * 100 : 0;
      const coverage =
        samples.length > 0 ? (decided / samples.length) * 100 : 0;

      console.log("\nEVENT MATCHING AI ACCURACY RESULTS (DeepSeek Flash)");
      console.log(`Total: ${samples.length}`);
      console.log(`Correct: ${correct}/${decided} (${accuracy.toFixed(1)}%)`);
      console.log(`Incorrect: ${incorrect}`);
      console.log(`Uncertain: ${uncertain}`);
      console.log(`Errors: ${errors}`);
      console.log(`Coverage: ${coverage.toFixed(1)}%`);
      printTable(results);

      expect(decided).toBeGreaterThan(0);
      expect(accuracy).toBeGreaterThanOrEqual(85);
    },
    LLM_TIMEOUT_MS * SAMPLE_SIZE + 60_000,
  );
});
