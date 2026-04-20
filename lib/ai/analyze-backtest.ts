import { GoogleGenAI, Type } from "@google/genai";
import { logger } from "../shared/logger";
import type { ModelTier } from "./models";
import type { ValueBetRow } from "../db/schema";

export type BacktestAnalysis = {
  summary: string;
  patterns: string[];
  concerns: string[];
  recommendations: string[];
  by_market: {
    market: string;
    total: number;
    wins: number;
    losses: number;
    voids: number;
    pending: number;
  }[];
  model: string;
};

const FLASH_MODEL =
  process.env.GEMINI_DEFAULT_MODEL || "gemini-3-flash-preview";
const PRO_MODEL = process.env.GEMINI_PRO_MODEL || "gemini-3.1-pro-preview";

let client: GoogleGenAI | null = null;
const getClient = (): GoogleGenAI => {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    client = new GoogleGenAI({ apiKey });
  }
  return client;
};

const resolveModel = (tier: ModelTier | string | undefined): string => {
  if (!tier || tier === "flash") return FLASH_MODEL;
  if (tier === "pro") return PRO_MODEL;
  return tier;
};

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: {
      type: Type.STRING,
      description:
        "2-4 sentence overview of how this selection of bets performed. Must be specific (mention counts, strategy implications).",
    },
    patterns: {
      type: Type.ARRAY,
      description:
        "Up to 5 observations — e.g. which markets/providers/EV ranges over- or under-performed.",
      items: { type: Type.STRING },
    },
    concerns: {
      type: Type.ARRAY,
      description:
        "Up to 5 data-quality or strategy risks (small sample, stale lines, provider concentration, unsettled volume, etc.).",
      items: { type: Type.STRING },
    },
    recommendations: {
      type: Type.ARRAY,
      description:
        "Up to 5 concrete next steps the user should take — filters to try, phases to prioritize, or bets to investigate.",
      items: { type: Type.STRING },
    },
    by_market: {
      type: Type.ARRAY,
      description: "Per-market breakdown of counts.",
      items: {
        type: Type.OBJECT,
        properties: {
          market: { type: Type.STRING },
          total: { type: Type.INTEGER },
          wins: { type: Type.INTEGER },
          losses: { type: Type.INTEGER },
          voids: { type: Type.INTEGER },
          pending: { type: Type.INTEGER },
        },
        required: ["market", "total", "wins", "losses", "voids", "pending"],
        propertyOrdering: [
          "market",
          "total",
          "wins",
          "losses",
          "voids",
          "pending",
        ],
      },
    },
  },
  propertyOrdering: [
    "summary",
    "patterns",
    "concerns",
    "recommendations",
    "by_market",
  ],
  required: ["summary", "patterns", "concerns", "recommendations", "by_market"],
};

const SYSTEM_INSTRUCTION = `You are a value-betting backtest analyst. You receive a batch of bets (potentially mixed settled + pending) and produce an honest assessment: what worked, what didn't, what's missing.

Ground rules:
- Be specific — cite counts, markets, providers. Never give generic advice like "bet responsibly".
- Flag small-sample concerns if settled bets < 30 per slice.
- If most bets are unsettled, say so and resist PnL conclusions.
- Outcomes: "won"/"lost" are full wins/losses. "half_won"/"half_lost" are Asian quarter-line splits (half the stake resolved, the other half pushed) — count them as 0.5 wins / 0.5 losses in any derived W-L stat. "void" is no-decision (stake returned).
- EV is the expected-value percentage at detection time. Higher ev_pct_max means the soft line drifted further from the sharp line.
- Do NOT invent numbers — only report counts you can compute from the input.`;

type CompactBet = {
  id: string;
  market: string;
  scope: string;
  provider: string;
  sharp_odds: number;
  soft_odds_first: number;
  soft_odds_max: number;
  commission_pct: number;
  sharp_true_prob: number;
  first_seen_at: string;
  event_start_time: string;
  tick_count: number;
  outcome: string;
};

const compactify = (row: ValueBetRow): CompactBet => ({
  id: row.id,
  market: `${row.marketType}${row.familyLine != null ? ` ${row.familyLine}` : ""} / ${row.atomLabel}`,
  scope: row.timeScope,
  provider: row.softProvider,
  sharp_odds: row.sharpOdds,
  soft_odds_first: row.softOddsFirst,
  soft_odds_max: row.softOddsMax,
  commission_pct: row.softCommissionPct,
  sharp_true_prob: row.sharpTrueProb,
  first_seen_at: row.firstSeenAt,
  event_start_time: row.eventStartTime,
  tick_count: row.tickCount,
  outcome: row.outcome,
});

export const analyzeBacktest = async (
  rows: ValueBetRow[],
  options?: { model?: ModelTier | string },
): Promise<BacktestAnalysis> => {
  const modelName = resolveModel(options?.model);
  const bets = rows.map(compactify);
  const prompt = `BETS (${bets.length} total):\n${JSON.stringify(bets, null, 0)}\n\nProduce the JSON analysis.`;

  const res = await getClient().models.generateContent({
    model: modelName,
    contents: prompt,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseJsonSchema: RESPONSE_SCHEMA,
      temperature: 0.2,
    },
  });

  const text = res.text;
  if (!text) throw new Error("Gemini returned empty response");
  let parsed: Omit<BacktestAnalysis, "model">;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    logger.error("AnalyzeBacktest", `Bad JSON: ${text.slice(0, 200)}`);
    throw new Error(`Gemini returned invalid JSON: ${(err as Error).message}`);
  }
  return { ...parsed, model: modelName };
};
