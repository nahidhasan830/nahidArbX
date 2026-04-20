/**
 * Gemini client — single source of truth for AI-assisted event matching.
 *
 * Wraps the official `@google/genai` SDK. Callers pass two events and get
 * back a verdict (SAME / DIFFERENT / UNCERTAIN) with confidence and reasoning.
 * The client uses the SDK's structured-JSON mode so the response is
 * guaranteed-parseable — no regex fallbacks.
 */

import { GoogleGenAI, Type } from "@google/genai";
import { logger } from "../shared/logger";
import { eventPromptLine } from "../formatting/event-label";
import type { ModelTier } from "./models";

export type { ModelTier } from "./models";
export type Verdict = "SAME" | "DIFFERENT" | "UNCERTAIN";

export interface GeminiResult {
  decision: Verdict;
  confidence: number;
  reasoning: string;
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
  "gemini-3.1-flash-lite-preview";
const FLASH_MODEL = process.env.GEMINI_FLASH_MODEL || "gemini-3-flash-preview";
const PRO_MODEL = process.env.GEMINI_PRO_MODEL || "gemini-3.1-pro-preview";

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
    reasoning: {
      type: Type.STRING,
      description: "One or two sentences explaining the verdict.",
    },
  },
  propertyOrdering: ["reasoning", "decision", "confidence"],
  required: ["decision", "confidence", "reasoning"],
};

const SYSTEM_INSTRUCTION = `You decide whether two sports fixtures from different betting providers refer to the SAME real-world event.

Rules:
1. Tier must match on both sides — never merge senior with U21/U23/reserves/women/B teams.
2. Team names vary: abbreviations ("Man Utd" = "Manchester United"), city drops ("Zenit" = "Zenit Saint Petersburg"), transliterations, translations. Treat as the same team unless you are confident they are different clubs.
3. League names vary and this alone is NOT a reason to say DIFFERENT:
   - Renamings: "Liga de Ascenso" = "Liga de Expansión MX" (renamed 2020). "Segunda División B" = "Primera Federación" (Spain, renamed 2021).
   - Country prefix is usually optional: "Primera División" ≈ "Paraguayan Primera División".
   - Translations are the same league: "Campeonato Brasileiro" = "Brazilian Championship".
4. Kickoff within 15 minutes is strong evidence of SAME.
5. If teams and kickoff match but league names differ only in spelling/translation/renaming, lean SAME.
6. If genuinely unsure, return UNCERTAIN with confidence 40-60. Do not default to DIFFERENT.`;

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
  const modelName = resolveModel(options?.model);
  const prompt = `A: ${eventPromptLine(eventA)}\nB: ${eventPromptLine(eventB)}`;

  const res = await getClient().models.generateContent({
    model: modelName,
    contents: prompt,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseJsonSchema: RESPONSE_SCHEMA,
      temperature: 0.1,
    },
  });

  const text = res.text;
  if (!text) {
    throw new Error("Gemini returned an empty response");
  }

  let parsed: { decision: string; confidence: number; reasoning: string };
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    logger.error("Gemini", `Failed to parse JSON: ${text.slice(0, 200)}`);
    throw new Error(`Gemini returned non-JSON: ${(err as Error).message}`);
  }

  const decision = ["SAME", "DIFFERENT", "UNCERTAIN"].includes(parsed.decision)
    ? (parsed.decision as Verdict)
    : "UNCERTAIN";

  return {
    decision,
    confidence: Math.max(0, Math.min(100, Math.round(parsed.confidence))),
    reasoning: parsed.reasoning?.trim() || "",
    model: modelName,
  };
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
