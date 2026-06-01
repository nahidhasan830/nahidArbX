import { randomUUID } from "node:crypto";
import { asc, desc, eq, or } from "drizzle-orm";
import { db } from "../db/client";
import {
  eventMatcherRunJobEvents,
  eventMatcherRunJobs,
  type EventMatcherRunJobEventRow,
  type EventMatcherRunJobRow,
  type NewEventMatcherRunJobRow,
} from "../db/schema";
import { logger } from "../shared/logger";
import { singleton } from "../util/singleton";
import { runEventMatcher } from "./run";
import type {
  EventMatcherProgressEvent,
  EventMatcherRunSummary,
} from "./types";

export type EventMatcherJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed";

export interface EventMatcherRunJob {
  id: string;
  status: EventMatcherJobStatus;
  trigger: string;
  mode: "apply";
  decisionIds: string[];
  useDeepSeek: boolean | null;
  summary: EventMatcherRunSummary | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  events: EventMatcherProgressEvent[];
}

interface MatcherJobRunnerState {
  active: Set<string>;
}

const runnerState = () =>
  singleton<MatcherJobRunnerState>("event-matcher-run-jobs", () => ({
    active: new Set<string>(),
  }));

function now() {
  return new Date().toISOString();
}

function toSummary(value: unknown): EventMatcherRunSummary | null {
  if (!value || typeof value !== "object") return null;
  return value as EventMatcherRunSummary;
}

function toProgressEvent(value: unknown): EventMatcherProgressEvent {
  return value as EventMatcherProgressEvent;
}

function mapJob(
  row: EventMatcherRunJobRow,
  events: EventMatcherRunJobEventRow[],
): EventMatcherRunJob {
  return {
    id: row.id,
    status: row.status as EventMatcherJobStatus,
    trigger: row.trigger,
    mode: "apply",
    decisionIds: Array.isArray(row.decisionIds) ? row.decisionIds : [],
    useDeepSeek: row.useDeepSeek,
    summary: toSummary(row.summary),
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    updatedAt: row.updatedAt,
    events: events.map((event) => toProgressEvent(event.event)),
  };
}

async function readJobEvents(jobId: string) {
  return db
    .select()
    .from(eventMatcherRunJobEvents)
    .where(eq(eventMatcherRunJobEvents.jobId, jobId))
    .orderBy(asc(eventMatcherRunJobEvents.id));
}

export async function readEventMatcherRunJob(
  jobId: string,
): Promise<EventMatcherRunJob | null> {
  const rows = await db
    .select()
    .from(eventMatcherRunJobs)
    .where(eq(eventMatcherRunJobs.id, jobId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return mapJob(row, await readJobEvents(jobId));
}

export async function readLatestEventMatcherRunJob(opts?: {
  activeOnly?: boolean;
}): Promise<EventMatcherRunJob | null> {
  const where = opts?.activeOnly
    ? or(
        eq(eventMatcherRunJobs.status, "queued"),
        eq(eventMatcherRunJobs.status, "running"),
      )
    : undefined;
  const rows = await db
    .select()
    .from(eventMatcherRunJobs)
    .where(where)
    .orderBy(desc(eventMatcherRunJobs.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return mapJob(row, await readJobEvents(row.id));
}

export async function createEventMatcherRunJob(input: {
  decisionIds?: string[];
  useDeepSeek?: boolean;
}): Promise<EventMatcherRunJob> {
  const decisionIds = [...new Set(input.decisionIds ?? [])].filter(Boolean);
  const row: NewEventMatcherRunJobRow = {
    id: randomUUID(),
    status: "queued",
    trigger: "manual",
    mode: "apply",
    decisionIds,
    useDeepSeek:
      typeof input.useDeepSeek === "boolean" ? input.useDeepSeek : null,
  };
  const inserted = await db.insert(eventMatcherRunJobs).values(row).returning();
  return mapJob(inserted[0], []);
}

async function markJobRunning(jobId: string) {
  await db
    .update(eventMatcherRunJobs)
    .set({
      status: "running",
      startedAt: now(),
      updatedAt: now(),
    })
    .where(eq(eventMatcherRunJobs.id, jobId));
}

async function appendJobEvent(jobId: string, event: EventMatcherProgressEvent) {
  await db.insert(eventMatcherRunJobEvents).values({
    jobId,
    phase: event.phase,
    event: event as unknown as Record<string, unknown>,
  });
  await db
    .update(eventMatcherRunJobs)
    .set({ updatedAt: now() })
    .where(eq(eventMatcherRunJobs.id, jobId));
}

async function finishJob(jobId: string, summary: EventMatcherRunSummary) {
  await db
    .update(eventMatcherRunJobs)
    .set({
      status: summary.status,
      summary: summary as unknown as Record<string, unknown>,
      errorMessage: summary.errorMessage ?? null,
      finishedAt: now(),
      updatedAt: now(),
    })
    .where(eq(eventMatcherRunJobs.id, jobId));
}

async function failJob(jobId: string, err: unknown) {
  const errorMessage = err instanceof Error ? err.message : String(err);
  const timestamp = now();
  const event: EventMatcherProgressEvent = {
    runId: "unknown",
    mode: "apply",
    phase: "failed",
    message: "Matcher job failed before run completion",
    timestamp,
    elapsedMs: 0,
    counters: {
      snapshots: 0,
      generatedCandidates: 0,
      candidatesToScore: 0,
      skippedCandidates: 0,
      scoredCandidates: 0,
      insertedCandidates: 0,
      autoMerged: 0,
      autoRejected: 0,
      deepseekReviewed: 0,
      humanReview: 0,
    },
    errorMessage,
  };
  await appendJobEvent(jobId, event);
  await db
    .update(eventMatcherRunJobs)
    .set({
      status: "failed",
      errorMessage,
      finishedAt: timestamp,
      updatedAt: timestamp,
    })
    .where(eq(eventMatcherRunJobs.id, jobId));
}

export async function runPersistedEventMatcherJob(jobId: string) {
  const job = await readEventMatcherRunJob(jobId);
  if (!job) throw new Error(`Matcher job not found: ${jobId}`);
  if (job.status !== "queued") return;

  await markJobRunning(jobId);
  try {
    const summary = await runEventMatcher({
      trigger: "manual",
      mode: "apply",
      applyMerges: true,
      decisionIds: job.decisionIds,
      useDeepSeek: job.useDeepSeek ?? undefined,
      onProgress: (event) => appendJobEvent(jobId, event),
    });
    await finishJob(jobId, summary);
  } catch (err) {
    await failJob(jobId, err);
  }
}

export function enqueueEventMatcherRunJob(jobId: string) {
  const state = runnerState();
  if (state.active.has(jobId)) return;
  state.active.add(jobId);
  void runPersistedEventMatcherJob(jobId)
    .catch((err) => {
      logger.error(
        "MatcherRunJob",
        `Job ${jobId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    })
    .finally(() => {
      state.active.delete(jobId);
    });
}

export async function startEventMatcherRunJob(input: {
  decisionIds?: string[];
  useDeepSeek?: boolean;
}) {
  const job = await createEventMatcherRunJob(input);
  enqueueEventMatcherRunJob(job.id);
  return job;
}
