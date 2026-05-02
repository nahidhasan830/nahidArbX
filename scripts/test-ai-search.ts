/**
 * Test script: run 5 human_review pairs through AI Search /entity-match.
 * Tests the local Groq + web grounding service.
 *
 * Usage: npx tsx scripts/test-ai-search.ts
 */
import "dotenv/config";
import { db, ensureDbReady } from "../lib/db/client";
import { matchSingle } from "../lib/matching/ai-search-client";
import { logger } from "../lib/shared/logger";

async function main() {
  await ensureDbReady();

  // Fetch 5 pairs in human_review stage
  const rows = await db.execute(
    `SELECT
       id,
       event_a_home_team AS "eventAHome",
       event_a_away_team AS "eventAAway",
       event_a_competition AS "eventAComp",
       event_a_start_time AS "eventAStart",
       event_a_provider AS "eventAProvider",
       event_b_home_team AS "eventBHome",
       event_b_away_team AS "eventBAway",
       event_b_competition AS "eventBComp",
       event_b_start_time AS "eventBStart",
       event_b_provider AS "eventBProvider",
       string_score AS "stringScore",
       ml_combined_score AS "mlScore"
     FROM match_pairs
     WHERE stage = 'human_review'
     ORDER BY detected_at DESC
     LIMIT 5`
  );

  const pairs = rows.rows;
  if (pairs.length === 0) {
    console.log("No pairs in human_review. Run ML first to populate some.");
    process.exit(0);
  }

  console.log(`Testing ${pairs.length} human_review pairs against AI Search...\n`);

  let tested = 0;
  let same = 0;
  let different = 0;
  let uncertain = 0;
  let failed = 0;

  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i] as Record<string, unknown>;
    const pairId = p.id as string;

    console.log(`── Pair ${i + 1}/${pairs.length} ──`);
    console.log(`  ID: ${pairId}`);
    console.log(`  A: [${p.eventAProvider}] ${p.eventAHome} vs ${p.eventAAway} — ${p.eventAComp} @ ${(p.eventAStart as string)?.slice(0, 16)}`);
    console.log(`  B: [${p.eventBProvider}] ${p.eventBHome} vs ${p.eventBAway} — ${p.eventBComp} @ ${(p.eventBStart as string)?.slice(0, 16)}`);
    console.log(`  String: ${((p.stringScore as number) * 100).toFixed(0)}%  ML: ${p.mlScore != null ? ((p.mlScore as number) * 100).toFixed(0) + '%' : '—'}`);
    console.log(`  Calling /entity-match...`);

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
      console.log(`  ✗ FAIL — AI Search service unreachable (${elapsed}s)\n`);
      failed++;
      continue;
    }

    tested++;
    const icon = verdict.decision === "SAME" ? "🔗" : verdict.decision === "DIFFERENT" ? "✗" : "❓";
    console.log(`  ${icon} ${verdict.decision} (${verdict.confidence}%) · model: ${verdict.model} · ${elapsed}s`);
    console.log(`  Reasoning: ${verdict.reasoning.slice(0, 250)}${verdict.reasoning.length > 250 ? '…' : ''}`);

    if (verdict.sources.length > 0) {
      console.log(`  Sources (${verdict.sources.length}):`);
      for (const src of verdict.sources.slice(0, 3)) {
        console.log(`    • ${src.title}: ${src.url}`);
        if (src.snippet) console.log(`      "${src.snippet.slice(0, 120)}"`);
      }
    }

    if (verdict.search_queries_used.length > 0) {
      console.log(`  Queries: ${verdict.search_queries_used.map(q => `"${q}"`).join(', ')}`);
    }

    if (verdict.decision === "SAME") same++;
    else if (verdict.decision === "DIFFERENT") different++;
    else uncertain++;
    console.log();
  }

  console.log(`═══════════════════════════════════`);
  console.log(`Results: ${tested} tested, ${failed} failed`);
  console.log(`  🔗 SAME:      ${same}`);
  console.log(`  ✗ DIFFERENT:  ${different}`);
  console.log(`  ❓ UNCERTAIN: ${uncertain}`);
  console.log(`═══════════════════════════════════`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Script failed:", err.message);
  process.exit(1);
});
