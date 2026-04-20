/**
 * Cost estimator + single hard ceiling for Tier 3 (Gemini url_context).
 *
 * Philosophy: the UI shows a confirmation popup before triggering any
 * AI call, so the user always sees the estimate and decides. This
 * module's job is:
 *
 *   1. `estimateBatchCostUsd` — exported so both server + client can
 *      produce a consistent per-batch $ number.
 *   2. `assertWithinRequestCeiling` — last-line-of-defense server check
 *      that refuses any single batch whose estimate tops
 *      `AI_MAX_PER_REQUEST_USD` (default $2). Prevents programmatic
 *      clients from bypassing the UI popup.
 *
 * No daily budget — the rolling 24h lookup was extra complexity for
 * limited value, and the frontend confirm already forces the operator
 * to see the cost before every call.
 */

/** Per-million-tokens pricing (April 2026 paid tier). */
const RATES = {
  lite: { input: 0.25, output: 1.5 },
  flash: { input: 0.5, output: 3.0 },
  pro: { input: 2.0, output: 12.0 },
} as const satisfies Record<
  "lite" | "flash" | "pro",
  { input: number; output: number }
>;

export type AiModel = keyof typeof RATES;

/**
 * Conservative per-call estimate. Assumes the fetched scoreboard page
 * weighs in at ~15k tokens (above-average) so the ceiling protects us
 * from most realistic cases. Pathological 1M-token pages are NOT
 * covered — Gemini's project-level spend cap handles those server-side.
 */
const perCallUsd = (model: AiModel): number => {
  const r = RATES[model];
  const inputTokens = 15_000;
  const outputTokens = 30;
  return (
    (inputTokens * r.input) / 1_000_000 + (outputTokens * r.output) / 1_000_000
  );
};

/**
 * How AI is being used for this batch — affects how we extrapolate the
 * worst case.
 *   - "force-ai": every event goes to Tier 3 (manual "AI · X" re-run).
 *   - "fallback":  Tier 3 only catches free-tier misses ("useAi: true").
 *                  Historical runs see ~5% of events reach Tier 3; we
 *                  use 20% as a conservative ceiling so the estimate
 *                  isn't deceptively optimistic.
 */
export type AiMode = "force-ai" | "fallback";

const HIT_RATE: Record<AiMode, number> = {
  "force-ai": 1.0,
  fallback: 0.2,
};

export const estimateBatchCostUsd = (
  eventCount: number,
  model: AiModel,
  mode: AiMode,
): number => {
  if (eventCount <= 0) return 0;
  const expectedCalls = eventCount * HIT_RATE[mode];
  return expectedCalls * perCallUsd(model);
};

// ─── Config readers ─────────────────────────────────────────────────────────

const parseUsdEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Reads AI_MAX_PER_REQUEST_USD at call time so env changes don't need a restart. */
export const getPerRequestCeilingUsd = (): number =>
  parseUsdEnv("AI_MAX_PER_REQUEST_USD", 2);

// ─── Guard ──────────────────────────────────────────────────────────────────

/**
 * Thrown when a pre-flight check blocks a batch. The message is safe to
 * show end-users — no internals, just the relevant numbers + actionable
 * guidance.
 */
export class AiBudgetError extends Error {
  constructor(
    message: string,
    public details: {
      estimatedUsd: number;
      ceilingUsd: number;
      eventCount: number;
      model: AiModel;
    },
  ) {
    super(message);
    this.name = "AiBudgetError";
  }
}

const fmt = (n: number): string => `$${n.toFixed(4)}`;

export interface GuardInput {
  eventCount: number;
  model: AiModel;
  mode: AiMode;
}

/**
 * Hard server-side ceiling. Throws `AiBudgetError` when the pre-flight
 * estimate exceeds the limit — the route handler turns that into a 400
 * so the UI can surface the message.
 */
export const assertWithinRequestCeiling = (input: GuardInput): void => {
  const estimatedUsd = estimateBatchCostUsd(
    input.eventCount,
    input.model,
    input.mode,
  );
  const ceilingUsd = getPerRequestCeilingUsd();
  if (ceilingUsd <= 0) return; // disabled
  if (estimatedUsd > ceilingUsd) {
    throw new AiBudgetError(
      `This request would cost an estimated ${fmt(estimatedUsd)} ` +
        `(${input.eventCount} events × ${input.model}), over the per-request ceiling of ${fmt(ceilingUsd)}. ` +
        `Reduce the selection, pick a cheaper model, or raise AI_MAX_PER_REQUEST_USD.`,
      {
        estimatedUsd,
        ceilingUsd,
        eventCount: input.eventCount,
        model: input.model,
      },
    );
  }
};
