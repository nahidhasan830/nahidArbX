
import { GoogleGenAI, Type } from "@google/genai";
import { logger } from "../shared/logger";

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

const PRO_MODEL = process.env.GEMINI_PRO_MODEL || "gemini-3.1-pro-preview";


export type SliceSummary = {
  label: string;
  dimensions: Record<string, string>;
  n: number;
  wins: number;
  losses: number;
  roiPct: number | null;
  shrunkRoiPct: number | null;
  clvPct: number | null;
  avgEvPct: number;
  z: number | null;
  pAdj: number | null;
};

export type HeadlineStats = {
  totalRows: number;
  settledRows: number;
  winRatePct: number | null;
  flatRoiPct: number | null;
  meanClvPct: number | null;
  beatCloseRatePct: number | null;
  brier: number | null;
};

export type ProposeInput = {
  topSlices: SliceSummary[];
  headline: HeadlineStats;
  maxRules?: number;
};

export type ProposedRule = {
  ruleId: string;
  rationale: string;
  filters: {
    marketTypes?: string[];
    softProviders?: string[];
    minEv?: number;
    maxEv?: number;
    tickMin?: number;
    oddsMin?: number;
    oddsMax?: number;
    timeScope?: string;
    competition?: string;
    atomId?: string;
  };
  stakeMultiplier: number;
  expectedEdgePct: number;
  confidence: "low" | "medium" | "high";
  knownRisks: string[];
};

export type ProposeResult = {
  rules: ProposedRule[];
  model: string;
};


const FILTER_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    marketTypes: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        "Exact marketType values like MATCH_RESULT, TOTAL_GOALS, OVER_UNDER, BTTS, ASIAN_HANDICAP, EUROPEAN_HANDICAP, DNB, DOUBLE_CHANCE.",
    },
    softProviders: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        "Exact softProvider values from the data: ninewickets-exchange, ninewickets-sportsbook, betconstruct.",
    },
    minEv: {
      type: Type.NUMBER,
      description: "Minimum EV% to include (optional).",
    },
    maxEv: {
      type: Type.NUMBER,
      description: "Maximum EV% to include (optional).",
    },
    tickMin: {
      type: Type.INTEGER,
      description: "Minimum tick_count — filter out unstable one-tick blips.",
    },
    oddsMin: {
      type: Type.NUMBER,
      description: "Minimum soft_odds_max.",
    },
    oddsMax: {
      type: Type.NUMBER,
      description: "Maximum soft_odds_max.",
    },
    timeScope: {
      type: Type.STRING,
      description:
        "FT / 1H / 2H. Only set if the slice showed a clear scope pattern.",
    },
    competition: {
      type: Type.STRING,
      description: "Only set if a specific competition drove the edge.",
    },
    atomId: {
      type: Type.STRING,
      description: "Specific atom id (e.g. 'home', 'ft_total_over_2_5').",
    },
  },
};

const RULE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    ruleId: {
      type: Type.STRING,
      description: "Short snake_case identifier.",
    },
    rationale: {
      type: Type.STRING,
      description:
        "2-4 sentences on which slice(s) this rule came from, what the numbers say, and why this could be a real edge rather than noise.",
    },
    filters: FILTER_SCHEMA,
    stakeMultiplier: {
      type: Type.NUMBER,
      description:
        "Multiplier over the baseline Kelly stake. 1.0 = baseline. Use 1.25-1.5 for strong signals, 0.5-0.75 to reduce exposure on weak ones. Never above 2.0.",
    },
    expectedEdgePct: {
      type: Type.NUMBER,
      description:
        "Your best estimate of the rule's edge (CLV% or ROI%), tempered by the sample size and p-value.",
    },
    confidence: {
      type: Type.STRING,
      enum: ["low", "medium", "high"],
      description:
        "low if N<200 or pAdj>0.05, medium if N 200-500, high if N>500 and pAdj<0.01.",
    },
    knownRisks: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        "Specific failure modes — sample size, market regime change, data-snooping, etc.",
    },
  },
  propertyOrdering: [
    "ruleId",
    "rationale",
    "filters",
    "stakeMultiplier",
    "expectedEdgePct",
    "confidence",
    "knownRisks",
  ],
  required: [
    "ruleId",
    "rationale",
    "filters",
    "stakeMultiplier",
    "expectedEdgePct",
    "confidence",
    "knownRisks",
  ],
};

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    rules: {
      type: Type.ARRAY,
      items: RULE_SCHEMA,
    },
  },
  required: ["rules"],
};


const SYSTEM_INSTRUCTION = `You are a sports-betting quant reviewing a backtest. The user has already computed every metric — ROI, CLV, win rate, z-score, Bayesian-shrunk ROI, Benjamini-Hochberg FDR-adjusted p-value — for every slice of their bet data. Your job is to PROPOSE candidate trading rules based on those numbers.

You are NOT allowed to compute or guess metrics yourself. Use only the numbers in the input. If a slice has small N or a non-significant adjusted p-value, say so in your rationale and lower the confidence.

What to look for:
- Slices where shrunk_ROI is positive AND pAdj < 0.05 AND N >= 100 — strongest candidates.
- Slices where CLV is positive (>2%) even if ROI is still noisy — CLV is a leading indicator of long-run profitability and is valid even at small N.
- Patterns ACROSS multiple slices (e.g. a specific market type being consistently +CLV across provider × EV buckets).
- Risk flags: tiny samples, extreme outliers, non-significant p-values, slices that look like data-snooping artefacts.

When building filters, ONLY use the dimensions that appear in the input slices. Do not invent constraints that the backtest cannot test. Combine dimensions (market + EV bucket + tick count) when the evidence warrants.

Return 3-7 distinct, NON-OVERLAPPING rules. Each rule should target a specific edge that can be independently re-tested on held-out data.

Be sceptical. If the data doesn't clearly support profitable rules, return fewer (even zero) and flag the lack of edge in the first rule's rationale.`;


export async function proposeRules(
  input: ProposeInput,
): Promise<ProposeResult> {
  const maxRules = Math.min(10, Math.max(1, input.maxRules ?? 5));

  const headlineLines = [
    `Total bets: ${input.headline.totalRows}`,
    `Settled: ${input.headline.settledRows}`,
    `Win rate: ${input.headline.winRatePct?.toFixed(1) ?? "—"}%`,
    `Flat ROI: ${input.headline.flatRoiPct?.toFixed(1) ?? "—"}%`,
    `Mean CLV: ${input.headline.meanClvPct?.toFixed(2) ?? "—"}%`,
    `Beat-close rate: ${input.headline.beatCloseRatePct?.toFixed(1) ?? "—"}%`,
    `Brier: ${input.headline.brier?.toFixed(3) ?? "—"}`,
  ].join("\n");

  const sliceLines = input.topSlices
    .map((s, i) => {
      const dimStr = Object.entries(s.dimensions)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      return `#${i + 1} ${s.label} (${dimStr}): N=${s.n}, ${s.wins}W/${s.losses}L, ROI=${s.roiPct?.toFixed(1) ?? "—"}%, shrunk-ROI=${s.shrunkRoiPct?.toFixed(1) ?? "—"}%, CLV=${s.clvPct?.toFixed(2) ?? "—"}%, avgEV=${s.avgEvPct.toFixed(1)}%, z=${s.z?.toFixed(2) ?? "—"}, pAdj=${s.pAdj == null ? "—" : s.pAdj < 0.001 ? "<0.001" : s.pAdj.toFixed(3)}`;
    })
    .join("\n");

  const prompt = `Here are the precomputed stats from the user's backtest.

HEADLINE:
${headlineLines}

TOP SLICES (already ranked by z × sqrt(N) × shrunk_ROI):
${sliceLines}

Propose up to ${maxRules} trading rules based on this data. Return JSON matching the schema.`;

  const res = await getClient().models.generateContent({
    model: PRO_MODEL,
    contents: prompt,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseJsonSchema: RESPONSE_SCHEMA,
      temperature: 0.2,
    },
  });

  const text = res.text;
  if (!text) {
    throw new Error("Gemini returned an empty response");
  }

  let parsed: { rules: ProposedRule[] };
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    logger.error("ProposeRules", `Failed to parse JSON: ${text.slice(0, 200)}`);
    throw new Error(`Gemini returned non-JSON: ${(err as Error).message}`);
  }

  if (!Array.isArray(parsed.rules)) {
    throw new Error("Gemini response missing rules array");
  }

  const cleaned: ProposedRule[] = parsed.rules.map((r) => ({
    ...r,
    stakeMultiplier: Math.min(2, Math.max(0.25, r.stakeMultiplier ?? 1)),
    expectedEdgePct: Number.isFinite(r.expectedEdgePct) ? r.expectedEdgePct : 0,
    knownRisks: Array.isArray(r.knownRisks) ? r.knownRisks : [],
  }));

  return { rules: cleaned, model: PRO_MODEL };
}
