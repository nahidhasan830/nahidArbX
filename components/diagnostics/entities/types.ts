/**
 * Shared types used across the EntityInspector panels. Mirror the
 * Postgres rows; UI components are typed against these.
 */

export interface Entity {
  id: string;
  kind: "team" | "competition";
  canonicalName: string;
  country: string | null;
  gender: string | null;
  parentId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  retiredAt: string | null;
}

export interface EntityName {
  id: string;
  entityId: string;
  competitionId: string | null;
  provider: string;
  surfaceRaw: string;
  surfaceNormalized: string;
  weight: number;
  positiveObs: number;
  negativeObs: number;
  status: "candidate" | "active" | "retired";
  classifierScore: number | null;
  conformalPvalue: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
  promotedAt: string | null;
  retiredAt: string | null;
}

export interface ObservationRow {
  id: string;
  observedAt: string;
  surfaceRaw: string;
  surfaceNormalized: string;
  competitionId: string | null;
  provider: string;
  pairedWithEntityId: string | null;
  matchScore: number | null;
  classifierScore: number | null;
  outcome: string;
  source: string;
  metadata: Record<string, unknown>;
}

export interface ReviewQueueItem {
  id: string;
  kind: "merge" | "split" | "conflict";
  source: string;
  entityIdA: string | null;
  entityIdB: string | null;
  entityNameIdA: string | null;
  entityNameIdB: string | null;
  probability: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  resolved: boolean;
  resolvedAt: string | null;
  resolution: string | null;
}

export interface ResolverRunRow {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  triggerSource: string;
  triggeredBy: string | null;
  cloudRunExecution: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  currentPass: string | null;
  progress: Record<string, unknown>;
  summary: Record<string, unknown>;
  error: string | null;
  createdAt: string;
}

export interface SchedulerSnapshot {
  active: boolean;
  lastPromoteAt: number | null;
  lastDecayAt: number | null;
  nextPromoteAt: number | null;
  nextDecayAt: number | null;
  promoterIntervalMs: number;
  decayIntervalMs: number;
  totalPromoted: number;
  totalRetired: number;
  totalDemoted: number;
  totalConflicts: number;
  lastError: string | null;
}

export interface HealthSnapshot {
  stats: {
    entitiesActive: number;
    entitiesRetired: number;
    namesActive: number;
    namesCandidate: number;
    namesRetired: number;
    observations24h: number;
  };
  observationsTimeline: Array<{
    bucket: string;
    outcome: string;
    n: number;
  }>;
  observationsBySource: Array<{ source: string; n: number }>;
  classifierHistogram: Array<{ bucket: number; n: number }>;
  activeRun: ResolverRunRow | null;
  scheduler?: SchedulerSnapshot;
}

export const STATUS_TONES: Record<EntityName["status"], string> = {
  active: "bg-emerald-900/40 text-emerald-300 border-emerald-700/40",
  candidate: "bg-amber-900/40 text-amber-300 border-amber-700/40",
  retired: "bg-zinc-800/60 text-zinc-500 border-zinc-700/40",
};

export const OUTCOME_TONES: Record<string, string> = {
  matched: "bg-emerald-900/40 text-emerald-300",
  "manual-confirm": "bg-emerald-900/50 text-emerald-200",
  rejected: "bg-rose-900/40 text-rose-300",
  "manual-reject": "bg-rose-900/50 text-rose-200",
  "near-match": "bg-amber-900/40 text-amber-300",
};

export const RUN_STATUS_TONES: Record<ResolverRunRow["status"], string> = {
  queued: "bg-zinc-800/60 text-zinc-300 border-zinc-700/40",
  running: "bg-sky-900/40 text-sky-300 border-sky-600/40 animate-pulse",
  succeeded: "bg-emerald-900/40 text-emerald-300 border-emerald-700/40",
  failed: "bg-rose-900/40 text-rose-300 border-rose-700/40",
  cancelled: "bg-zinc-800/60 text-zinc-500 border-zinc-700/40",
};
