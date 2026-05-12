#!/usr/bin/env npx tsx
/**
 * Simulate AI Search Grounding Resolution
 *
 * Picks 3 pairs from the human_review stage, sends each through the
 * AI Search service (Groq + web grounding at localhost:8090), and
 * if the verdict is confident enough (≥ 70%), auto-decides the pair
 * via markDecided() — moving it to the history stage.
 *
 * Usage:  npx tsx scripts/simulate-ai-search-resolve.ts
 * Requires: AI Search service running (services/ai-search) + DB.
 */
import "dotenv/config";
import { ensureDbReady, db } from "../lib/db/client";
import { matchSingle } from "../lib/matching/ai-search-client";
import { getById, markDecided } from "../lib/db/repositories/match-pairs";

// ── Config ─────────────────────────────────────────────────────────────

const PICK_COUNT = 3;
const CONFIDENCE_THRESHOLD = 70;

// ── Colors ─────────────────────────────────────────────────────────────

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

function banner(msg: string) {
  console.log(`\n${C.bold}${C.cyan}━━━ ${msg} ━━━${C.reset}`);
}

function ok(msg: string, detail?: string) {
  console.log(
    `  ${C.green}✓${C.reset} ${msg}${detail ? C.dim + " — " + detail + C.reset : ""}`,
  );
}

function fail(msg: string, detail?: string) {
  console.log(
    `  ${C.red}✗${C.reset} ${msg}${detail ? C.dim + " — " + detail + C.reset : ""}`,
  );
}

function warn(msg: string, detail?: string) {
  console.log(
    `  ${C.yellow}○${C.reset} ${msg}${detail ? C.dim + " — " + detail + C.reset : ""}`,
  );
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`${C.bold}${C.magenta}`);
  console.log(`  ┌──────────────────────────────────────────────────┐`);
  console.log(`  │  AI Search Grounding → History Resolve Sim      │`);
  console.log(
    `  │  Pick ${PICK_COUNT} human_review pairs, run AI search,     │`,
  );
  console.log(`  │  auto-decide if confident, verify in history.   │`);
  console.log(
    `  └──────────────────────────────────────────────────┘${C.reset}`,
  );

  // ── Step 1: Init DB ──
  banner("Step 1 — Initialize DB connection");
  await ensureDbReady();
  ok("Database ready");

  // ── Step 2: Fetch human_review pairs ──
  banner(`Step 2 — Fetch ${PICK_COUNT} pairs from human_review`);
  const result = await db.execute(
    `SELECT
       id,
       event_a_home_team   AS "eventAHome",
       event_a_away_team   AS "eventAAway",
       event_a_competition AS "eventAComp",
       event_a_start_time  AS "eventAStart",
       event_a_provider    AS "eventAProvider",
       event_b_home_team   AS "eventBHome",
       event_b_away_team   AS "eventBAway",
       event_b_competition AS "eventBComp",
       event_b_start_time  AS "eventBStart",
       event_b_provider    AS "eventBProvider",
       string_score        AS "stringScore",
       ml_combined_score   AS "mlScore"
     FROM match_pairs
     WHERE stage = 'human_review'
     ORDER BY detected_at DESC
     LIMIT ${PICK_COUNT}`,
  );

  const pairs = result.rows as Record<string, unknown>[];
  if (pairs.length === 0) {
    fail("No pairs found in human_review stage");
    console.log(
      `\n  ${C.dim}Run the ML batch first to populate human_review.${C.reset}`,
    );
    process.exit(1);
  }

  ok(`Found ${pairs.length} pair(s) in human_review`);
  for (const p of pairs) {
    console.log(
      `    ${C.dim}${(p.id as string).slice(0, 8)}… [${p.eventAProvider}] ${p.eventAHome} v ${p.eventAAway}  ↔  [${p.eventBProvider}] ${p.eventBHome} v ${p.eventBAway}${C.reset}`,
    );
  }

  // ── Step 3: AI Search for each ──
  banner("Step 3 — Run each pair through AI Search (Groq + web grounding)");

  let resolved = 0;
  let unresolved = 0;
  let errored = 0;

  const resolvedIds: string[] = [];

  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const pairId = p.id as string;
    const shortId = pairId.slice(0, 8);

    console.log(
      `\n  ${C.bold}Pair ${i + 1}/${pairs.length}${C.reset} ${C.dim}(${shortId}…)${C.reset}`,
    );
    console.log(
      `    A: [${p.eventAProvider}] ${p.eventAHome} v ${p.eventAAway} — ${p.eventAComp}`,
    );
    console.log(
      `    B: [${p.eventBProvider}] ${p.eventBHome} v ${p.eventBAway} — ${p.eventBComp}`,
    );
    console.log(
      `    String: ${((p.stringScore as number) * 100).toFixed(0)}%  ML: ${p.mlScore != null ? ((p.mlScore as number) * 100).toFixed(0) + "%" : "—"}`,
    );
    console.log(`    ${C.dim}Calling /entity-match …${C.reset}`);

    const t0 = Date.now();
    const verdict = await matchSingle(
      {
        home_team: p.eventAHome as string,
        away_team: p.eventAAway as string,
        competition: p.eventAComp as string,
        start_time: p.eventAStart as string,
        provider: p.eventAProvider as string,
      },
      {
        home_team: p.eventBHome as string,
        away_team: p.eventBAway as string,
        competition: p.eventBComp as string,
        start_time: p.eventBStart as string,
        provider: p.eventBProvider as string,
      },
    );
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    if (!verdict) {
      fail(`AI Search unreachable`, `${elapsed}s`);
      errored++;
      continue;
    }

    const icon =
      verdict.decision === "SAME"
        ? "🔗"
        : verdict.decision === "DIFFERENT"
          ? "✗"
          : "❓";

    console.log(
      `    ${icon} ${C.bold}${verdict.decision}${C.reset} (${verdict.confidence}%) · ${verdict.model} · ${elapsed}s`,
    );
    console.log(
      `    ${C.dim}Reasoning: ${verdict.reasoning.slice(0, 200)}${verdict.reasoning.length > 200 ? "…" : ""}${C.reset}`,
    );

    if (verdict.sources.length > 0) {
      console.log(`    Sources (${verdict.sources.length}):`);
      for (const src of verdict.sources.slice(0, 3)) {
        console.log(`      • ${src.title}: ${src.url}`);
      }
    }
    if (verdict.search_queries_used.length > 0) {
      console.log(
        `    Queries: ${verdict.search_queries_used.map((q) => `"${q}"`).join(", ")}`,
      );
    }

    // ── Auto-decide if confident enough ──
    if (verdict.confidence >= CONFIDENCE_THRESHOLD) {
      const decision = verdict.decision === "SAME" ? "ai-merge" : "ai-reject";
      const decidedBy = "ai-search" as const;
      const reason = `ai-search: ${verdict.decision} ${verdict.confidence}% — ${verdict.reasoning.slice(0, 200)}`;

      const decided = await markDecided(pairId, decision, decidedBy, reason);

      if (decided) {
        ok(
          `Decided → ${decision}`,
          `pair moved to history (${verdict.confidence}% ≥ ${CONFIDENCE_THRESHOLD}% threshold)`,
        );
        resolved++;
        resolvedIds.push(pairId);
      } else {
        fail(`markDecided returned false`, `pair may have already moved`);
        errored++;
      }
    } else {
      warn(
        `Confidence too low (${verdict.confidence}% < ${CONFIDENCE_THRESHOLD}%)`,
        `stays in human_review`,
      );
      unresolved++;
    }
  }

  // ── Step 4: Verify resolved pairs landed in history ──
  banner("Step 4 — Verify resolved pairs are in history");

  if (resolvedIds.length === 0) {
    warn("No pairs were resolved", "nothing to verify");
  } else {
    let verified = 0;
    for (const id of resolvedIds) {
      const row = await getById(id);
      if (!row) {
        fail(`Pair ${id.slice(0, 8)}…`, "not found in DB");
        continue;
      }
      if (row.stage === "history") {
        ok(
          `${id.slice(0, 8)}… → history`,
          `decision=${row.decision}, decidedBy=${row.decidedBy}`,
        );
        verified++;
      } else {
        fail(`${id.slice(0, 8)}… still in ${row.stage}`, `expected history`);
      }
    }
    if (verified === resolvedIds.length) {
      ok(`All ${verified} resolved pair(s) confirmed in history ✓`);
    }
  }

  // ── Summary ──
  console.log(`\n${C.bold}━━━ Summary ━━━${C.reset}`);
  console.log(`  Pairs tested:    ${pairs.length}`);
  console.log(`  ${C.green}Resolved → history: ${resolved}${C.reset}`);
  console.log(`  ${C.yellow}Stays in review:    ${unresolved}${C.reset}`);
  console.log(`  ${C.red}Errors:             ${errored}${C.reset}`);
  console.log();

  process.exit(0);
}

main().catch((err) => {
  console.error(`\n${C.red}Fatal: ${err.message}${C.reset}`);
  process.exit(1);
});
