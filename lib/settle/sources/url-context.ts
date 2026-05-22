/**
 * Tier 3: Gemini url_context settler.
 *
 * For each event we don't have a score for yet, deterministically build
 * one or more canonical scoreboard URLs (Sofascore, FlashScore etc.) and
 * ask Gemini Flash-Lite to extract the final + half-time score from
 * those pages. url_context has no per-query surcharge — we only pay for
 * the (small) token count of the fetched page plus our prompt.
 *
 * Output is enum-constrained JSON so the reply collapses to a handful of
 * tokens. Cost target: ~$0.0003 per resolved event on Flash-Lite.
 */

import { GoogleGenAI, Type } from "@google/genai";
import type { SettleEvent } from "../waterfall";
import type { MatchScore } from "../types";
import { logger } from "../../shared/logger";
import { format, isValid, parseISO } from "date-fns";

const LITE_MODEL =
  process.env.GEMINI_LITE_MODEL || "gemini-3.1-flash-lite-preview";
const FLASH_MODEL = process.env.GEMINI_FLASH_MODEL || "gemini-3-flash-preview";
const PRO_MODEL = process.env.GEMINI_PRO_MODEL || "gemini-3.1-pro-preview";

type TierKey = "lite" | "flash" | "pro";
const resolveModel = (tier: TierKey | undefined): string => {
  if (tier === "pro") return PRO_MODEL;
  if (tier === "flash") return FLASH_MODEL;
  return LITE_MODEL;
};

let client: GoogleGenAI | null = null;
const getClient = (): GoogleGenAI => {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    client = new GoogleGenAI({ apiKey });
  }
  return client;
};

const SYSTEM_INSTRUCTION = `You are a sports settlement assistant. Use Google Search to find the final score for the specific match on the given date.
- FT = full-time (90' + stoppage). Ignore ET/penalties for the FT number.
- HT = half-time (45' + stoppage). If the page does not show HT, set htHome/htAway to null.
- If the match is abandoned/postponed/cancelled, set status accordingly.
Do not invent scores. If the search results do not conclusively show a finished match, return status "UNKNOWN".`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    status: {
      type: Type.STRING,
      enum: ["FT", "AET", "PEN", "ABD", "POSTPONED", "UNKNOWN"],
    },
    htHome: { type: Type.INTEGER, nullable: true },
    htAway: { type: Type.INTEGER, nullable: true },
    ftHome: { type: Type.INTEGER, nullable: true },
    ftAway: { type: Type.INTEGER, nullable: true },
    confidence: { type: Type.NUMBER },
  },
  propertyOrdering: [
    "status",
    "ftHome",
    "ftAway",
    "htHome",
    "htAway",
    "confidence",
  ],
  required: ["status", "confidence"],
};

const buildPrompt = (evt: SettleEvent): string => {
  const kickoff = parseISO(evt.startTime);
  const kickoffClause = isValid(kickoff)
    ? format(kickoff, "yyyy-MM-dd HH:mm")
    : evt.startTime;
  const dateClause = isValid(kickoff)
    ? format(kickoff, "yyyy-MM-dd")
    : evt.startTime.slice(0, 10);

  return `Match: ${evt.homeTeam} vs ${evt.awayTeam}
Competition: ${evt.competition ?? "unknown"}
Kickoff: ${kickoffClause}
Date: ${dateClause}

Use googleSearch to find the FT (Full Time) and HT (Half Time) score for this specific fixture.
Do not guess. Verify it's the exact match from the given date.
Return the FT + HT score for this specific fixture.`;
};

interface ParsedResponse {
  status: string;
  htHome: number | null;
  htAway: number | null;
  ftHome: number | null;
  ftAway: number | null;
  confidence: number;
}

const mapStatus = (raw: string): MatchScore["status"] | null => {
  const s = raw.toUpperCase();
  if (s === "FT" || s === "AET" || s === "PEN") return s;
  if (s === "ABD") return "ABD";
  if (s === "POSTPONED") return "POSTPONED";
  return null;
};

/**
 * Classification of a Gemini error. Certain failure modes (spend cap,
 * daily quota) are cheap-to-hit but worth aborting the whole batch for:
 * continuing the loop just generates hundreds of identical errors and
 * burns up to a minute of wall time. `transient` errors are worth retrying
 * once; `fatal-event` errors mean this specific event can't be resolved
 * (bad URL, invalid argument) and we should skip, not retry.
 */
type ErrClass =
  | "spend-cap"
  | "quota-exhausted"
  | "context-overflow"
  | "fatal-event"
  | "transient";

const classifyGeminiError = (raw: unknown): ErrClass => {
  const msg = (raw as Error)?.message ?? String(raw);
  if (/exceeded its monthly spending cap/i.test(msg)) return "spend-cap";
  if (/RESOURCE_EXHAUSTED/i.test(msg)) return "quota-exhausted";
  if (/exceeds the maximum number of tokens/i.test(msg))
    return "context-overflow";
  if (/INVALID_ARGUMENT/i.test(msg)) return "fatal-event";
  return "transient";
};

/**
 * Thrown when an error class should stop the whole url_context batch.
 * Caught in fetchUrlContextScores to short-circuit the remaining queue.
 */
class UrlContextBatchAbort extends Error {
  constructor(
    public kind: ErrClass,
    msg: string,
  ) {
    super(msg);
  }
}

/**
 * Settle a single event via url_context. Returns null when the model
 * couldn't conclusively resolve the match — callers should fall through
 * to a deeper tier rather than trust a low-confidence answer.
 *
 * Throws `UrlContextBatchAbort` when the error class is one we shouldn't
 * retry hundreds of times in the same batch (spend cap, daily quota).
 */
export async function settleEventViaUrlContext(
  evt: SettleEvent,
  opts: { model?: TierKey } = {},
): Promise<MatchScore | null> {
  if (!process.env.GEMINI_API_KEY) return null;

  const modelName = resolveModel(opts.model);
  let responseText: string | null = null;
  try {
    const res = await getClient().models.generateContent({
      model: modelName,
      contents: buildPrompt(evt),
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
        responseJsonSchema: RESPONSE_SCHEMA,
        temperature: 0,
      },
    });
    responseText = res.text ?? null;
  } catch (err) {
    const kind = classifyGeminiError(err);
    const msg = (err as Error).message;
    if (kind === "spend-cap" || kind === "quota-exhausted") {
      throw new UrlContextBatchAbort(kind, msg);
    }
    logger.warn(
      "UrlContextSettler",
      `${evt.eventId}: Gemini call failed (${kind}): ${msg.slice(0, 200)}`,
    );
    return null;
  }

  if (!responseText) return null;

  let parsed: ParsedResponse;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    logger.warn(
      "UrlContextSettler",
      `${evt.eventId}: unparseable JSON: ${responseText.slice(0, 120)}`,
    );
    return null;
  }

  const status = mapStatus(parsed.status);
  if (!status) return null;

  const dateStr = evt.startTime.slice(0, 10);
  const qStr = encodeURIComponent(
    `${evt.homeTeam} vs ${evt.awayTeam} ${dateStr}`,
  );
  const fallbackUrl = `https://www.google.com/search?q=${qStr}`;

  if (status === "POSTPONED" || status === "ABD") {
    return {
      eventId: evt.eventId,
      status,
      htHome: null,
      htAway: null,
      ftHome: 0,
      ftAway: 0,
      source: "url-context",
      confidence: Math.max(0.7, Math.min(0.95, parsed.confidence ?? 0.8)),
      sourceUrl: fallbackUrl,
    };
  }

  if (parsed.ftHome == null || parsed.ftAway == null) return null;
  return {
    eventId: evt.eventId,
    status,
    htHome: parsed.htHome ?? null,
    htAway: parsed.htAway ?? null,
    ftHome: parsed.ftHome,
    ftAway: parsed.ftAway,
    source: "url-context",
    confidence: Math.max(0.7, Math.min(0.95, parsed.confidence ?? 0.8)),
    sourceUrl: fallbackUrl,
  };
}

export interface UrlContextBatchOutcome {
  scores: Map<string, MatchScore>;
  aborted: "spend-cap" | "quota-exhausted" | null;
}

/**
 * Settle a batch of events, respecting a concurrency limit so we don't
 * stampede the model. Returns resolved scores along with an `aborted`
 * flag if a spend-cap or quota-exhausted error short-circuited the
 * batch — callers can surface that in their telemetry so it's obvious
 * why the Tier 3 hit rate dropped to zero.
 */
export async function fetchUrlContextScoresDetailed(
  events: SettleEvent[],
  concurrency = 3,
  opts: { model?: TierKey } = {},
): Promise<UrlContextBatchOutcome> {
  const out: UrlContextBatchOutcome = { scores: new Map(), aborted: null };
  if (events.length === 0) return out;
  if (!process.env.GEMINI_API_KEY) return out;

  const queue = [...events];
  const abort = { signal: false as boolean, kind: null as ErrClass | null };

  const workers = Array.from(
    { length: Math.min(concurrency, queue.length) },
    async () => {
      while (queue.length > 0 && !abort.signal) {
        const evt = queue.shift();
        if (!evt) break;
        try {
          const s = await settleEventViaUrlContext(evt, { model: opts.model });
          if (s) out.scores.set(evt.eventId, s);
        } catch (err) {
          if (err instanceof UrlContextBatchAbort) {
            abort.signal = true;
            abort.kind = err.kind;
            logger.warn(
              "UrlContextSettler",
              `Aborting batch (${err.kind}): ${err.message.slice(0, 160)}`,
            );
            break;
          }
          logger.warn(
            "UrlContextSettler",
            `${evt.eventId}: unexpected error: ${(err as Error).message}`,
          );
        }
      }
    },
  );
  await Promise.all(workers);

  if (out.scores.size > 0) {
    logger.info(
      "UrlContextSettler",
      `Resolved ${out.scores.size}/${events.length} events via url_context`,
    );
  }
  if (abort.kind === "spend-cap" || abort.kind === "quota-exhausted") {
    out.aborted = abort.kind;
  }
  return out;
}

/**
 * Backwards-compatible wrapper used by the waterfall — returns just the
 * scores map so the existing call site doesn't need to change shape.
 */
export async function fetchUrlContextScores(
  events: SettleEvent[],
  concurrency = 3,
  opts: { model?: TierKey } = {},
): Promise<Map<string, MatchScore>> {
  const { scores } = await fetchUrlContextScoresDetailed(
    events,
    concurrency,
    opts,
  );
  return scores;
}
