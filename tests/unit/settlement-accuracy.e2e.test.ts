/**
 * Bet Settlement AI Accuracy Test (DeepSeek Flash Only)
 *
 * Frontend-style reverse check:
 *   1. GET /api/ai-accuracy?kind=settlement&sampleSize=20
 *   2. POST /api/ai-search/verify-settlement for each sampled event
 *   3. POST /api/ai-accuracy with the AI score to simulate settlement
 *   4. Compare the simulated outcome against the historical outcome
 *
 * Run:
 *   BASE_URL=http://localhost:3000 npx vitest run tests/unit/settlement-accuracy.e2e.test.ts
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

type Outcome = "won" | "half_won" | "lost" | "half_lost" | "void" | "pending";

interface SettlementSample {
  id: string;
  eventId: string;
  match: {
    homeTeam: string;
    awayTeam: string;
    competition: string | null;
    startTime: string;
  };
  market: {
    marketType: string;
    timeScope: string;
    familyLine: number | null;
    atomId: string;
    atomLabel: string;
  };
  expectedOutcome: Outcome;
  actualOutcome: Outcome;
  actualScore: {
    ftHome: number;
    ftAway: number;
    htHome: number | null;
    htAway: number | null;
    source: string;
    confidence: number;
  };
  request: {
    endpoint: string;
    body: {
      event: {
        home_team: string;
        away_team: string;
        competition: string;
        start_time: string;
      };
      question: string;
    };
    searchQueries: string[];
  };
}

interface SamplesResponse {
  count: number;
  samples: SettlementSample[];
}

interface SettlementAiResponse {
  answer?: string;
  confidence?: number;
  model?: string;
  reasoning?: string;
  sources?: { url: string; title: string; snippet: string }[];
  error?: string;
}

interface OutcomeResponse {
  outcome?: Outcome;
  scopeScore?: string;
  reasoning?: string;
  reason?: string;
  error?: string;
}

interface ParsedScore {
  ftHome: number;
  ftAway: number;
  htHome?: number | null;
  htAway?: number | null;
}

interface TestResult {
  idx: number;
  request: string;
  expectedOutcome: Outcome;
  actualScore: string;
  response: string;
  aiScore: string;
  aiOutcome: string;
  rating: "exact" | "outcome" | "wrong" | "unresolved" | "error";
  confidence: number;
  model: string;
  sources: number;
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

function parseScore(text: string | undefined): ParsedScore | null {
  if (!text || text.trim().toUpperCase().startsWith("UNKNOWN")) return null;

  const ftSpecific = text.match(
    /(?:FT|full[-\s]*time)[^\d]*(\d+)\s*[-–—:]\s*(\d+)/i,
  );
  if (ftSpecific) {
    const ftHome = Number.parseInt(ftSpecific[1], 10);
    const ftAway = Number.parseInt(ftSpecific[2], 10);
    if (ftHome > 30 || ftAway > 30) return null;
    const htMatch = text.match(
      /(?:HT|half[-\s]*time)[:\s]*(\d+)\s*[-–—:]\s*(\d+)/i,
    );
    return {
      ftHome,
      ftAway,
      htHome: htMatch ? Number.parseInt(htMatch[1], 10) : null,
      htAway: htMatch ? Number.parseInt(htMatch[2], 10) : null,
    };
  }

  const scoreText = text.replace(
    /(?:HT|half[-\s]*time)[^\d]*(\d+)\s*[-–—:]\s*(\d+)/i,
    "",
  );
  const ftPatterns = [
    /(\d+)\s*[-–—:]\s*(\d+)/i,
    /(\d+)\s*x\s*(\d+)/i,
    /(\d+)\s+to\s+(\d+)/i,
  ];

  let ft: { home: number; away: number } | null = null;
  for (const pattern of ftPatterns) {
    const match = scoreText.match(pattern);
    if (!match) continue;
    const home = Number.parseInt(match[1], 10);
    const away = Number.parseInt(match[2], 10);
    if (
      Number.isInteger(home) &&
      Number.isInteger(away) &&
      home <= 30 &&
      away <= 30
    ) {
      ft = { home, away };
      break;
    }
  }
  if (!ft) return null;

  const htMatch = text.match(
    /(?:HT|half[-\s]*time)[:\s]*(\d+)\s*[-–—:]\s*(\d+)/i,
  );
  return {
    ftHome: ft.home,
    ftAway: ft.away,
    htHome: htMatch ? Number.parseInt(htMatch[1], 10) : null,
    htAway: htMatch ? Number.parseInt(htMatch[2], 10) : null,
  };
}

function compact(value: string, max = 42): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

function printTable(results: TestResult[]) {
  console.log(
    "| # | Request | Expected | Actual | Response | AI Score | AI Outcome | Rating | Conf | Model | Src |",
  );
  console.log(
    "|---|---------|----------|--------|----------|----------|------------|--------|------|-------|-----|",
  );
  for (const r of results) {
    console.log(
      `| ${r.idx} | ${compact(r.request)} | ${r.expectedOutcome} | ${r.actualScore} | ${compact(r.response)} | ${r.aiScore} | ${r.aiOutcome} | ${r.rating} | ${r.confidence} | ${compact(r.model, 22)} | ${r.sources} |`,
    );
  }
}

describe("Bet Settlement AI Accuracy (HTTP e2e)", () => {
  let servicesUp = false;
  let samples: SettlementSample[] = [];

  beforeAll(async () => {
    servicesUp = await isUp(`${BASE_URL}/api/ai-search/healthz`);
    if (!servicesUp) {
      console.warn(
        "[settlement-accuracy.e2e] Skipping because /api/ai-search/healthz is unavailable. Start `npm run dev` first.",
      );
      return;
    }

    const data = await getJson<SamplesResponse>(
      `/api/ai-accuracy?kind=settlement&sampleSize=${SAMPLE_SIZE}`,
      120_000,
    );
    samples = data.samples;
    console.log(
      `[settlement-accuracy.e2e] Loaded ${samples.length} HTTP samples`,
    );
  }, 150_000);

  it(
    `verifies ${SAMPLE_SIZE} historical settlements via DeepSeek`,
    async () => {
      if (!servicesUp || samples.length === 0) return;

      let exactScores = 0;
      let correctOutcomes = 0;
      let wrongOutcomes = 0;
      let unresolved = 0;
      let errors = 0;
      const results: TestResult[] = [];

      for (let idx = 0; idx < samples.length; idx++) {
        const sample = samples[idx];
        let response = "ERROR";
        let aiScore = "unresolved";
        let aiOutcome = "UNRESOLVED";
        let rating: TestResult["rating"] = "error";
        let confidence = 0;
        let model = "";
        let sources = 0;

        try {
          const { status, body } =
            await postJsonWithRetry<SettlementAiResponse>(
              sample.request.endpoint,
              sample.request.body,
              LLM_TIMEOUT_MS,
            );

          if (status !== 200 || body.answer == null) {
            errors++;
            response = body.error ?? `HTTP ${status}`;
          } else {
            response = `${body.answer} ${body.reasoning ?? ""}`;
            confidence = body.confidence ?? 0;
            model = body.model ?? "";
            sources = body.sources?.length ?? 0;

            expect(model.toLowerCase()).toContain("deepseek");
            expect(model.toLowerCase()).not.toContain("gemini");

            const parsed =
              parseScore(body.answer) ?? parseScore(body.reasoning);
            if (!parsed) {
              unresolved++;
              rating = "unresolved";
            } else {
              aiScore = `${parsed.ftHome}-${parsed.ftAway}`;
              const outcomeRes = await postJson<OutcomeResponse>(
                "/api/ai-accuracy",
                {
                  action: "settlement-outcome",
                  betId: sample.id,
                  score: parsed,
                },
                30_000,
              );

              if (outcomeRes.status !== 200 || !outcomeRes.body.outcome) {
                errors++;
                rating = "error";
                aiOutcome =
                  outcomeRes.body.error ?? `HTTP ${outcomeRes.status}`;
              } else {
                aiOutcome = outcomeRes.body.outcome;
                const exactScore =
                  parsed.ftHome === sample.actualScore.ftHome &&
                  parsed.ftAway === sample.actualScore.ftAway;
                const outcomeMatch =
                  outcomeRes.body.outcome === sample.expectedOutcome;

                if (exactScore) exactScores++;
                if (outcomeMatch) correctOutcomes++;
                else wrongOutcomes++;

                rating = exactScore
                  ? "exact"
                  : outcomeMatch
                    ? "outcome"
                    : "wrong";
              }
            }
          }
        } catch (err) {
          errors++;
          response = (err as Error).message;
        }

        const actualScore = `${sample.actualScore.ftHome}-${sample.actualScore.ftAway}`;
        results.push({
          idx: idx + 1,
          request: `${sample.match.homeTeam} vs ${sample.match.awayTeam} | ${sample.request.searchQueries[0] ?? ""}`,
          expectedOutcome: sample.expectedOutcome,
          actualScore,
          response,
          aiScore,
          aiOutcome,
          rating,
          confidence,
          model,
          sources,
        });

        console.log(
          `[${idx + 1}/${samples.length}] ${sample.match.homeTeam} vs ${sample.match.awayTeam} actual ${actualScore} -> ${rating} (${confidence}%)`,
        );
      }

      const resolved = correctOutcomes + wrongOutcomes;
      const scoreAccuracy = resolved > 0 ? (exactScores / resolved) * 100 : 0;
      const outcomeAccuracy =
        resolved > 0 ? (correctOutcomes / resolved) * 100 : 0;
      const resolutionRate =
        samples.length > 0 ? (resolved / samples.length) * 100 : 0;

      console.log("\nBET SETTLEMENT AI ACCURACY RESULTS (DeepSeek Flash)");
      console.log(`Total: ${samples.length}`);
      console.log(`Resolved: ${resolved} (${resolutionRate.toFixed(1)}%)`);
      console.log(
        `Exact score: ${exactScores}/${resolved} (${scoreAccuracy.toFixed(1)}%)`,
      );
      console.log(
        `Outcome correct: ${correctOutcomes}/${resolved} (${outcomeAccuracy.toFixed(1)}%)`,
      );
      console.log(`Wrong outcomes: ${wrongOutcomes}`);
      console.log(`Unresolved: ${unresolved}`);
      console.log(`Errors: ${errors}`);
      printTable(results);

      expect(resolved).toBeGreaterThan(0);
      expect(outcomeAccuracy).toBeGreaterThanOrEqual(90);
    },
    LLM_TIMEOUT_MS * SAMPLE_SIZE + 60_000,
  );
});
