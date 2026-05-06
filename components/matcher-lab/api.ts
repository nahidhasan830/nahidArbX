import type {
  ListResponse,
  MatchPairDecidedBy,
  MatchPairDecision,
  MatchPairStage,
  MlBatchResult,
  MlProgressEvent,
  StatsResponse,
} from "./types";

async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${txt}`);
  }
  return (await res.json()) as T;
}

export async function fetchPairsByStage(
  stage: MatchPairStage,
  opts?: { limit?: number; offset?: number },
): Promise<ListResponse> {
  const params = new URLSearchParams({ stage });
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.offset) params.set("offset", String(opts.offset));
  return unwrap(await fetch(`/api/matcher-lab?${params}`));
}

export async function fetchStats(opts?: {
  historyLimit?: number;
}): Promise<StatsResponse> {
  const params = new URLSearchParams();
  if (opts?.historyLimit) params.set("historyLimit", String(opts.historyLimit));
  const qs = params.toString();
  return unwrap(await fetch(`/api/matcher-lab/stats${qs ? `?${qs}` : ""}`));
}

export async function decidePair(
  id: string,
  decision: MatchPairDecision,
  decidedBy: MatchPairDecidedBy,
  reason?: string,
): Promise<{ success: boolean }> {
  const res = await fetch("/api/matcher-lab", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "decide", id, decision, decidedBy, reason }),
  });
  return unwrap(res);
}

export async function bulkDecide(
  items: { id: string; decision: MatchPairDecision; reason?: string }[],
  decidedBy: MatchPairDecidedBy,
): Promise<{ succeeded: number; failed: number }> {
  const res = await fetch("/api/matcher-lab", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "bulk-decide", items, decidedBy }),
  });
  return unwrap(res);
}

export async function runMlNow(): Promise<MlBatchResult> {
  const res = await fetch("/api/matcher-lab", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "run-ml" }),
  });
  return unwrap(res);
}

export async function updateScheduler(opts: {
  enabled?: boolean;
  intervalMs?: number;
  aiSearchEnabled?: boolean;
  aiSearchConfidenceThreshold?: number;
  aiSearchMaxBatchSize?: number;
}): Promise<{ success: boolean }> {
  const res = await fetch("/api/matcher-lab", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "update-scheduler", ...opts }),
  });
  return unwrap(res);
}

export async function runMlStream(
  pairIds: string[],
  onEvent: (event: MlProgressEvent) => void,
): Promise<void> {
  const res = await fetch("/api/matcher-lab/run-ml-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairIds }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${txt}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No stream body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const event = JSON.parse(line.slice(6)) as MlProgressEvent;
          onEvent(event);
        } catch {
          // Skip malformed lines
        }
      }
    }
  }
}

export async function verifyAiMatch(
  id: string,
  opts?: { engine?: "gemini" | "ai-search" | "huggingface"; model?: "lite" | "flash" | "pro" },
): Promise<{
  decision: string;
  confidence: number;
  model: string;
  engine: string;
  reasoning?: string;
  sources?: { url: string; title: string; snippet: string }[];
  searchQueriesUsed?: string[];
}> {
  const res = await fetch("/api/matcher-lab/verify-ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, model: opts?.model, engine: opts?.engine }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Failed to verify match");
  }
  return data.result;
}

export async function checkAiSearchHealth(): Promise<{
  ok: boolean;
  model?: string;
} | null> {
  try {
    const res = await fetch("/api/ai-search/healthz", {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { ok: false };
    const data = await res.json();
    return {
      ok: data.status === "ok",
      model: data.llm_engine?.model,
    };
  } catch {
    return null;
  }
}
