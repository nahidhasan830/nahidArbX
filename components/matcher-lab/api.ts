import type {
  MatcherListResponse,
  MatcherManualDecision,
  MatcherRunJobResponse,
  MatcherRunProgressEvent,
  MatcherRunRequest,
  MatcherRunResponse,
  MatcherSchedulerSettingsResponse,
  MatcherStatsResponse,
} from "./types";

async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${txt}`);
  }
  return (await res.json()) as T;
}

export async function fetchMatcherStats(): Promise<MatcherStatsResponse> {
  return unwrap(await fetch("/api/matcher-lab/stats"));
}

export async function fetchMatcherDecisions(opts?: {
  runId?: string;
  decision?: string;
  limit?: number;
  offset?: number;
}): Promise<MatcherListResponse> {
  const params = new URLSearchParams();
  if (opts?.runId) params.set("runId", opts.runId);
  if (opts?.decision && opts.decision !== "all") {
    params.set("decision", opts.decision);
  }
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.offset) params.set("offset", String(opts.offset));
  return unwrap(await fetch(`/api/matcher-lab?${params.toString()}`));
}

export async function streamMatcherRun(
  input: MatcherRunRequest,
  onEvent: (event: MatcherRunProgressEvent) => void,
): Promise<MatcherRunResponse> {
  const res = await fetch("/api/matcher-lab/run-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!res.ok || !res.body) {
    return unwrap(res);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let summary: MatcherRunResponse | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const event = JSON.parse(trimmed) as MatcherRunProgressEvent;
      onEvent(event);
      if (event.summary) summary = event.summary;
    }
  }

  const trailing = buffer.trim();
  if (trailing) {
    const event = JSON.parse(trailing) as MatcherRunProgressEvent;
    onEvent(event);
    if (event.summary) summary = event.summary;
  }

  if (!summary) {
    throw new Error("Matcher stream ended without a run summary");
  }
  if (summary.status === "failed") {
    throw new Error(summary.errorMessage ?? "Matcher run failed");
  }
  return summary;
}

export async function startMatcherRunJob(
  input: MatcherRunRequest,
): Promise<MatcherRunJobResponse> {
  const res = await fetch("/api/matcher-lab/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return unwrap(res);
}

export async function fetchMatcherRunJob(
  jobId: string,
): Promise<MatcherRunJobResponse> {
  return unwrap(await fetch(`/api/matcher-lab/jobs/${jobId}`));
}

export async function fetchLatestMatcherRunJob(opts?: {
  activeOnly?: boolean;
}): Promise<MatcherRunJobResponse> {
  const params = new URLSearchParams();
  if (opts?.activeOnly) params.set("active", "1");
  const qs = params.toString();
  return unwrap(await fetch(`/api/matcher-lab/jobs${qs ? `?${qs}` : ""}`));
}

export async function sendManualMatcherDecisions(input: {
  items: Array<{
    decisionId: string;
    decision: MatcherManualDecision;
    reason?: string;
  }>;
}): Promise<{ success: boolean }> {
  const res = await fetch("/api/matcher-lab", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "manual-decisions", ...input }),
  });
  return unwrap(res);
}

export async function fetchMatcherSchedulerSettings(): Promise<MatcherSchedulerSettingsResponse> {
  return unwrap(await fetch("/api/matcher-lab/scheduler"));
}

export async function updateMatcherSchedulerSettings(input: {
  enabled?: boolean;
  intervalSeconds?: number;
  useDeepSeek?: boolean;
}): Promise<MatcherSchedulerSettingsResponse> {
  const res = await fetch("/api/matcher-lab/scheduler", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return unwrap(res);
}
