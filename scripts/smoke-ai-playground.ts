/**
 * Smoke test: replays exactly what the AI Playground page does
 * for a given query, and prints the raw responses from each stage.
 *
 * Reproduces the failing run for "Today football matches high voltage"
 * by hitting:
 *   GET  /api/ai-search/healthz
 *   GET  /api/ai-search/llm-stats
 *   POST /api/ai-search/search
 *   POST /api/ai-search/grounded-query
 *
 * Usage:
 *   npx tsx scripts/smoke-ai-playground.ts                     # default query
 *   npx tsx scripts/smoke-ai-playground.ts "your query here"
 *   BASE_URL=http://localhost:3000 npx tsx scripts/smoke-ai-playground.ts
 */

const BASE = process.env.BASE_URL || "http://localhost:3000";
const QUERY = process.argv[2] || "Today football matches high voltage";
// Default to deepseek/flash since that's what the screenshot showed.
const MODEL = process.env.MODEL || "deepseek-v4-flash";

const sep = (label: string) =>
  console.log(`\n\x1b[36m──── ${label} ${"─".repeat(Math.max(0, 60 - label.length))}\x1b[0m`);

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* leave as text */
  }
  return { status: res.status, body };
}

async function postJson(path: string, payload: object): Promise<unknown> {
  const t0 = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* leave as text */
  }
  return { status: res.status, ms, body };
}

async function main() {
  console.log(`\x1b[1mSmoke test\x1b[0m — base=${BASE}`);
  console.log(`Query : "${QUERY}"`);
  console.log(`Model : ${MODEL}`);

  // 1. Health
  sep("1. /api/ai-search/healthz");
  console.log(JSON.stringify(await getJson("/api/ai-search/healthz"), null, 2));

  // 2. LLM stats (per-engine state)
  sep("2. /api/ai-search/llm-stats");
  console.log(JSON.stringify(await getJson("/api/ai-search/llm-stats"), null, 2));

  // 3. Web search — what the playground sends in step 1
  sep("3. POST /api/ai-search/search");
  const searchResp = (await postJson("/api/ai-search/search", {
    query: QUERY,
    max_results: 5,
    service: "Playground",
  })) as { status: number; ms: number; body: Record<string, unknown> };
  console.log(`status=${searchResp.status}  ms=${searchResp.ms}`);
  console.log(`providerUsed=${searchResp.body.providerUsed}`);
  const results = (searchResp.body.results as unknown[]) || [];
  console.log(`results=${results.length}`);
  for (const [i, r] of results.entries()) {
    const row = r as { title?: string; url?: string; snippet?: string };
    console.log(
      `  [${i + 1}] ${row.title}\n      ${row.url}\n      ${(row.snippet ?? "").slice(0, 200)}`,
    );
  }

  // 4. Grounded query — exactly what the playground sends in step 2
  //    (skip_search=true, context = web_search_results from step 1)
  sep("4. POST /api/ai-search/grounded-query  (skip_search=true)");
  const groundedResp = (await postJson("/api/ai-search/grounded-query", {
    question: QUERY,
    context: { web_search_results: results },
    skip_search: true,
    model: MODEL,
    service: "Playground",
  })) as { status: number; ms: number; body: Record<string, unknown> };
  console.log(`status=${groundedResp.status}  ms=${groundedResp.ms}`);
  console.log("\n── answer ──");
  console.log(groundedResp.body.answer);
  console.log("\n── reasoning ──");
  console.log(groundedResp.body.reasoning);
  console.log("\n── sources ──");
  const srcs = (groundedResp.body.sources as unknown[]) || [];
  for (const [i, s] of srcs.entries()) {
    const row = s as { title?: string; url?: string };
    console.log(`  [${i + 1}] ${row.title} — ${row.url}`);
  }
  console.log(`\nmodel=${groundedResp.body.model}`);

  // 5. Sanity: same call but WITHOUT skip_search — let the service do its own search.
  //    Useful to compare if the proxied search step is the weak link.
  sep("5. POST /api/ai-search/grounded-query  (skip_search=false, no context)");
  const groundedFull = (await postJson("/api/ai-search/grounded-query", {
    question: QUERY,
    skip_search: false,
    model: MODEL,
    service: "Playground",
  })) as { status: number; ms: number; body: Record<string, unknown> };
  console.log(`status=${groundedFull.status}  ms=${groundedFull.ms}`);
  console.log("\n── answer ──");
  console.log(groundedFull.body.answer);
  console.log(`\nsources=${((groundedFull.body.sources as unknown[]) || []).length}`);

  sep("DONE");
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
