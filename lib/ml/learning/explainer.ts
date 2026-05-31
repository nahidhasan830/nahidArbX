import crypto from "node:crypto";
import OpenAI from "openai";
import type { ChatCompletion } from "openai/resources/chat/completions";
import { logAiActivity } from "@/lib/ai/activity-logger";
import {
  getLearningExplanation,
  upsertLearningExplanation,
} from "@/lib/db/repositories/ml-learning";
import type {
  LearningExplanationContent,
  LearningExplanationResponse,
  LearningSnapshotResponse,
} from "./types";

type ExplainOptions = {
  modelTier?: "flash" | "pro";
  force?: boolean;
  explanationType?: string;
};

type DeepSeekChatResponse = ChatCompletion;

const DEEPSEEK_MAX_OUTPUT_TOKENS = 4096;

function getDeepSeekClient(): OpenAI {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not configured");
  return new OpenAI({ baseURL: "https://api.deepseek.com", apiKey });
}

function resolveDeepSeekModel(tier: "flash" | "pro"): string {
  if (tier === "pro") {
    return process.env.DEEPSEEK_PRO_MODEL || "deepseek-v4-pro";
  }
  return process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
}

function providerName(model: string): string {
  return model.includes("pro") ? "deepseek-pro" : "deepseek-flash";
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function compactSnapshot(snapshot: LearningSnapshotResponse) {
  const m = snapshot.metrics;
  return {
    snapshotHash: snapshot.snapshotHash,
    createdAt: snapshot.createdAt,
    modelVersion: snapshot.modelVersion,
    verdict: m.verdict,
    counts: m.counts,
    quality: m.quality,
    cohorts: m.cohorts,
    scoreBuckets: m.scoreBuckets,
    calibrationBuckets: m.calibrationBuckets.filter(
      (bucket) => bucket.count > 0,
    ),
    modelHistory: m.modelHistory.slice(-8),
    featureImportance: m.featureImportance.slice(0, 10),
    notes: m.notes,
  };
}

const SYSTEM_PROMPT = `You are the ML learning reviewer for a sports value-betting optimizer.

You explain whether the model is learning from previous records. The deterministic verdict is already computed by metrics; do not override it. Explain the evidence in practical operator language.

Rules:
- Be specific and cite counts, ROI lift, calibration, buckets, and model versions when relevant.
- Treat settled shadow-scored predictions as the current primary evidence because there are no real placed bets yet.
- Mention uncertainty when samples are small or pending settlement is high.
- Do not suggest automated settlement AI.
- Do not invent numbers.
- Return strict JSON only.`;

function buildPrompt(snapshot: LearningSnapshotResponse): string {
  return `ML_LEARNING_SNAPSHOT:\n${JSON.stringify(compactSnapshot(snapshot), null, 2)}\n\nReturn JSON with keys: summary, verdict, whatImproved, whatRegressed, risks, nextActions, mentalModel. Arrays should contain 3-6 short strings.`;
}

function fallbackContent(
  snapshot: LearningSnapshotResponse,
): LearningExplanationContent {
  const m = snapshot.metrics;
  return {
    summary: `${m.verdict.label}: ${m.verdict.reason}`,
    verdict: m.verdict.label,
    whatImproved:
      m.quality.roiLiftPct != null && m.quality.roiLiftPct > 0
        ? [
            `ML gate is ahead of simple EV by ${m.quality.roiLiftPct.toFixed(2)} ROI points.`,
          ]
        : [],
    whatRegressed:
      m.quality.roiLiftPct != null && m.quality.roiLiftPct <= 0
        ? ["ML gate is not ahead of the simple EV baseline yet."]
        : [],
    risks: m.verdict.blockers,
    nextActions: [
      "Let more shadow-scored predictions settle.",
      "Compare high-score bucket ROI against low-score bucket ROI.",
      "Review top feature importance for drift or dominance.",
    ],
    mentalModel:
      "Every settled prediction is a test question. If high-score rows settle better than low-score rows and beat the simple EV rule, the model is learning.",
  };
}

function parseContent(
  raw: string,
  snapshot: LearningSnapshotResponse,
): LearningExplanationContent {
  try {
    const parsed = JSON.parse(raw) as Partial<LearningExplanationContent>;
    return {
      summary: String(parsed.summary || fallbackContent(snapshot).summary),
      verdict: String(parsed.verdict || snapshot.metrics.verdict.label),
      whatImproved: Array.isArray(parsed.whatImproved)
        ? parsed.whatImproved.map(String).slice(0, 6)
        : [],
      whatRegressed: Array.isArray(parsed.whatRegressed)
        ? parsed.whatRegressed.map(String).slice(0, 6)
        : [],
      risks: Array.isArray(parsed.risks)
        ? parsed.risks.map(String).slice(0, 6)
        : snapshot.metrics.verdict.blockers,
      nextActions: Array.isArray(parsed.nextActions)
        ? parsed.nextActions.map(String).slice(0, 6)
        : fallbackContent(snapshot).nextActions,
      mentalModel: String(
        parsed.mentalModel || fallbackContent(snapshot).mentalModel,
      ),
    };
  } catch {
    return fallbackContent(snapshot);
  }
}

export async function explainLearningSnapshot(
  snapshot: LearningSnapshotResponse,
  options: ExplainOptions = {},
): Promise<LearningExplanationResponse> {
  const explanationType = options.explanationType ?? "operator";
  const model = resolveDeepSeekModel(options.modelTier ?? "flash");
  const cached = !options.force
    ? await getLearningExplanation({
        snapshotHash: snapshot.snapshotHash,
        explanationType,
        model,
      })
    : null;
  if (cached) return cached;

  const prompt = buildPrompt(snapshot);
  const promptHash = hash(`${SYSTEM_PROMPT}\n${prompt}`);
  const provider = providerName(model);
  const client = getDeepSeekClient();

  const response = await logAiActivity(
    {
      system: "llm",
      provider,
      endpoint: "ml-learning-explain",
      trigger: options.force ? "manual" : "auto",
      model,
      query: `ML learning snapshot ${snapshot.snapshotHash.slice(0, 12)}`,
      itemCount: snapshot.metrics.counts.settledPredictions,
      request: { systemPrompt: SYSTEM_PROMPT, prompt },
      response: (result: unknown) => {
        const r = result as DeepSeekChatResponse;
        return { content: r.choices[0]?.message?.content ?? "" };
      },
      metadata: {
        snapshotHash: snapshot.snapshotHash,
        verdict: snapshot.verdict,
      },
    },
    async () => {
      const result = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        max_tokens: DEEPSEEK_MAX_OUTPUT_TOKENS,
        response_format: { type: "json_object" },
      });
      return result as ChatCompletion;
    },
  );

  const raw = response.choices[0]?.message?.content || "{}";
  const content = parseContent(raw, snapshot);
  return upsertLearningExplanation({
    snapshotHash: snapshot.snapshotHash,
    explanationType,
    provider,
    model,
    status: "success",
    summary: content.summary,
    content,
    promptHash,
    generatedAt: new Date().toISOString(),
  });
}
