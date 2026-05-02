/**
 * HuggingFace Router client — OpenAI-compatible.
 *
 * Used by:
 * - AI Search Playground (model selector dropdown)
 * - Manual entity verification (opt-in)
 *
 * NOT used by any automated scheduler.
 * When HF_API_KEY is unset, isHFAvailable() returns false → UI hides the option.
 */

import OpenAI from "openai";
import { logger } from "../shared/logger";

const HF_BASE_URL = "https://router.huggingface.co/v1";
const tag = "HFClient";

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.HF_API_KEY;
    if (!apiKey) throw new Error("HF_API_KEY not configured");
    _client = new OpenAI({ baseURL: HF_BASE_URL, apiKey });
  }
  return _client;
}

/** Check if HF Router is available (key configured). */
export function isHFAvailable(): boolean {
  return !!process.env.HF_API_KEY;
}

export interface HFChatOptions {
  model?: string;
  system: string;
  prompt: string;
  jsonMode?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface HFChatResult {
  text: string;
  model: string;
  finishReason: string | null;
}

/**
 * Send a chat completion to HF Router.
 * Throws on 402 (credits exhausted) or network errors.
 */
export async function chatWithHF(opts: HFChatOptions): Promise<HFChatResult> {
  const client = getClient();
  const routing = process.env.HF_ROUTING || "fastest";
  const baseModel =
    opts.model || process.env.HF_MODEL || "meta-llama/Llama-3.3-70B-Instruct";
  const model = `${baseModel}:${routing}`;

  try {
    const res = await client.chat.completions.create({
      model,
      messages: [
        { role: "system" as const, content: opts.system },
        { role: "user" as const, content: opts.prompt },
      ],
      temperature: opts.temperature ?? 0.1,
      max_tokens: opts.maxTokens ?? 512,
      ...(opts.jsonMode
        ? { response_format: { type: "json_object" as const } }
        : {}),
    });

    return {
      text: res.choices[0]?.message?.content || "",
      model,
      finishReason: res.choices[0]?.finish_reason ?? null,
    };
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 402) {
      logger.warn(tag, "HF credits exhausted (402)");
    }
    throw err;
  }
}
