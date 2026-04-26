/**
 * Thin client wrappers around `/api/entities/*`. All side-effects go
 * through here so retry/error handling is uniform.
 */

import type {
  Entity,
  EntityName,
  HealthSnapshot,
  ObservationRow,
  ResolverRunRow,
  ReviewQueueItem,
} from "./types";

async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${txt}`);
  }
  return (await res.json()) as T;
}

// ─── Entities ────────────────────────────────────────────────────────────

export async function fetchEntities(opts: {
  kind?: "team" | "competition";
  search?: string;
  limit?: number;
}): Promise<Entity[]> {
  const params = new URLSearchParams();
  if (opts.kind) params.set("kind", opts.kind);
  if (opts.search) params.set("q", opts.search);
  if (opts.limit) params.set("limit", String(opts.limit));
  const data = await unwrap<{ items: Entity[] }>(
    await fetch(`/api/entities?${params.toString()}`),
  );
  return data.items ?? [];
}

export async function fetchEntityDetail(id: string): Promise<{
  entity: Entity;
  names: EntityName[];
  observations: ObservationRow[];
}> {
  return unwrap(await fetch(`/api/entities?id=${encodeURIComponent(id)}`));
}

// ─── Surface forms ───────────────────────────────────────────────────────

export async function fetchSurfaceForms(opts: {
  status?: "candidate" | "active" | "retired";
  provider?: string;
  search?: string;
  limit?: number;
}): Promise<EntityName[]> {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.provider) params.set("provider", opts.provider);
  if (opts.search) params.set("q", opts.search);
  if (opts.limit) params.set("limit", String(opts.limit));
  const data = await unwrap<{ items: EntityName[] }>(
    await fetch(`/api/entities/surface-forms?${params.toString()}`),
  );
  return data.items ?? [];
}

// ─── Observations ────────────────────────────────────────────────────────

export async function fetchObservations(opts: {
  source?: string;
  outcome?: string;
  provider?: string;
  search?: string;
  limit?: number;
}): Promise<ObservationRow[]> {
  const params = new URLSearchParams();
  if (opts.source) params.set("source", opts.source);
  if (opts.outcome) params.set("outcome", opts.outcome);
  if (opts.provider) params.set("provider", opts.provider);
  if (opts.search) params.set("q", opts.search);
  if (opts.limit) params.set("limit", String(opts.limit));
  const data = await unwrap<{ items: ObservationRow[] }>(
    await fetch(`/api/entities/observations?${params.toString()}`),
  );
  return data.items ?? [];
}

// ─── Review queue ────────────────────────────────────────────────────────

export async function fetchReviewQueue(opts: {
  resolved?: boolean;
  kind?: "merge" | "split" | "conflict";
}): Promise<ReviewQueueItem[]> {
  const params = new URLSearchParams({ reviewQueue: "1" });
  if (opts.resolved !== undefined)
    params.set("resolved", opts.resolved ? "1" : "0");
  if (opts.kind) params.set("kind", opts.kind);
  const data = await unwrap<{ items: ReviewQueueItem[] }>(
    await fetch(`/api/entities?${params.toString()}`),
  );
  return data.items ?? [];
}

// ─── Health / overview ──────────────────────────────────────────────────

export async function fetchHealth(): Promise<HealthSnapshot> {
  return unwrap(await fetch(`/api/entities/health`));
}

// ─── Resolver Job runs ──────────────────────────────────────────────────

export async function fetchRuns(limit = 50): Promise<ResolverRunRow[]> {
  const data = await unwrap<{ items: ResolverRunRow[] }>(
    await fetch(`/api/entities/runs?limit=${limit}`),
  );
  return data.items ?? [];
}

export async function fetchActiveRun(): Promise<ResolverRunRow | null> {
  const data = await unwrap<{ active: ResolverRunRow | null }>(
    await fetch(`/api/entities/runs?active=1`),
  );
  return data.active ?? null;
}

export async function triggerResolverJob(): Promise<{
  runId: string;
  error?: string;
}> {
  const res = await fetch(`/api/entities/cluster-now`, { method: "POST" });
  return (await res.json()) as { runId: string; error?: string };
}

// ─── Mutations ──────────────────────────────────────────────────────────

export async function entitiesAction(
  body: Record<string, unknown>,
): Promise<{ success?: boolean; error?: string; message?: string }> {
  const res = await fetch(`/api/entities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as {
    success?: boolean;
    error?: string;
    message?: string;
  };
}

export async function submitTestObservation(body: {
  kind: "team" | "competition";
  surface: string;
  canonicalName: string;
  provider: string;
  competition?: string;
  outcome?: string;
}): Promise<{ success?: boolean; error?: string; message?: string }> {
  const res = await fetch(`/api/entities/observation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as {
    success?: boolean;
    error?: string;
    message?: string;
  };
}

export async function probePlayground(body: {
  kind: "team" | "competition";
  surface: string;
  provider?: string;
  competitionSurface?: string;
  callClassifier?: boolean;
}): Promise<{
  resolved: {
    entity: Entity;
    source: string;
    surfaceNormalized: string;
  } | null;
  classifier: { score?: number; pvalue?: number | null; error?: string } | null;
}> {
  const res = await fetch(`/api/entities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "playground", ...body }),
  });
  const data = (await res.json()) as {
    resolved: {
      entity: Entity;
      source: string;
      surfaceNormalized: string;
    } | null;
    classifier: {
      score?: number;
      pvalue?: number | null;
      error?: string;
    } | null;
  };
  return data;
}
