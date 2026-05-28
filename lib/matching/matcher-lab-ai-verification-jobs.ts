import { randomUUID } from "node:crypto";
import { getByIds } from "../db/repositories/match-pairs";
import type { MatchPairRow } from "../db/schema";
import {
  matchBatch,
  type AiSearchBatchResult,
  type AiSearchEventInfo,
  type AiSearchPairVerdict,
  type AiSearchSourceCitation,
} from "./ai-search-client";
import { logger } from "../shared/logger";
import { singleton } from "../util/singleton";

const tag = "MatcherLabAiVerification";
const MAX_CHUNK_SIZE = 20;
const MAX_RETAINED_JOBS = 3;

export type AiVerificationJobStatus = "running" | "completed" | "failed";
export type AiVerificationResultStatus = "success" | "error";
export type AiVerificationDecision =
  | "SAME"
  | "DIFFERENT"
  | "UNCERTAIN"
  | "ERROR";
export type AiVerificationEngine = "ai-search" | "deepseek";
export type AiVerificationModel = "flash";

export interface AiVerificationJobResult {
  id: string;
  pair: MatchPairRow;
  status: AiVerificationResultStatus;
  decision: AiVerificationDecision;
  confidence: number | null;
  model: string | null;
  engine: "ai-search";
  reasoning: string;
  sources: AiSearchSourceCitation[];
  searchQueriesUsed: string[];
  error?: string;
}

export interface AiVerificationJobSnapshot {
  id: string;
  pairIds: string[];
  status: AiVerificationJobStatus;
  engine: "ai-search";
  model: AiVerificationModel;
  total: number;
  processed: number;
  same: number;
  different: number;
  uncertain: number;
  errors: number;
  results: AiVerificationJobResult[];
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

interface AiVerificationJobState extends AiVerificationJobSnapshot {
  startedAtMs: number;
}

interface AiVerificationState {
  activeJobId: string | null;
  latestJobId: string | null;
  jobs: Map<string, AiVerificationJobState>;
}

const state = singleton<AiVerificationState>(
  "matcher-lab-ai-verification-jobs:v1",
  () => ({
    activeJobId: null,
    latestJobId: null,
    jobs: new Map(),
  }),
);

export interface StartAiVerificationJobResult {
  job: AiVerificationJobSnapshot;
  reused: boolean;
}

export function startAiVerificationJob(opts: {
  pairIds: string[];
  engine?: AiVerificationEngine;
  model?: AiVerificationModel;
}): StartAiVerificationJobResult {
  if (state.activeJobId) {
    const active = state.jobs.get(state.activeJobId);
    if (active?.status === "running") {
      return { job: snapshot(active), reused: true };
    }
    state.activeJobId = null;
  }

  const pairIds = [...new Set(opts.pairIds)].filter(Boolean);
  const id = `ai-verify-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const now = new Date();
  const job: AiVerificationJobState = {
    id,
    pairIds,
    status: "running",
    engine: "ai-search",
    model: "flash",
    total: pairIds.length,
    processed: 0,
    same: 0,
    different: 0,
    uncertain: 0,
    errors: 0,
    results: [],
    startedAt: now.toISOString(),
    startedAtMs: now.getTime(),
    completedAt: null,
    error: null,
  };

  state.jobs.set(id, job);
  state.activeJobId = id;
  state.latestJobId = id;
  pruneJobs();

  void runJob(id);
  return { job: snapshot(job), reused: false };
}

export function getAiVerificationJob(
  jobId?: string | null,
): AiVerificationJobSnapshot | null {
  const id = jobId || state.activeJobId || state.latestJobId;
  if (!id) return null;
  const job = state.jobs.get(id);
  return job ? snapshot(job) : null;
}

export function clearAiVerificationJob(jobId?: string | null): boolean {
  const id = jobId || state.latestJobId;
  if (!id) return true;
  const job = state.jobs.get(id);
  if (job?.status === "running") return false;
  state.jobs.delete(id);
  if (state.latestJobId === id) {
    state.latestJobId = state.activeJobId;
  }
  return true;
}

async function runJob(jobId: string): Promise<void> {
  const job = state.jobs.get(jobId);
  if (!job) return;

  try {
    if (job.pairIds.length === 0) {
      completeJob(job);
      return;
    }

    const rows = await getByIds(job.pairIds);
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    const pairs = job.pairIds.flatMap((id) => {
      const row = rowsById.get(id);
      return row ? [row] : [];
    });
    const missing = job.pairIds.length - pairs.length;
    if (missing > 0) {
      job.processed += missing;
      job.errors += missing;
      job.error = `${missing} selected pair${missing === 1 ? "" : "s"} could not be loaded.`;
    }

    for (let i = 0; i < pairs.length; i += MAX_CHUNK_SIZE) {
      const chunk = pairs.slice(i, i + MAX_CHUNK_SIZE);
      const batch = await matchBatch(
        chunk.map((pair) => ({
          event_a: toEventInfo(pair, "a"),
          event_b: toEventInfo(pair, "b"),
        })),
      );

      if (!batch) {
        for (const pair of chunk) {
          appendResult(job, errorResult(pair, "AI Search service unreachable"));
        }
        continue;
      }

      appendBatch(job, chunk, batch);
    }

    completeJob(job);
  } catch (err) {
    job.status = "failed";
    job.completedAt = new Date().toISOString();
    job.error = (err as Error).message;
    logger.error(tag, `Job ${job.id} failed: ${(err as Error).message}`);
  } finally {
    if (state.activeJobId === job.id) state.activeJobId = null;
  }
}

function appendBatch(
  job: AiVerificationJobState,
  pairs: MatchPairRow[],
  batch: AiSearchBatchResult,
): void {
  const verdictsByIndex = new Map<number, AiSearchPairVerdict>();
  for (const verdict of batch.verdicts) {
    verdictsByIndex.set(verdict.pair_index, verdict);
  }

  for (const [index, pair] of pairs.entries()) {
    const verdict = verdictsByIndex.get(index);
    if (!verdict) {
      appendResult(job, errorResult(pair, "AI Search returned no verdict"));
      continue;
    }

    const decision = normalizeDecision(verdict.decision);
    appendResult(job, {
      id: pair.id,
      pair,
      status: "success",
      decision,
      confidence: verdict.confidence,
      model: batch.model || "deepseek-v4-flash",
      engine: "ai-search",
      reasoning:
        verdict.reasoning ||
        "AI verification completed without a reasoning summary.",
      sources: batch.sources ?? [],
      searchQueriesUsed: batch.searchQueriesUsed ?? [],
    });
  }
}

function appendResult(
  job: AiVerificationJobState,
  result: AiVerificationJobResult,
): void {
  job.results.push(result);
  job.processed += 1;

  if (result.status === "error") {
    job.errors += 1;
    return;
  }

  if (result.decision === "SAME") job.same += 1;
  else if (result.decision === "DIFFERENT") job.different += 1;
  else job.uncertain += 1;
}

function completeJob(job: AiVerificationJobState): void {
  job.status = "completed";
  job.completedAt = new Date().toISOString();
}

function errorResult(
  pair: MatchPairRow,
  message: string,
): AiVerificationJobResult {
  return {
    id: pair.id,
    pair,
    status: "error",
    decision: "ERROR",
    confidence: null,
    model: null,
    engine: "ai-search",
    reasoning: message,
    sources: [],
    searchQueriesUsed: [],
    error: message,
  };
}

function normalizeDecision(
  decision: string,
): Exclude<AiVerificationDecision, "ERROR"> {
  if (decision === "SAME") return "SAME";
  if (decision === "DIFFERENT" || decision === "NOT_SAME") return "DIFFERENT";
  return "UNCERTAIN";
}

function toEventInfo(
  pair: MatchPairRow,
  side: "a" | "b",
): AiSearchEventInfo {
  if (side === "a") {
    return {
      home_team: pair.eventAHomeTeam,
      away_team: pair.eventAAwayTeam,
      competition: pair.eventACompetition,
      start_time: pair.eventAStartTime,
      provider: pair.eventAProvider,
    };
  }
  return {
    home_team: pair.eventBHomeTeam,
    away_team: pair.eventBAwayTeam,
    competition: pair.eventBCompetition,
    start_time: pair.eventBStartTime,
    provider: pair.eventBProvider,
  };
}

function snapshot(job: AiVerificationJobState): AiVerificationJobSnapshot {
  return {
    id: job.id,
    pairIds: [...job.pairIds],
    status: job.status,
    engine: job.engine,
    model: job.model,
    total: job.total,
    processed: job.processed,
    same: job.same,
    different: job.different,
    uncertain: job.uncertain,
    errors: job.errors,
    results: [...job.results],
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
  };
}

function pruneJobs(): void {
  const completed = [...state.jobs.values()]
    .filter((job) => job.status !== "running")
    .sort((a, b) => b.startedAtMs - a.startedAtMs);

  for (const job of completed.slice(MAX_RETAINED_JOBS)) {
    state.jobs.delete(job.id);
  }
}
