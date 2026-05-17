/**
 * Gemini client — single source of truth for AI-assisted event matching.
 *
 * Wraps the official `@google/genai` SDK. Callers pass two events and get
 * back a verdict (SAME / DIFFERENT / UNCERTAIN) with confidence. The client
 * uses the SDK's structured-JSON mode so the response is guaranteed-parseable
 * — no regex fallbacks.
 */

import { GoogleGenAI, Type } from "@google/genai";
import { logger } from "../shared/logger";
import { eventPromptLine } from "../formatting/event-label";
import type { ModelTier } from "./models";
import { logAiActivity } from "./activity-logger";
import { recordAiActivity } from "../db/repositories/ai-activity-log";

export type { ModelTier } from "./models";
export type Verdict = "SAME" | "DIFFERENT" | "UNCERTAIN";

export interface GeminiResult {
  decision: Verdict;
  confidence: number;
  model: string;
}

export interface EventLike {
  homeTeam: string;
  awayTeam: string;
  competition: string;
  startTime: Date | string;
}

// Lite is the app-wide default — cheapest, fine for short factual prompts
// (score extraction, alias confirmations). Flash and Pro are opt-in.
const LITE_MODEL =
  process.env.GEMINI_LITE_MODEL ||
  process.env.GEMINI_DEFAULT_MODEL ||
  "gemini-3.1-flash-lite";
const FLASH_MODEL = process.env.GEMINI_FLASH_MODEL || "gemini-3-flash";
const PRO_MODEL = process.env.GEMINI_PRO_MODEL || "gemini-3.1-pro";

/** Lazy singleton so import-time has no side effects and unit tests that
 * stub `process.env.GEMINI_API_KEY` before first call work as expected. */
let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "GEMINI_API_KEY is not set — add it to your environment.",
      );
    }
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    decision: {
      type: Type.STRING,
      enum: ["SAME", "DIFFERENT", "UNCERTAIN"],
      description: "Your verdict on whether the two fixtures are the same.",
    },
    confidence: {
      type: Type.INTEGER,
      description: "Confidence 0-100. Use 40-60 when UNCERTAIN.",
    },
  },
  propertyOrdering: ["decision", "confidence"],
  required: ["decision", "confidence"],
};

const SYSTEM_INSTRUCTION = `You decide whether two sports fixtures from different betting providers refer to the SAME real-world football match.

CRITICAL RULES — read carefully:
1. TIER MUST MATCH on both sides. Never merge senior with U21/U23/U20/reserves/women/B teams/youth. If one fixture has "U21", "U23", "U20", "Women", "W", "B", "Reserves", "Youth" and the other does NOT → they are DIFFERENT matches.
2. COUNTRY must match for club teams. "Zenit" (Russia) vs "Zenit" (Serbia) are DIFFERENT clubs. Use your knowledge to verify country/league affiliations.
3. Team names vary: abbreviations ("Man Utd" = "Manchester United"), city drops ("Zenit" = "Zenit Saint Petersburg"), transliterations (Cyrillic/Greek/Vietnamese/Arabic), translations. Treat as the same team unless you are confident they are different clubs.
4. League names vary and this alone is NOT a reason to say DIFFERENT:
   - Renamings: "Liga de Ascenso" = "Liga de Expansión MX" (renamed 2020). "Segunda División B" = "Primera Federación" (Spain, renamed 2021).
   - Country prefix is usually optional: "Primera División" ≈ "Paraguayan Primera División".
   - Translations are the same league: "Campeonato Brasileiro" = "Brazilian Championship".
5. Kickoff within 15 minutes is strong evidence of SAME. Kickoff difference >2 hours is strong evidence of DIFFERENT (unless explicitly a rescheduled match).
6. If teams and kickoff match but league names differ only in spelling/translation/renaming, lean SAME.
7. Cup vs League: A team can play in both a league and a cup on different dates. Same teams + different dates + different competitions → DIFFERENT matches.
8. National teams: Country name variations ("USA" = "United States" = "USMNT") are SAME. But "USA U20" vs "USA" are DIFFERENT.

COMMON TRAPS:
- "Athletic Bilbao" vs "Athletic Club" = SAME (Basque naming variation)
- "Inter" vs "Internazionale" = SAME (abbreviation)
- "PSG" vs "Paris Saint-Germain" = SAME
- "Milan" vs "AC Milan" = SAME
- "Borussia Dortmund" vs "Borussia Mönchengladbach" = DIFFERENT (different clubs)
- "RB Leipzig" vs "RB Salzburg" = DIFFERENT (different clubs, different countries)
- "Ajax" (Netherlands) vs "Ajax" (South Africa) = DIFFERENT

If genuinely unsure, return UNCERTAIN with confidence 40-60. Do not default to DIFFERENT.`;

function resolveModel(tier: ModelTier | string | undefined): string {
  if (!tier || tier === "lite") return LITE_MODEL;
  if (tier === "flash") return FLASH_MODEL;
  if (tier === "pro") return PRO_MODEL;
  return tier;
}

/**
 * Ask Gemini whether two fixtures are the same real-world event.
 * Throws on API/auth errors so callers can surface them instead of caching
 * a bogus verdict.
 */
export async function analyzeMatchWithGemini(
  eventA: EventLike,
  eventB: EventLike,
  options?: { model?: ModelTier | string },
): Promise<GeminiResult> {
  const t0 = Date.now();
  const modelName = resolveModel(options?.model);
  const pairLabel = `${eventA.homeTeam} v ${eventA.awayTeam} vs ${eventB.homeTeam} v ${eventB.awayTeam}`;

  try {
    const prompt = `A: ${eventPromptLine(eventA)}\nB: ${eventPromptLine(eventB)}`;

    let responseText = "";
    const res = await logAiActivity(
      {
        system: "llm",
        provider: "gemini-lite",
        endpoint: "entity-match",
        model: modelName,
        itemCount: 1,
        response: { promptLength: prompt.length },
      },
      async () => {
        const r = await getClient().models.generateContent({
          model: modelName,
          contents: prompt,
          config: {
            systemInstruction: SYSTEM_INSTRUCTION,
            responseMimeType: "application/json",
            responseJsonSchema: RESPONSE_SCHEMA,
            temperature: 0.1,
          },
        });
        responseText = r.text || "";
        return r;
      },
    );

    const text = res.text;
    if (!text) {
      throw new Error("Gemini returned an empty response");
    }

    let parsed: { decision: string; confidence: number };
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      logger.error("Gemini", `Failed to parse JSON: ${text.slice(0, 200)}`);
      throw new Error(`Gemini returned non-JSON: ${(err as Error).message}`);
    }

    const decision = ["SAME", "DIFFERENT", "UNCERTAIN"].includes(
      parsed.decision,
    )
      ? (parsed.decision as Verdict)
      : "UNCERTAIN";

    const result: GeminiResult = {
      decision,
      confidence: Math.max(0, Math.min(100, Math.round(parsed.confidence))),
      model: modelName,
    };

    const durationMs = Date.now() - t0;
    recordAiActivity({
      system: "entity-match",
      trigger: "manual",
      status: "success",
      model: modelName,
      itemCount: 1,
      durationMs,
      costUsd: null,
      summary: `Gemini verify: ${result.decision} ${result.confidence}% \u2014 ${pairLabel}`,
      error: null,
      metadata: { decision: result.decision, confidence: result.confidence },
    }).catch(() => {});

    return result;
  } catch (err) {
    const durationMs = Date.now() - t0;
    recordAiActivity({
      system: "entity-match",
      trigger: "manual",
      status: "error",
      model: modelName,
      itemCount: 1,
      durationMs,
      costUsd: null,
      summary: `Gemini verify failed \u2014 ${pairLabel}`,
      error: (err as Error).message,
      metadata: null,
    }).catch(() => {});

    throw err;
  }
}

/**
 * Build a Google AI-mode search URL for a pair. Useful in the review UI so
 * humans can double-check Gemini's verdict with grounded web results.
 */
export function buildHumanSearchUrl(
  eventA: EventLike,
  eventB: EventLike,
): string {
  const iso = new Date(eventA.startTime).toISOString();
  const query =
    `Are "${eventA.homeTeam}" vs "${eventA.awayTeam}" (${eventA.competition}) & ` +
    `"${eventB.homeTeam}" vs "${eventB.awayTeam}" (${eventB.competition}) the exact same match on ` +
    `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC? ` +
    `Explain step-by-step (verify tier, division, kickoff). ` +
    `End with a line containing exactly YES or NO.`;

  const params = new URLSearchParams({
    q: query,
    udm: "50",
    aep: "1",
    hl: "en",
  });
  return `https://www.google.com/search?${params.toString()}`;
}

/**
 * Build a Google AI-mode search URL for entity resolution — verifying
 * whether a surface form is the same team/competition as a canonical.
 */
export function buildEntitySearchUrl(
  surface: string,
  canonical: string,
  competition?: string | null,
): string {
  const comp = competition ? ` in ${competition}` : "";
  const query =
    `Is "${surface}" the same team as "${canonical}"${comp}? ` +
    `Check official league rosters, aliases, and transliterations. ` +
    `End with a line containing exactly YES or NO.`;

  const params = new URLSearchParams({
    q: query,
    udm: "50",
    aep: "1",
    hl: "en",
  });
  return `https://www.google.com/search?${params.toString()}`;
}
