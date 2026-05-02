#!/usr/bin/env npx tsx
/**
 * Debug script: Compare value bet counts between showOnlyValue=true and false.
 *
 * Hits the value-bets API (engine direct or Next.js proxy) with different
 * filter combos and reports mismatches.
 *
 * Usage: npx tsx scripts/debug-value-bet-counts.ts
 *
 * Environment:
 *   ENGINE_URL (default: tries engine:3001, falls back to next:3000)
 */

const NEXT_BASE = "http://localhost:3000";
const ENGINE_BASE = "http://127.0.0.1:3001";

interface AtomResult {
  atomId: string;
  label: string;
  valueBet?: {
    evPct: number;
    softProvider: string;
    softOdds: number;
    sharpOdds: number;
    timestamp: number;
  };
}

interface FamilyResult {
  familyId: string;
  label: string;
  marketType: string;
  atoms: AtomResult[];
}

interface EventResult {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  families: FamilyResult[];
}

interface ApiResponse {
  events: EventResult[];
  summary: {
    totalEvents: number;
    matchedEvents: number;
    eventsWithValue: number;
    totalValueBets: number;
    bestEvPct: number | null;
  };
  pagination?: {
    page: number;
    pageSize: number;
    hasMore: boolean;
    totalCount: number;
  };
  _engineError?: string;
}

let BASE_URL = "";

async function detectBaseUrl(): Promise<string> {
  // Try engine first
  try {
    const res = await fetch(`${ENGINE_BASE}/engine/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      console.log("✓ Using engine API directly (port 3001)");
      return ENGINE_BASE + "/engine/value-bets";
    }
  } catch {}

  // Fall back to Next.js proxy
  try {
    const res = await fetch(`${NEXT_BASE}/api/value-bets?page=0&pageSize=1`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json() as ApiResponse;
      if (data._engineError) {
        console.error("❌ Engine is unreachable (Next.js proxy returned _engineError).");
        console.error("   Start the engine first: npm run engine");
        process.exit(1);
      }
      console.log("✓ Using Next.js proxy (port 3000)");
      return NEXT_BASE + "/api/value-bets";
    }
  } catch {}

  console.error("❌ Neither engine (3001) nor Next.js (3000) is responding.");
  console.error("   Start both: npm run dev:all");
  process.exit(1);
}

async function fetchApi(params: Record<string, string>): Promise<ApiResponse> {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE_URL}?${qs}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

function countValueBetsInEvents(events: EventResult[]): {
  atomCount: number;
  familyCount: number;
  atomDetails: { eventId: string; familyId: string; atomId: string; evPct: number; softProvider: string; softOdds: number; timestamp: number }[];
} {
  const familyKeys = new Set<string>();
  const atomDetails: typeof countValueBetsInEvents extends (...args: any) => { atomDetails: infer T } ? T : never = [];

  for (const event of events) {
    for (const family of event.families) {
      for (const atom of family.atoms) {
        if (atom.valueBet && atom.valueBet.evPct > 0) {
          familyKeys.add(`${event.eventId}|${family.familyId}`);
          atomDetails.push({
            eventId: event.eventId,
            familyId: family.familyId,
            atomId: atom.atomId,
            evPct: atom.valueBet.evPct,
            softProvider: atom.valueBet.softProvider,
            softOdds: atom.valueBet.softOdds,
            timestamp: atom.valueBet.timestamp,
          });
        }
      }
    }
  }

  return { atomCount: atomDetails.length, familyCount: familyKeys.size, atomDetails };
}

async function fetchAllPages(params: Record<string, string>): Promise<{ events: EventResult[]; summary: ApiResponse["summary"] }> {
  const allEvents: EventResult[] = [];
  let page = 0;
  let summary: ApiResponse["summary"] | null = null;

  while (true) {
    const res = await fetchApi({ ...params, page: String(page), pageSize: "100" });
    if (page === 0) summary = res.summary;
    allEvents.push(...res.events);
    if (!res.pagination?.hasMore) break;
    page++;
    if (page > 50) break; // safety
  }

  return { events: allEvents, summary: summary! };
}

async function main() {
  BASE_URL = await detectBaseUrl();

  console.log();
  console.log("=".repeat(80));
  console.log("VALUE BET COUNT DIAGNOSTIC");
  console.log("=".repeat(80));
  console.log();

  // ── Test 1: showOnlyValue=false (unchecked) — all events, page 0 only ──
  console.log("── TEST 1: showOnlyValue=false, page 0 only (simulates badge) ──");
  const uncheckedPage0 = await fetchApi({ showOnlyValue: "false", page: "0", pageSize: "50" });
  const uncheckedPage0Counts = countValueBetsInEvents(uncheckedPage0.events);
  console.log(`  Events loaded:         ${uncheckedPage0.events.length}`);
  console.log(`  summary.totalVBs:      ${uncheckedPage0.summary.totalValueBets}`);
  console.log(`  summary.eventsWithVB:  ${uncheckedPage0.summary.eventsWithValue}`);
  console.log(`  Atoms with VB (page):  ${uncheckedPage0Counts.atomCount}`);
  console.log(`  Families with VB:      ${uncheckedPage0Counts.familyCount}  ← badge number (client-side)`);
  console.log(`  Pagination total:      ${uncheckedPage0.pagination?.totalCount}`);
  console.log(`  Has more pages:        ${uncheckedPage0.pagination?.hasMore}`);
  console.log();

  // ── Test 2: showOnlyValue=true (checked) — value-only events, page 0 only ──
  console.log("── TEST 2: showOnlyValue=true, page 0 only (simulates checked state) ──");
  const checkedPage0 = await fetchApi({ showOnlyValue: "true", page: "0", pageSize: "50" });
  const checkedPage0Counts = countValueBetsInEvents(checkedPage0.events);
  console.log(`  Events loaded:         ${checkedPage0.events.length}`);
  console.log(`  summary.totalVBs:      ${checkedPage0.summary.totalValueBets}`);
  console.log(`  summary.eventsWithVB:  ${checkedPage0.summary.eventsWithValue}`);
  console.log(`  Atoms with VB (page):  ${checkedPage0Counts.atomCount}`);
  console.log(`  Families with VB:      ${checkedPage0Counts.familyCount}  ← "actual" number when checked`);
  console.log(`  Pagination total:      ${checkedPage0.pagination?.totalCount}`);
  console.log(`  Has more pages:        ${checkedPage0.pagination?.hasMore}`);
  console.log();

  // ── Test 3: showOnlyValue=false, ALL pages ──
  console.log("── TEST 3: showOnlyValue=false, ALL pages ──");
  const uncheckedAll = await fetchAllPages({ showOnlyValue: "false" });
  const uncheckedAllCounts = countValueBetsInEvents(uncheckedAll.events);
  console.log(`  Total events loaded:   ${uncheckedAll.events.length}`);
  console.log(`  summary.totalVBs:      ${uncheckedAll.summary.totalValueBets}`);
  console.log(`  Atoms with VB (all):   ${uncheckedAllCounts.atomCount}`);
  console.log(`  Families with VB:      ${uncheckedAllCounts.familyCount}`);
  console.log();

  // ── Test 4: showOnlyValue=true, ALL pages ──
  console.log("── TEST 4: showOnlyValue=true, ALL pages ──");
  const checkedAll = await fetchAllPages({ showOnlyValue: "true" });
  const checkedAllCounts = countValueBetsInEvents(checkedAll.events);
  console.log(`  Total events loaded:   ${checkedAll.events.length}`);
  console.log(`  summary.totalVBs:      ${checkedAll.summary.totalValueBets}`);
  console.log(`  Atoms with VB (all):   ${checkedAllCounts.atomCount}`);
  console.log(`  Families with VB:      ${checkedAllCounts.familyCount}`);
  console.log();

  // ── Comparison ──
  console.log("=".repeat(80));
  console.log("COMPARISON");
  console.log("=".repeat(80));
  console.log();

  const badgeCount = uncheckedPage0Counts.familyCount;
  const actualCheckedPage0 = checkedPage0Counts.familyCount;
  const fullUnchecked = uncheckedAllCounts.familyCount;
  const fullChecked = checkedAllCounts.familyCount;
  const summaryTotalVBs = uncheckedPage0.summary.totalValueBets;

  console.log("  Count source                    | Families | Atoms");
  console.log("  ────────────────────────────────┼──────────┼──────");
  console.log(`  Badge (unchecked, page 0)       | ${String(badgeCount).padStart(8)} | ${uncheckedPage0Counts.atomCount}`);
  console.log(`  Checked (page 0)                | ${String(actualCheckedPage0).padStart(8)} | ${checkedPage0Counts.atomCount}`);
  console.log(`  Unchecked (all pages)           | ${String(fullUnchecked).padStart(8)} | ${uncheckedAllCounts.atomCount}`);
  console.log(`  Checked (all pages)             | ${String(fullChecked).padStart(8)} | ${checkedAllCounts.atomCount}`);
  console.log(`  summary.totalValueBets          | ${String(summaryTotalVBs).padStart(8)} | (raw store count)`);
  console.log();

  // ── Diagnosis ──
  console.log("── DIAGNOSIS ──");
  console.log();

  let issues = 0;

  // Issue 1: Badge vs checked page 0
  if (badgeCount !== actualCheckedPage0) {
    issues++;
    console.log(`  ❌ ISSUE ${issues}: Badge (${badgeCount}) ≠ Checked page 0 (${actualCheckedPage0})`);
    if (badgeCount < actualCheckedPage0) {
      console.log(`     → Value bets exist on events not loaded in unchecked page 0`);
      console.log(`     → Root cause: PAGINATION — unchecked paginates ALL events, checked paginates only VB events`);
    } else {
      console.log(`     → More VBs in unchecked than checked — possibly phantom/stale VBs or filter inconsistency`);
    }
    console.log();
  }

  // Issue 2: Full unchecked vs full checked
  if (fullUnchecked !== fullChecked) {
    issues++;
    console.log(`  ❌ ISSUE ${issues}: Full unchecked (${fullUnchecked}) ≠ Full checked (${fullChecked})`);

    // Find the diff
    const checkedKeys = new Set(checkedAllCounts.atomDetails.map(d => `${d.eventId}|${d.familyId}|${d.atomId}`));
    const uncheckedKeys = new Set(uncheckedAllCounts.atomDetails.map(d => `${d.eventId}|${d.familyId}|${d.atomId}`));

    const phantoms = uncheckedAllCounts.atomDetails.filter(d => !checkedKeys.has(`${d.eventId}|${d.familyId}|${d.atomId}`));
    const hidden = checkedAllCounts.atomDetails.filter(d => !uncheckedKeys.has(`${d.eventId}|${d.familyId}|${d.atomId}`));

    if (phantoms.length > 0) {
      console.log(`     → ${phantoms.length} PHANTOM VBs (in unchecked, NOT in checked):`);
      for (const vb of phantoms.slice(0, 5)) {
        const age = Math.round((Date.now() - vb.timestamp) / 1000);
        console.log(`       ${vb.atomId.substring(0, 40)} @ ${vb.softProvider} EV=${vb.evPct}% odds=${vb.softOdds} age=${age}s`);
      }
      console.log(`     → Root cause: server attaches VBs to atoms even when showOnlyValue=false`);
      console.log(`       but showOnlyValue=true skips atoms without qualifying VBs`);
    }
    if (hidden.length > 0) {
      console.log(`     → ${hidden.length} HIDDEN VBs (in checked, NOT in unchecked):`);
      for (const vb of hidden.slice(0, 5)) {
        const age = Math.round((Date.now() - vb.timestamp) / 1000);
        console.log(`       ${vb.atomId.substring(0, 40)} @ ${vb.softProvider} EV=${vb.evPct}% odds=${vb.softOdds} age=${age}s`);
      }
    }
    console.log();
  }

  // Issue 3: Pagination mismatch
  if (badgeCount !== fullUnchecked) {
    issues++;
    console.log(`  ❌ ISSUE ${issues}: Badge page-0 (${badgeCount}) ≠ All-pages unchecked (${fullUnchecked})`);
    console.log(`     → ${fullUnchecked - badgeCount} value bets are on events beyond page 0`);
    console.log(`     → Root cause: PAGINATION truncation — badge only sees loaded events`);
    console.log();
  }

  // Issue 4: summary.totalValueBets vs actual atom count
  if (summaryTotalVBs !== uncheckedAllCounts.atomCount) {
    issues++;
    console.log(`  ❌ ISSUE ${issues}: summary.totalValueBets (${summaryTotalVBs}) ≠ atom-level count (${uncheckedAllCounts.atomCount})`);
    console.log(`     → summary.totalValueBets comes from store.valueBets.length (raw)`);
    console.log(`     → atom-level count comes from events[].families[].atoms[].valueBet`);
    console.log(`     → Possible mismatch if store has VBs for events not in current query`);
    console.log();
  }

  // Stale VBs check
  const now = Date.now();
  const staleVBs = uncheckedAllCounts.atomDetails.filter(d => now - d.timestamp > 90_000);
  if (staleVBs.length > 0) {
    issues++;
    console.log(`  ⚠️  ISSUE ${issues}: ${staleVBs.length} STALE VBs (odds > 90s old):`);
    for (const vb of staleVBs.slice(0, 5)) {
      const age = Math.round((now - vb.timestamp) / 1000);
      console.log(`     ${vb.atomId.substring(0, 40)} @ ${vb.softProvider} age=${age}s`);
    }
    console.log();
  }

  if (issues === 0) {
    console.log("  ✅ No count inconsistencies detected. Counts match across all modes.");
  } else {
    console.log(`  Found ${issues} issue(s) — see above for root causes.`);
  }

  console.log();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Script failed:", err.message);
  process.exit(1);
});
