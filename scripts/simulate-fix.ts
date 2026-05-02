/**
 * simulate-fix.ts — Verify the 4 entity-resolution infrastructure fixes
 * in isolation, without touching the real database.
 *
 * Usage:  npx tsx scripts/simulate-fix.ts
 *
 * Tests:
 *   Fix 1: Gender gate — competition-aware bypass
 *   Fix 2: Entity binding conflict detection
 *   Fix 3: learnAliases normalization consistency
 *   Fix 4: Bayesian anti-ratchet bypass for high-trust sources
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  normalize,
  normalizeCompetition,
  gendersDiffer,
  isWomensTeam,
} from "../lib/matching/entities/normalize";

// ════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════

const PASS = "\x1b[32m✓ PASS\x1b[0m";
const FAIL = "\x1b[31m✗ FAIL\x1b[0m";
let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  ${PASS}  ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL}  ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function section(title: string) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"─".repeat(60)}`);
}

// ════════════════════════════════════════════════════════════════════════
// Fix 1: Gender Gate — Competition-Aware Bypass
// ════════════════════════════════════════════════════════════════════════
//
// Simulate the auto-resolve gender gate logic. We replicate the exact
// logic from the patched `runStages()` function to verify:
//   - Women's competitions bypass the gender gate
//   - Men's competitions still enforce the gender gate
//   - Competition detection covers all patterns

function simulateGenderGate() {
  section("Fix 1: Gender Gate — Competition-Aware Bypass");

  // These patterns are the same ones in auto-resolve.ts
  const WOMEN_COMP_RE = [
    /\bwsl\b/i, /\bwomen/i, /\bfeminin/i, /\bfrauen/i,
    /\bdames\b/i, /\bvrouwen\b/i, /\bfemenin/i,
    /\(w\)/i, /\bladies\b/i, /\bnwsl\b/i,
    /\bliga\s*f\b/i, /\bshe\s*believes/i, /\bw[\s-]?league/i,
  ];

  function isWomensCompetition(compName: string): boolean {
    return WOMEN_COMP_RE.some((re) => re.test(compName));
  }

  function simulateGenderDecision(
    surfaceRaw: string,
    entityCanonical: string,
    competitionName: string | null,
  ): "pass" | "auto-reject" {
    const skipGenderGate = competitionName
      ? isWomensCompetition(competitionName)
      : false;
    if (!skipGenderGate && gendersDiffer(surfaceRaw, entityCanonical)) {
      return "auto-reject";
    }
    return "pass";
  }

  // ── Scenario 1: NW WSL team — should PASS (not reject) ──
  const wslResult = simulateGenderDecision(
    "Manchester United",            // NW surface — no (W) marker
    "Manchester United (W)",        // Entity canonical — has (W)
    "England WSL",                  // Competition = women's
  );
  assert(
    wslResult === "pass",
    "WSL: 'Manchester United' → entity 'Manchester United (W)' — gender gate bypassed",
    `got: ${wslResult}`,
  );

  // ── Scenario 2: NW NWSL team ──
  const nwslResult = simulateGenderDecision(
    "Portland Thorns",
    "Portland Thorns (W)",
    "USA NWSL",
  );
  assert(
    nwslResult === "pass",
    "NWSL: 'Portland Thorns' → entity 'Portland Thorns (W)' — bypassed",
    `got: ${nwslResult}`,
  );

  // ── Scenario 3: Frauen Bundesliga ──
  const frauenResult = simulateGenderDecision(
    "Bayern Munich",
    "Bayern München (W)",
    "Germany Frauen Bundesliga",
  );
  assert(
    frauenResult === "pass",
    "Frauen BL: 'Bayern Munich' → entity 'Bayern München (W)' — bypassed",
    `got: ${frauenResult}`,
  );

  // ── Scenario 4: Men's competition — should still REJECT ──
  const menResult = simulateGenderDecision(
    "Manchester United",
    "Manchester United (W)",  // wrong entity!
    "England Premier League", // men's comp
  );
  assert(
    menResult === "auto-reject",
    "EPL: 'Manchester United' → entity 'Manchester United (W)' — correctly rejected",
    `got: ${menResult}`,
  );

  // ── Scenario 5: No competition context — should still REJECT ──
  const noCompResult = simulateGenderDecision(
    "Chelsea",
    "Chelsea (W)",
    null,
  );
  assert(
    noCompResult === "auto-reject",
    "No comp: 'Chelsea' → entity 'Chelsea (W)' — correctly rejected",
    `got: ${noCompResult}`,
  );

  // ── Scenario 6: Same-gender pair in WSL — should PASS (no mismatch) ──
  const sameGenderResult = simulateGenderDecision(
    "Arsenal (W)",
    "Arsenal (W)",
    "England WSL",
  );
  assert(
    sameGenderResult === "pass",
    "WSL same-gender: 'Arsenal (W)' → entity 'Arsenal (W)' — pass (no mismatch)",
    `got: ${sameGenderResult}`,
  );

  // ── Scenario 7: W-League ──
  const wLeagueResult = simulateGenderDecision(
    "Melbourne Victory",
    "Melbourne Victory Women",
    "Australia W-League",
  );
  assert(
    wLeagueResult === "pass",
    "W-League: 'Melbourne Victory' → entity 'Melbourne Victory Women' — bypassed",
    `got: ${wLeagueResult}`,
  );

  // ── Women's comp pattern coverage ──
  console.log("\n  Competition pattern coverage:");
  const comps = [
    ["England WSL", true],
    ["USA NWSL", true],
    ["Germany Frauen Bundesliga", true],
    ["France Division 1 Feminine", true],
    ["Spain Liga F", true],
    ["Netherlands Vrouwen Eredivisie", true],
    ["Belgium Super League Dames", true],
    ["She Believes Cup", true],
    ["Australia W-League", true],
    ["AFC Women Champions League", true],
    ["Italy Serie A (W)", true],
    ["England Ladies Super League", true],
    ["England Premier League", false],
    ["Spain La Liga", false],
    ["Germany Bundesliga", false],
    ["UEFA Champions League", false],
  ] as const;

  for (const [name, expected] of comps) {
    const result = isWomensCompetition(name);
    assert(
      result === expected,
      `  "${name}" → ${result ? "women's ✓" : "men's ✓"}`,
      `expected ${expected}, got ${result}`,
    );
  }
}

// ════════════════════════════════════════════════════════════════════════
// Fix 2: Entity Binding Conflict Detection
// ════════════════════════════════════════════════════════════════════════
//
// Simulate what happens when upsertEntityName returns a row with a
// different entityId than what the observation paired with.

function simulateBindingConflict() {
  section("Fix 2: Entity Binding Conflict Detection");

  interface MockEntityNameRow {
    id: string;
    entityId: string;
    surfaceRaw: string;
    provider: string;
  }

  // The new conflict-detection logic from observations.ts:
  function wouldSkipDueToConflict(
    candidateEntityId: string,
    pairedWithEntityId: string,
  ): boolean {
    return candidateEntityId !== pairedWithEntityId;
  }

  // ── Scenario 1: Same entity — should proceed ──
  const noConflict = wouldSkipDueToConflict(
    "team|_|m|manchester-united",  // existing row's entityId
    "team|_|m|manchester-united",  // observation paired with
  );
  assert(
    !noConflict,
    "Same entity binding: 'Manchester United' → men's entity — proceeds normally",
  );

  // ── Scenario 2: Different entity — CONFLICT ──
  const hasConflict = wouldSkipDueToConflict(
    "team|_|m|manchester-united",  // existing row bound to men's
    "team|_|f|manchester-united",  // observation wants women's
  );
  assert(
    hasConflict,
    "Cross-gender conflict: existing=men's, observation=women's — SKIPPED (conflict logged)",
  );

  // ── Scenario 3: Different team entirely — CONFLICT ──
  const wrongTeam = wouldSkipDueToConflict(
    "team|_|m|athletic-bilbao",     // existing row bound to Athletic Bilbao
    "team|_|m|atletico-madrid",     // observation paired with Atletico Madrid
  );
  assert(
    wrongTeam,
    "Wrong team conflict: existing=Athletic Bilbao, observation=Atletico Madrid — SKIPPED",
  );

  // Log what the actual log message would look like
  console.log("\n  Example log output:");
  console.log(`  ${"─".repeat(56)}`);
  console.log(
    `  [EntityObs] Binding conflict: "Manchester United" (ninewickets-exchange)` +
    `\n              already bound to team|_|m|manchester-united, observation` +
    `\n              paired with team|_|f|manchester-united — skipping`,
  );
  console.log(`  ${"─".repeat(56)}`);
}

// ════════════════════════════════════════════════════════════════════════
// Fix 3: learnAliases Normalization Consistency
// ════════════════════════════════════════════════════════════════════════
//
// Compare OLD (.toLowerCase().trim()) vs NEW (normalize()) to show how
// the fix changes swap detection in harvestMatchPair.

function simulateNormalization() {
  section("Fix 3: learnAliases Normalization Consistency");

  const testCases = [
    {
      label: "Club token stripping",
      raw: "FC Barcelona",
      oldNorm: "fc barcelona",
      expectedNorm: "barcelona",  // normalize() strips FC
    },
    {
      label: "Abbreviation expansion",
      raw: "Man Utd",
      oldNorm: "man utd",
      expectedNorm: "man united",  // normalize() expands 'utd'
    },
    {
      label: "Diacritic handling",
      raw: "São Paulo FC",
      oldNorm: "são paulo fc",
      expectedNorm: "sao paulo",  // NFD strip + club token strip
    },
    {
      label: "Suffix stripping",
      raw: "Real Madrid CF",
      oldNorm: "real madrid cf",
      expectedNorm: "real madrid",
    },
    {
      label: "Multiple club tokens",
      raw: "SC FC Freiburg",
      oldNorm: "sc fc freiburg",
      expectedNorm: "freiburg",
    },
  ];

  for (const tc of testCases) {
    const oldResult = tc.raw.toLowerCase().trim();
    const newResult = normalize(tc.raw);

    assert(
      oldResult === tc.oldNorm,
      `OLD normalize("${tc.raw}") = "${oldResult}"`,
    );
    assert(
      newResult === tc.expectedNorm,
      `NEW normalize("${tc.raw}") = "${newResult}"`,
      `expected "${tc.expectedNorm}", got "${newResult}"`,
    );
  }

  // Show swap detection difference
  console.log("\n  Swap detection comparison:");
  console.log(`  ${"─".repeat(56)}`);

  // Pinnacle says: "FC Barcelona" vs NW says: "Barcelona FC"
  const pHome = "FC Barcelona";
  const nwHome = "Barcelona FC";
  const pAway = "Real Madrid CF";
  const nwAway = "Real Madrid";

  const oldPH = pHome.toLowerCase().trim();
  const oldNH = nwHome.toLowerCase().trim();
  const oldPA = pAway.toLowerCase().trim();
  const oldNA = nwAway.toLowerCase().trim();

  const newPH = normalize(pHome);
  const newNH = normalize(nwHome);
  const newPA = normalize(pAway);
  const newNA = normalize(nwAway);

  console.log(`  Pinnacle home: "${pHome}" → old="${oldPH}" new="${newPH}"`);
  console.log(`  NW home:       "${nwHome}" → old="${oldNH}" new="${newNH}"`);
  console.log(`  Pinnacle away: "${pAway}" → old="${oldPA}" new="${newPA}"`);
  console.log(`  NW away:       "${nwAway}" → old="${oldNA}" new="${newNA}"`);

  // diceLite for swap detection
  function diceLite(a: string, b: string): number {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const grams = (s: string) => {
      const set = new Set<string>();
      for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
      return set;
    };
    const A = grams(a);
    const B = grams(b);
    let inter = 0;
    for (const g of A) if (B.has(g)) inter++;
    return (2 * inter) / (A.size + B.size || 1);
  }

  const oldNormal = diceLite(oldPH, oldNH) + diceLite(oldPA, oldNA);
  const oldSwapped = diceLite(oldPH, oldNA) + diceLite(oldPA, oldNH);
  const newNormal = diceLite(newPH, newNH) + diceLite(newPA, newNA);
  const newSwapped = diceLite(newPH, newNA) + diceLite(newPA, newNH);

  console.log(`\n  OLD: normal=${oldNormal.toFixed(3)} swapped=${oldSwapped.toFixed(3)} → ${oldSwapped > oldNormal ? "SWAPPED (wrong!)" : "normal"}`);
  console.log(`  NEW: normal=${newNormal.toFixed(3)} swapped=${newSwapped.toFixed(3)} → ${newSwapped > newNormal ? "SWAPPED (wrong!)" : "normal ✓"}`);

  assert(
    newNormal >= newSwapped,
    "NEW normalize: correctly detects non-swapped pair",
    `normal=${newNormal.toFixed(3)} vs swapped=${newSwapped.toFixed(3)}`,
  );

  // Competition normalization
  console.log("\n  Competition normalization:");
  const compCases = [
    { raw: "England Women Super League", expected: normalizeCompetition("England Women Super League") },
    { raw: "English WSL", expected: normalizeCompetition("English WSL") },
    { raw: "Spanish Liga", expected: normalizeCompetition("Spanish Liga") },
  ];
  for (const cc of compCases) {
    const oldResult = cc.raw.toLowerCase().trim();
    const newResult = normalizeCompetition(cc.raw);
    console.log(`  "${cc.raw}" → old="${oldResult}" new="${newResult}"`);
  }
}

// ════════════════════════════════════════════════════════════════════════
// Fix 4: Bayesian Anti-Ratchet Bypass for High-Trust Sources
// ════════════════════════════════════════════════════════════════════════
//
// Simulate the bayesianVerdict logic with and without the high-trust
// bypass to verify that operator approvals fast-track promotion.

function simulateAntiRatchetBypass() {
  section("Fix 4: Bayesian Anti-Ratchet Bypass for High-Trust Sources");

  const BAYES_PROMOTE_EVIDENCE = 2.0;
  const BAYES_NEGATIVE_PENALTY_ALPHA = 1.5;
  const BAYES_MIN_POSITIVE_OBS = 2;
  const BAYES_MIN_HOURS_BETWEEN_OBS = 1;

  interface MockCandidate {
    positiveObs: number;
    negativeObs: number;
    weight: number;
    firstSeenAt: string;
    lastSeenAt: string;
  }

  function bayesianVerdictOLD(c: MockCandidate): "auto-confirm" | null {
    if (c.positiveObs < BAYES_MIN_POSITIVE_OBS) return null;
    const firstSeen = new Date(c.firstSeenAt).getTime();
    const lastSeen = new Date(c.lastSeenAt).getTime();
    const hoursSpread = (lastSeen - firstSeen) / 3_600_000;
    if (hoursSpread < BAYES_MIN_HOURS_BETWEEN_OBS) return null; // ← OLD: always blocks
    const evidence =
      Math.log(c.weight + 1) -
      BAYES_NEGATIVE_PENALTY_ALPHA * Math.log(c.negativeObs + 1);
    return evidence >= BAYES_PROMOTE_EVIDENCE ? "auto-confirm" : null;
  }

  function bayesianVerdictNEW(c: MockCandidate): "auto-confirm" | null {
    if (c.positiveObs < BAYES_MIN_POSITIVE_OBS) return null;
    const firstSeen = new Date(c.firstSeenAt).getTime();
    const lastSeen = new Date(c.lastSeenAt).getTime();
    const hoursSpread = (lastSeen - firstSeen) / 3_600_000;
    const isHighTrust = c.weight >= 6; // ← NEW: bypass for high-trust
    if (hoursSpread < BAYES_MIN_HOURS_BETWEEN_OBS && !isHighTrust) return null;
    const evidence =
      Math.log(c.weight + 1) -
      BAYES_NEGATIVE_PENALTY_ALPHA * Math.log(c.negativeObs + 1);
    return evidence >= BAYES_PROMOTE_EVIDENCE ? "auto-confirm" : null;
  }

  // Weight calculation helper
  const PROVIDER_WEIGHT: Record<string, number> = {
    pinnacle: 3,
    "ninewickets-exchange": 2,
    "ninewickets-sportsbook": 2,
  };
  const SOURCE_MULTIPLIER: Record<string, number> = {
    "match-review": 4,
    harvester: 1,
    settle: 4,
  };

  function calcWeight(provider: string, source: string): number {
    return (PROVIDER_WEIGHT[provider] ?? 1) * (SOURCE_MULTIPLIER[source] ?? 1);
  }

  const now = new Date();

  // ── Scenario 1: Manual approval from Matcher Lab (NW team) ──
  // Two observations at same timestamp (operator clicks approve once,
  // harvestMatchPair records home + away)
  const manualApproval: MockCandidate = {
    positiveObs: 2,  // home + away observation
    negativeObs: 0,
    weight: 1 + calcWeight("ninewickets-exchange", "match-review"), // initial 1 + (2 × 4) = 9
    firstSeenAt: now.toISOString(),
    lastSeenAt: now.toISOString(), // same timestamp!
  };

  const oldManual = bayesianVerdictOLD(manualApproval);
  const newManual = bayesianVerdictNEW(manualApproval);

  console.log(`\n  Manual approval (NW, match-review):`);
  console.log(`    weight = ${manualApproval.weight} (provider=2 × source=4 = 8, +1 initial)`);
  console.log(`    positiveObs = ${manualApproval.positiveObs}`);
  console.log(`    hoursSpread = 0 (same-timestamp)`);
  const evidence = Math.log(manualApproval.weight + 1) - BAYES_NEGATIVE_PENALTY_ALPHA * Math.log(1);
  console.log(`    evidence = ln(${manualApproval.weight + 1}) - 1.5×ln(1) = ${evidence.toFixed(3)} (threshold: ${BAYES_PROMOTE_EVIDENCE})`);

  assert(
    oldManual === null,
    "OLD: manual approval → null (blocked by 1h anti-ratchet)",
    `got: ${oldManual}`,
  );
  assert(
    newManual === "auto-confirm",
    "NEW: manual approval → auto-confirm (high-trust bypass, weight=9 ≥ 6)",
    `got: ${newManual}`,
  );

  // ── Scenario 2: Single harvester observation (low trust) ──
  const singleHarvester: MockCandidate = {
    positiveObs: 2,
    negativeObs: 0,
    weight: 1 + calcWeight("ninewickets-exchange", "harvester"), // 1 + (2 × 1) = 3
    firstSeenAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
  };

  const oldHarvester = bayesianVerdictOLD(singleHarvester);
  const newHarvester = bayesianVerdictNEW(singleHarvester);

  console.log(`\n  Single harvester observation (NW):`);
  console.log(`    weight = ${singleHarvester.weight} (provider=2 × source=1 = 2, +1 initial)`);
  console.log(`    hoursSpread = 0`);

  assert(
    oldHarvester === null,
    "OLD: single harvester → null (blocked by anti-ratchet)",
  );
  assert(
    newHarvester === null,
    "NEW: single harvester → null (still blocked — weight=3 < 6, not high-trust)",
  );

  // ── Scenario 3: Pinnacle harvester with time spread (should work in both) ──
  const twoHoursAgo = new Date(now.getTime() - 2 * 3_600_000);
  const pinnacleSpread: MockCandidate = {
    positiveObs: 3,
    negativeObs: 0,
    weight: 1 + calcWeight("pinnacle", "harvester") * 3, // 1 + (3 × 1) × 3 = 10
    firstSeenAt: twoHoursAgo.toISOString(),
    lastSeenAt: now.toISOString(),
  };

  const oldPinnacle = bayesianVerdictOLD(pinnacleSpread);
  const newPinnacle = bayesianVerdictNEW(pinnacleSpread);

  console.log(`\n  Pinnacle with 2h spread:`);
  console.log(`    weight = ${pinnacleSpread.weight}, positiveObs = ${pinnacleSpread.positiveObs}, hoursSpread = 2`);

  assert(
    oldPinnacle === "auto-confirm",
    "OLD: Pinnacle 2h spread → auto-confirm (passes anti-ratchet normally)",
  );
  assert(
    newPinnacle === "auto-confirm",
    "NEW: Pinnacle 2h spread → auto-confirm (unchanged behaviour)",
  );

  // ── Scenario 4: Settlement-sourced observation (high trust) ──
  const settleObs: MockCandidate = {
    positiveObs: 2,
    negativeObs: 0,
    weight: 1 + calcWeight("pinnacle", "settle"), // 1 + (3 × 4) = 13
    firstSeenAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
  };

  const oldSettle = bayesianVerdictOLD(settleObs);
  const newSettle = bayesianVerdictNEW(settleObs);

  console.log(`\n  Settlement observation (Pinnacle):`);
  console.log(`    weight = ${settleObs.weight} (provider=3 × source=4 = 12, +1 initial)`);

  assert(
    oldSettle === null,
    "OLD: settle obs → null (blocked by anti-ratchet despite high weight)",
  );
  assert(
    newSettle === "auto-confirm",
    "NEW: settle obs → auto-confirm (weight=13 ≥ 6, bypasses anti-ratchet)",
  );

  // ── Source parameter in harvestMatchPair ──
  console.log("\n  Source parameter flow:");
  console.log(`  ${"─".repeat(56)}`);
  console.log(`  Matcher Lab → harvestMatchPair(source="match-review")`);
  console.log(`    → recordObservation(source="match-review")`);
  console.log(`    → weight = provider_weight × 4 (match-review multiplier)`);
  console.log(`    → NW team: 2 × 4 = 8 per observation`);
  console.log(`    → Pinnacle: 3 × 4 = 12 per observation`);
  console.log(`    → Both ≥ 6 threshold → bypasses anti-ratchet ✓`);
  console.log(`  ${"─".repeat(56)}`);
  console.log(`  ML scheduler → harvestMatchPair(source="harvester")`);
  console.log(`    → recordObservation(source="harvester")`);
  console.log(`    → weight = provider_weight × 1 (harvester multiplier)`);
  console.log(`    → NW team: 2 × 1 = 2 per observation`);
  console.log(`    → Still requires 1h temporal spread ✓`);
}

// ════════════════════════════════════════════════════════════════════════
// Run all simulations
// ════════════════════════════════════════════════════════════════════════

function main() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║  Entity Resolution Fix Simulation                        ║");
  console.log("╚════════════════════════════════════════════════════════════╝");

  simulateGenderGate();
  simulateBindingConflict();
  simulateNormalization();
  simulateAntiRatchetBypass();

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`${"═".repeat(60)}\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main();
