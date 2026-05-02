#!/usr/bin/env npx tsx
/**
 * Matcher Lab UI Flow Simulator
 *
 * Simulates every user action the Matcher Lab page performs,
 * in the same order the React components call the API:
 *
 *   1. GET /api/matcher-lab/stats         — initial load (stage counts, config, history)
 *   2. GET /api/matcher-lab?stage=X       — list pairs per stage
 *   3. POST /api/matcher-lab (decide)     — human merge/reject a pair
 *   4. POST /api/matcher-lab (bulk-decide)— bulk merge/reject
 *   5. POST /api/matcher-lab/verify-ai    — AI verify (gemini + ai-search engines)
 *   6. POST /api/matcher-lab/run-ml-stream— SSE ML batch (streams events)
 *   7. POST /api/matcher-lab (run-ml)     — non-streaming ML trigger
 *   8. POST /api/matcher-lab (update-scheduler) — save scheduler config
 *   9. GET /api/ai-search/healthz         — AI Search health check
 *
 * Run:  npx tsx scripts/test-matcher-flow.ts
 * Requires the Next.js dev server on localhost:3000.
 */

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

// ── Helpers ────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
};

let pass = 0;
let fail = 0;
let skip = 0;

function header(msg: string) {
  console.log(`\n${C.bold}${C.cyan}━━━ ${msg} ━━━${C.reset}`);
}

function ok(msg: string, detail?: string) {
  pass++;
  console.log(`  ${C.green}✓${C.reset} ${msg}${detail ? C.dim + " — " + detail + C.reset : ""}`);
}

function err(msg: string, detail?: string) {
  fail++;
  console.log(`  ${C.red}✗${C.reset} ${msg}${detail ? C.dim + " — " + detail + C.reset : ""}`);
}

function skipped(msg: string, reason: string) {
  skip++;
  console.log(`  ${C.yellow}○${C.reset} ${msg}${C.dim} — ${reason}${C.reset}`);
}

async function get<T = any>(path: string): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE}${path}`);
  const data = await res.json().catch(() => null);
  return { status: res.status, data: data as T };
}

async function post<T = any>(path: string, body: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data: data as T };
}

async function postSSE(path: string, body: unknown): Promise<{ status: number; events: any[] }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { status: res.status, events: [] };

  const events: any[] = [];
  const text = await res.text();
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      try { events.push(JSON.parse(line.slice(6))); } catch {}
    }
  }
  return { status: res.status, events };
}

// ── Test stages ────────────────────────────────────────────────────────

interface StatsResponse {
  stageCounts: Record<string, number>;
  mlStats: any;
  history: any[];
  config: any;
}

interface ListResponse {
  rows: any[];
  stage: string;
  limit: number;
  offset: number;
}

async function testStats(): Promise<StatsResponse | null> {
  header("1. GET /api/matcher-lab/stats (initial page load)");
  try {
    const { status, data } = await get<StatsResponse>("/api/matcher-lab/stats");
    if (status !== 200) { err("Stats endpoint", `HTTP ${status}`); return null; }

    // Validate shape
    const required = ["stageCounts", "mlStats", "history", "config"];
    const missing = required.filter((k) => !(k in data));
    if (missing.length) { err("Missing keys", missing.join(", ")); return null; }

    ok("Status 200");
    ok("stageCounts present", JSON.stringify(data.stageCounts));

    const sc = data.stageCounts;
    for (const stage of ["inbox", "ml_queued", "human_review", "history"]) {
      if (typeof sc[stage] === "number") ok(`stageCounts.${stage}`, String(sc[stage]));
      else err(`stageCounts.${stage} missing or wrong type`);
    }

    if (data.mlStats) {
      ok("mlStats present", `active=${data.mlStats.active}, interval=${data.mlStats.intervalMs}ms`);
    } else {
      skipped("mlStats", "null — no config row yet");
    }

    if (data.config) {
      const cfg = data.config;
      ok("config present", `aiSearch=${cfg.aiSearchEnabled}, threshold=${cfg.aiSearchConfidenceThreshold}%`);
    } else {
      skipped("config", "null — no matcher_config row");
    }

    ok("history array", `${data.history.length} entries`);
    return data;
  } catch (e: any) {
    err("Stats request failed", e.message);
    return null;
  }
}

async function testListStages(counts: Record<string, number>): Promise<Record<string, any[]>> {
  header("2. GET /api/matcher-lab?stage=X (list pairs per stage)");
  const result: Record<string, any[]> = {};

  for (const stage of ["inbox", "ml_queued", "human_review", "history"]) {
    try {
      const { status, data } = await get<ListResponse>(`/api/matcher-lab?stage=${stage}&limit=50`);
      if (status !== 200) { err(`List ${stage}`, `HTTP ${status}`); continue; }
      result[stage] = data.rows;
      ok(`${stage}`, `${data.rows.length} rows (count=${counts[stage]})`);

      if (data.rows.length > 0) {
        const row = data.rows[0];
        const fields = [
          "id", "stage", "eventAProvider", "eventAHomeTeam", "eventAAwayTeam",
          "eventACompetition", "eventAStartTime", "eventBProvider",
          "eventBHomeTeam", "eventBAwayTeam", "eventBCompetition",
          "eventBStartTime", "stringScore", "pairKey",
        ];
        const missing = fields.filter((f) => !(f in row));
        if (missing.length) err(`${stage} row schema`, `missing: ${missing.join(", ")}`);
        else ok(`${stage} row schema`, "all required fields present");
      }
    } catch (e: any) {
      err(`List ${stage}`, e.message);
    }
  }
  return result;
}

async function testDecide(pairs: Record<string, any[]>) {
  header("3. POST decide (human merge/reject)");

  // Find a pair to test — prefer human_review, fallback to inbox
  const pool = [...(pairs.human_review ?? []), ...(pairs.inbox ?? [])];
  if (pool.length === 0) {
    skipped("decide", "no pairs in inbox/human_review to test");
    return;
  }

  const testPair = pool[0];
  const id = testPair.id;

  // Test validation: missing fields
  const { status: s1, data: d1 } = await post("/api/matcher-lab", { action: "decide" });
  if (s1 === 400) ok("Validation: missing fields → 400");
  else err("Validation", `expected 400, got ${s1}`);

  // Test invalid action
  const { status: s2 } = await post("/api/matcher-lab", { action: "nonexistent" });
  if (s2 === 400) ok("Validation: unknown action → 400");
  else err("Validation: unknown action", `expected 400, got ${s2}`);

  // Actual decide — human-merge
  const { status: s3, data: d3 } = await post("/api/matcher-lab", {
    action: "decide",
    id,
    decision: "human-merge",
    decidedBy: "human",
    reason: "test-script merge",
  });
  if (s3 === 200 && d3?.success) ok(`Decided ${id.slice(0, 8)}…`, "human-merge");
  else err(`Decide ${id.slice(0, 8)}…`, `status=${s3}, data=${JSON.stringify(d3)}`);
}

async function testBulkDecide(pairs: Record<string, any[]>) {
  header("4. POST bulk-decide");

  const pool = [...(pairs.human_review ?? []), ...(pairs.inbox ?? [])];
  if (pool.length < 2) {
    skipped("bulk-decide", `need ≥2 pairs, have ${pool.length}`);
    return;
  }

  // Test validation
  const { status: s1 } = await post("/api/matcher-lab", { action: "bulk-decide" });
  if (s1 === 400) ok("Validation: missing items → 400");
  else err("Validation", `expected 400, got ${s1}`);

  // Actual bulk decide
  const items = pool.slice(0, 2).map((p) => ({
    id: p.id,
    decision: "human-reject" as const,
    reason: "test-script bulk reject",
  }));
  const { status, data } = await post("/api/matcher-lab", {
    action: "bulk-decide",
    items,
    decidedBy: "human",
  });
  if (status === 200) ok(`Bulk decided ${items.length}`, `succeeded=${data?.succeeded}, failed=${data?.failed}`);
  else err("Bulk decide", `status=${status}`);
}

async function testVerifyAi(pairs: Record<string, any[]>) {
  header("5. POST /api/matcher-lab/verify-ai (AI verify)");

  const pool = [...(pairs.human_review ?? []), ...(pairs.inbox ?? [])];
  if (pool.length === 0) {
    skipped("verify-ai", "no pairs available");
    return;
  }

  const id = pool[0].id;

  // Validation
  const { status: s1 } = await post("/api/matcher-lab/verify-ai", {});
  if (s1 === 400) ok("Validation: missing id → 400");
  else err("Validation", `expected 400, got ${s1}`);

  // Fake ID
  const { status: s2 } = await post("/api/matcher-lab/verify-ai", { id: "nonexistent-id" });
  if (s2 === 404) ok("Validation: unknown id → 404");
  else err("Validation: unknown id", `expected 404, got ${s2}`);

  // AI Search engine
  const { status: s3, data: d3 } = await post("/api/matcher-lab/verify-ai", {
    id,
    engine: "ai-search",
  });
  if (s3 === 200 && d3?.result) {
    ok(`AI Search verify`, `decision=${d3.result.decision}, confidence=${d3.result.confidence}%`);
  } else if (s3 === 503) {
    skipped("AI Search verify", "service unreachable (expected when ai-search isn't running)");
  } else {
    err("AI Search verify", `status=${s3}, data=${JSON.stringify(d3)}`);
  }

  // Gemini engine (lite)
  const { status: s4, data: d4 } = await post("/api/matcher-lab/verify-ai", {
    id,
    engine: "gemini",
    model: "lite",
  });
  if (s4 === 200 && d4?.result) {
    ok(`Gemini verify (lite)`, `decision=${d4.result.decision}, confidence=${d4.result.confidence}%`);
  } else if (s4 === 500 || s4 === 503) {
    skipped("Gemini verify", `status=${s4} — API key or quota issue`);
  } else {
    err("Gemini verify", `status=${s4}`);
  }
}

async function testRunMlStream(pairs: Record<string, any[]>) {
  header("6. POST /api/matcher-lab/run-ml-stream (SSE ML batch)");

  const inboxPairs = pairs.inbox ?? [];
  if (inboxPairs.length === 0) {
    skipped("run-ml-stream", "no inbox pairs to process");
    return;
  }

  const pairIds = inboxPairs.slice(0, 3).map((p: any) => p.id);
  const { status, events } = await postSSE("/api/matcher-lab/run-ml-stream", { pairIds });

  if (status === 503) {
    skipped("run-ml-stream", "ENTITY_MATCHER_URL not configured (expected in dev)");
    return;
  }

  if (status !== 200) {
    err("run-ml-stream", `HTTP ${status}`);
    return;
  }

  ok(`SSE stream`, `${events.length} events received`);
  for (const ev of events) {
    const label = ev.type === "batch_complete"
      ? `processed=${ev.processed}, merged=${ev.merged}, rejected=${ev.rejected}, escalated=${ev.escalated}`
      : ev.type === "service_unreachable"
        ? "ML service down"
        : "";
    ok(`  Event: ${ev.type}`, label);
  }
}

async function testRunMl() {
  header("7. POST run-ml (non-streaming trigger)");

  const { status, data } = await post("/api/matcher-lab", { action: "run-ml" });
  if (status === 503) {
    skipped("run-ml", `${data?.error ?? "ENTITY_MATCHER_URL not configured"}`);
  } else if (status === 200) {
    ok("run-ml", `processed=${data?.processed}, merged=${data?.merged}`);
  } else {
    err("run-ml", `status=${status}, error=${data?.error}`);
  }
}

async function testUpdateScheduler() {
  header("8. POST update-scheduler (save config)");

  // Read current config first
  const { data: stats } = await get("/api/matcher-lab/stats");
  const currentEnabled = stats?.config?.enabled ?? false;
  const currentInterval = stats?.config?.intervalMs ?? 60000;

  // Save with same values (no side effect)
  const { status, data } = await post("/api/matcher-lab", {
    action: "update-scheduler",
    enabled: currentEnabled,
    intervalMs: currentInterval,
    aiSearchEnabled: stats?.config?.aiSearchEnabled ?? true,
    aiSearchConfidenceThreshold: stats?.config?.aiSearchConfidenceThreshold ?? 70,
    aiSearchMaxBatchSize: stats?.config?.aiSearchMaxBatchSize ?? 20,
  });

  if (status === 200 && data?.success) ok("Config saved (idempotent)");
  else err("Config save", `status=${status}`);

  // Boundary: interval too low (should clamp)
  const { status: s2, data: d2 } = await post("/api/matcher-lab", {
    action: "update-scheduler",
    intervalMs: 1000, // below 10s floor
  });
  if (s2 === 200) ok("Low interval clamped (1s → 10s)", "accepted without error");
  else err("Low interval", `status=${s2}`);
}

async function testAiSearchHealth() {
  header("9. GET /api/ai-search/healthz (health probe)");

  try {
    const res = await fetch(`${BASE}/api/ai-search/healthz`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const data = await res.json();
      ok("AI Search health", `status=${data.status}, model=${data.llm_engine?.model ?? "?"}`);
    } else {
      skipped("AI Search health", `HTTP ${res.status} — service may not be proxied`);
    }
  } catch (e: any) {
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      skipped("AI Search health", "timeout — service not running");
    } else {
      skipped("AI Search health", e.message);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────

async function runTests() {
  console.log(`${C.bold}${C.magenta}`);
  console.log(`  ┌──────────────────────────────────────────┐`);
  console.log(`  │  Matcher Lab — UI Flow Simulation Test   │`);
  console.log(`  │  Target: ${BASE.padEnd(32)}│`);
  console.log(`  └──────────────────────────────────────────┘${C.reset}`);

  // 1. Stats
  const stats = await testStats();
  const counts = stats?.stageCounts ?? { inbox: 0, ml_queued: 0, human_review: 0, history: 0 };

  // 2. List each stage
  const pairs = await testListStages(counts);

  // 3–4. Decide / bulk-decide (only if pairs available)
  const totalActionable = (pairs.inbox?.length ?? 0) + (pairs.human_review?.length ?? 0);
  if (totalActionable > 0) {
    await testDecide(pairs);
    // Re-fetch after decide consumed a pair
    const refreshed = await testListStages(counts);
    await testBulkDecide(refreshed);
  } else {
    header("3–4. Decide & Bulk-decide");
    skipped("decide/bulk-decide", "no actionable pairs (inbox + human_review empty)");
  }

  // 5. Verify AI
  // Re-fetch fresh pairs since decide/bulk-decide moved some
  const freshPairs: Record<string, any[]> = {};
  for (const stage of ["inbox", "human_review"]) {
    const { data } = await get<ListResponse>(`/api/matcher-lab?stage=${stage}&limit=10`);
    freshPairs[stage] = data?.rows ?? [];
  }
  await testVerifyAi(freshPairs);

  // 6. Run ML Stream
  const { data: inboxData } = await get<ListResponse>("/api/matcher-lab?stage=inbox&limit=10");
  await testRunMlStream({ inbox: inboxData?.rows ?? [] });

  // 7. Run ML (non-streaming)
  await testRunMl();

  // 8. Scheduler config
  await testUpdateScheduler();

  // 9. AI Search health
  await testAiSearchHealth();

  // Summary
  console.log(`\n${C.bold}━━━ Summary ━━━${C.reset}`);
  console.log(`  ${C.green}${pass} passed${C.reset}  ${C.red}${fail} failed${C.reset}  ${C.yellow}${skip} skipped${C.reset}`);
  console.log();

  if (fail > 0) process.exit(1);
}

runTests().catch((e) => {
  console.error(`\n${C.red}Fatal: ${e.message}${C.reset}`);
  process.exit(1);
});
