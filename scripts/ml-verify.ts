#!/usr/bin/env npx tsx
import "dotenv/config";

/**
 * ML Pipeline Operations Verification Script
 *
 * Repeatable post-change checks that catch drift quickly:
 *   1. Feature length distribution (DB)
 *   2. Feature version distribution (DB)
 *   3. TS/Python feature contract match (static)
 *   4. Enrichment cache coverage (DB)
 *   5. Trainable sample count (DB)
 *   6. Score bucket performance (DB)
 *   7. Latest model metadata (DB)
 *
 * Usage:
 *   npx tsx scripts/ml-verify.ts            # Run all checks
 *   npx tsx scripts/ml-verify.ts contract    # Contract-only (no DB)
 *   npx tsx scripts/ml-verify.ts db          # DB checks only
 *
 * Exit code 0 = all green, 1 = one or more warnings, 2 = critical failure.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

// ── Static contract check (no DB required) ────────────────────────

import {
  FEATURE_NAMES,
  FEATURE_COUNT,
  FEATURE_NAMES_HASH,
  FEATURE_VERSION,
} from "../lib/ml/feature-contract";
import { FEATURE_CATALOG } from "../lib/ml/feature-catalog";
import {
  ML_COLD_START_THRESHOLD,
  ML_FEATURE_COUNT,
  ML_FEATURE_VERSION,
} from "../lib/shared/constants";

type Severity = "pass" | "warn" | "fail";

interface CheckResult {
  name: string;
  severity: Severity;
  message: string;
  detail?: string;
}

const results: CheckResult[] = [];

function push(
  name: string,
  severity: Severity,
  message: string,
  detail?: string,
): void {
  results.push({ name, severity, message, detail });
  const icon = severity === "pass" ? "✅" : severity === "warn" ? "⚠️" : "❌";
  console.log(`${icon}  ${name}: ${message}`);
  if (detail) {
    for (const line of detail.split("\n")) {
      console.log(`    ${line}`);
    }
  }
}

// ── Parse Python feature_names.py ─────────────────────────────────

function parsePythonFeatureNames(): {
  names: string[];
  count: number;
  version: number;
  hash: string;
} {
  const source = readFileSync(
    resolve(process.cwd(), "services/optimizer/app/feature_names.py"),
    "utf8",
  );
  const listMatch = source.match(
    /FEATURE_NAMES:\s*list\[str\]\s*=\s*\[([\s\S]*?)\]\s*\n\nFEATURE_COUNT/,
  );
  if (!listMatch)
    throw new Error("Could not parse FEATURE_NAMES from feature_names.py");
  const names = Array.from(listMatch[1].matchAll(/"([^"]+)"/g), (m) => m[1]);

  const countMatch = source.match(/FEATURE_COUNT\s*=\s*(\d+)/);
  const versionMatch = source.match(/FEATURE_VERSION\s*=\s*(\d+)/);
  const count = countMatch ? parseInt(countMatch[1], 10) : 0;
  const version = versionMatch ? parseInt(versionMatch[1], 10) : 0;

  const hash = createHash("sha256").update(names.join(",")).digest("hex");
  return { names, count, version, hash };
}

// ── Contract checks ───────────────────────────────────────────────

function runContractChecks(): void {
  console.log("\n═══ Feature Contract Checks ═══\n");

  // 1. TS feature count
  if (FEATURE_COUNT === 22) {
    push("TS FEATURE_COUNT", "pass", `${FEATURE_COUNT} (expected 22)`);
  } else {
    push("TS FEATURE_COUNT", "fail", `${FEATURE_COUNT} (expected 22)`);
  }

  // 2. TS feature names length
  if (FEATURE_NAMES.length === FEATURE_COUNT) {
    push(
      "TS FEATURE_NAMES length",
      "pass",
      `${FEATURE_NAMES.length} matches FEATURE_COUNT`,
    );
  } else {
    push(
      "TS FEATURE_NAMES length",
      "fail",
      `${FEATURE_NAMES.length} !== ${FEATURE_COUNT}`,
    );
  }

  // 3. TS shared constants match
  if (
    ML_FEATURE_COUNT === FEATURE_COUNT &&
    ML_FEATURE_VERSION === FEATURE_VERSION
  ) {
    push(
      "Shared constants",
      "pass",
      `ML_FEATURE_COUNT=${ML_FEATURE_COUNT}, ML_FEATURE_VERSION=${ML_FEATURE_VERSION}`,
    );
  } else {
    push(
      "Shared constants",
      "fail",
      `ML_FEATURE_COUNT=${ML_FEATURE_COUNT} vs ${FEATURE_COUNT}, ML_FEATURE_VERSION=${ML_FEATURE_VERSION} vs ${FEATURE_VERSION}`,
    );
  }

  // 4. Python ↔ TS alignment
  try {
    const py = parsePythonFeatureNames();

    if (py.count === FEATURE_COUNT) {
      push("Python FEATURE_COUNT", "pass", `${py.count}`);
    } else {
      push(
        "Python FEATURE_COUNT",
        "fail",
        `${py.count} !== TS ${FEATURE_COUNT}`,
      );
    }

    if (py.version === FEATURE_VERSION) {
      push("Python FEATURE_VERSION", "pass", `${py.version}`);
    } else {
      push(
        "Python FEATURE_VERSION",
        "fail",
        `${py.version} !== TS ${FEATURE_VERSION}`,
      );
    }

    const namesMatch =
      JSON.stringify(py.names) === JSON.stringify(FEATURE_NAMES);
    if (namesMatch) {
      push("Python ↔ TS names", "pass", "All 22 feature names match exactly");
    } else {
      // Find mismatches
      const diffs: string[] = [];
      for (
        let i = 0;
        i < Math.max(py.names.length, FEATURE_NAMES.length);
        i++
      ) {
        if (py.names[i] !== FEATURE_NAMES[i]) {
          diffs.push(
            `  [${i}] Python="${py.names[i] ?? "MISSING"}" TS="${FEATURE_NAMES[i] ?? "MISSING"}"`,
          );
        }
      }
      push(
        "Python ↔ TS names",
        "fail",
        `${diffs.length} mismatches`,
        diffs.join("\n"),
      );
    }

    if (py.hash === FEATURE_NAMES_HASH) {
      push(
        "Feature names hash",
        "pass",
        `SHA-256 match: ${py.hash.slice(0, 16)}…`,
      );
    } else {
      push(
        "Feature names hash",
        "fail",
        `Python=${py.hash.slice(0, 16)}… TS=${FEATURE_NAMES_HASH.slice(0, 16)}…`,
      );
    }
  } catch (err) {
    push(
      "Python contract",
      "fail",
      `Could not parse: ${(err as Error).message}`,
    );
  }

  // 5. UI catalog match
  const catalogNames = FEATURE_CATALOG.map((f) => f.name);
  const catalogMatch =
    JSON.stringify(catalogNames) === JSON.stringify(FEATURE_NAMES);
  if (catalogMatch) {
    push(
      "UI FEATURE_CATALOG",
      "pass",
      `All ${FEATURE_CATALOG.length} entries match TS FEATURE_NAMES`,
    );
  } else {
    push(
      "UI FEATURE_CATALOG",
      "fail",
      `Catalog names do not match FEATURE_NAMES`,
    );
  }
}

// ── DB checks ────────────────────────────────────────────────────

async function runDbChecks(): Promise<void> {
  console.log("\n═══ Database Checks ═══\n");

  // Dynamic import to avoid crash when DATABASE_URL is not set
  const { db, ensureDbReady } = await import("../lib/db/client");
  await ensureDbReady();
  const { bets, competitionEnrichments, mlModels, mlTrainingExamples } =
    await import("../lib/db/schema");
  const { sql, isNotNull, desc, eq } = await import("drizzle-orm");

  // 1. Feature length distribution
  console.log("── Feature Length Distribution ──");
  const featureLengths = await db
    .select({
      len: sql<number>`array_length(${bets.mlFeatures}, 1)`,
      cnt: sql<number>`count(*)::int`,
    })
    .from(bets)
    .where(isNotNull(bets.mlFeatures))
    .groupBy(sql`array_length(${bets.mlFeatures}, 1)`)
    .orderBy(sql`array_length(${bets.mlFeatures}, 1)`);

  if (featureLengths.length === 0) {
    push("Feature lengths", "warn", "No bets with features yet");
  } else {
    const detail = featureLengths
      .map((r) => `  length=${r.len}: ${r.cnt} rows`)
      .join("\n");
    const allCorrect =
      featureLengths.length === 1 && featureLengths[0].len === ML_FEATURE_COUNT;
    push(
      "Feature lengths",
      allCorrect ? "pass" : "warn",
      allCorrect
        ? `All ${featureLengths[0].cnt} rows have ${ML_FEATURE_COUNT} features`
        : `${featureLengths.length} distinct lengths detected`,
      detail,
    );
  }

  // 2. Feature version distribution
  console.log("── Feature Version Distribution ──");
  const featureVersions = await db
    .select({
      version: bets.mlFeatureVersion,
      cnt: sql<number>`count(*)::int`,
    })
    .from(bets)
    .where(isNotNull(bets.mlFeatures))
    .groupBy(bets.mlFeatureVersion);

  if (featureVersions.length === 0) {
    push("Feature versions", "warn", "No bets with features yet");
  } else {
    const detail = featureVersions
      .map((r) => `  v${r.version ?? "NULL"}: ${r.cnt} rows`)
      .join("\n");
    const allCurrent =
      featureVersions.length === 1 &&
      featureVersions[0].version === ML_FEATURE_VERSION;
    push(
      "Feature versions",
      allCurrent ? "pass" : "warn",
      allCurrent
        ? `All rows at v${ML_FEATURE_VERSION}`
        : `${featureVersions.length} distinct versions`,
      detail,
    );
  }

  // 3. Enrichment coverage
  console.log("── Enrichment Coverage ──");
  const enrichmentCoverage = await db.execute(sql`
    WITH bet_competitions AS (
      SELECT DISTINCT
        lower(regexp_replace(btrim(competition), '\\s+', ' ', 'g')) AS name
      FROM bets
      WHERE competition IS NOT NULL AND btrim(competition) <> ''
    )
    SELECT
      count(*)::int AS distinct_comps,
      count(${competitionEnrichments.name})::int AS enriched_count,
      count(*) FILTER (WHERE ${competitionEnrichments.confidence} >= 70)::int AS high_confidence,
      (SELECT count(*)::int FROM ${competitionEnrichments}) AS cache_rows
    FROM bet_competitions
    LEFT JOIN ${competitionEnrichments}
      ON ${competitionEnrichments.name} = bet_competitions.name
  `);
  const enrichmentRow = (enrichmentCoverage.rows[0] ?? {}) as {
    distinct_comps?: number | string;
    enriched_count?: number | string;
    high_confidence?: number | string;
    cache_rows?: number | string;
  };
  const distinctComps = Number(enrichmentRow.distinct_comps ?? 0);
  const enrichedCount = Number(enrichmentRow.enriched_count ?? 0);
  const highConfidence = Number(enrichmentRow.high_confidence ?? 0);
  const cacheRows = Number(enrichmentRow.cache_rows ?? 0);

  const coveragePct =
    distinctComps > 0 ? Math.round((enrichedCount / distinctComps) * 100) : 0;
  push(
    "Enrichment coverage",
    coveragePct >= 80 ? "pass" : coveragePct >= 50 ? "warn" : "warn",
    `${enrichedCount}/${distinctComps} bet competitions enriched (${coveragePct}%), ${highConfidence} high-confidence, ${cacheRows} total cache rows`,
  );

  // 4. Trainable sample count
  console.log("── Training Samples ──");
  const exampleCounts = await db
    .select({
      exampleType: mlTrainingExamples.exampleType,
      cnt: sql<number>`count(*)::int`,
    })
    .from(mlTrainingExamples)
    .groupBy(mlTrainingExamples.exampleType);

  const totalExamples = exampleCounts.reduce((s, r) => s + r.cnt, 0);
  const settledDetected =
    exampleCounts.find((r) => r.exampleType === "settled_detected")?.cnt ?? 0;
  const shadowScored =
    exampleCounts.find((r) => r.exampleType === "shadow_scored")?.cnt ?? 0;

  const detail = exampleCounts
    .map((r) => `  ${r.exampleType}: ${r.cnt}`)
    .join("\n");
  push(
    "Training samples",
    totalExamples >= 1000 ? "pass" : totalExamples >= 100 ? "warn" : "warn",
    `${totalExamples} total (settled=${settledDetected}, shadow=${shadowScored})`,
    detail,
  );

  // Also check settled bets with features (the legacy count)
  const [{ settledWithFeatures }] = await db
    .select({ settledWithFeatures: sql<number>`count(*)::int` })
    .from(bets)
    .where(
      sql`${bets.outcome} NOT IN ('pending', 'void') AND ${bets.mlFeatures} IS NOT NULL`,
    );

  push(
    "Settled bets with features",
    settledWithFeatures >= 1000
      ? "pass"
      : settledWithFeatures >= 100
        ? "warn"
        : "warn",
    `${settledWithFeatures} (cold start threshold: ${ML_COLD_START_THRESHOLD})`,
  );

  // 5. Score bucket performance
  console.log("── Score Bucket Performance ──");
  const buckets = await db
    .select({
      bucket: sql<string>`
        CASE
          WHEN ${bets.mlScore} < 0.4 THEN '<0.4'
          WHEN ${bets.mlScore} < 0.5 THEN '0.4–0.5'
          WHEN ${bets.mlScore} < 0.6 THEN '0.5–0.6'
          WHEN ${bets.mlScore} < 0.7 THEN '0.6–0.7'
          WHEN ${bets.mlScore} < 0.8 THEN '0.7–0.8'
          ELSE '≥0.8'
        END`,
      cnt: sql<number>`count(*)::int`,
      avgPnl: sql<number>`coalesce(avg(${bets.pnl}::float), 0)::float`,
      avgClv: sql<number>`coalesce(avg(${bets.clvPct}::float), 0)::float`,
      winRate: sql<number>`coalesce(avg(CASE WHEN ${bets.outcome} IN ('won', 'half_won') THEN 1.0 ELSE 0.0 END), 0)::float`,
    })
    .from(bets)
    .where(
      sql`${bets.mlScore} IS NOT NULL AND ${bets.outcome} NOT IN ('pending', 'void')`,
    ).groupBy(sql`
      CASE
        WHEN ${bets.mlScore} < 0.4 THEN '<0.4'
        WHEN ${bets.mlScore} < 0.5 THEN '0.4–0.5'
        WHEN ${bets.mlScore} < 0.6 THEN '0.5–0.6'
        WHEN ${bets.mlScore} < 0.7 THEN '0.6–0.7'
        WHEN ${bets.mlScore} < 0.8 THEN '0.7–0.8'
        ELSE '≥0.8'
      END`);

  if (buckets.length === 0) {
    push(
      "Score buckets",
      "warn",
      "No scored+settled bets yet — cannot measure bucket performance",
    );
  } else {
    const table = buckets
      .map(
        (b) =>
          `  ${b.bucket.padEnd(8)} n=${String(b.cnt).padStart(5)} avgPnl=${b.avgPnl.toFixed(2).padStart(8)} avgClv=${b.avgClv.toFixed(2).padStart(7)} win%=${(b.winRate * 100).toFixed(1).padStart(5)}`,
      )
      .join("\n");
    push("Score buckets", "pass", `${buckets.length} buckets with data`, table);
  }

  // 6. Latest model metadata
  console.log("── Model Metadata ──");
  const [latestModel] = await db
    .select()
    .from(mlModels)
    .orderBy(desc(mlModels.createdAt))
    .limit(1);

  if (!latestModel) {
    push("Latest model", "warn", "No models in ml_models table");
  } else {
    const detail = [
      `  version: ${latestModel.version}`,
      `  status: ${latestModel.status}`,
      `  permission: ${latestModel.permissionLevel}`,
      `  training_samples: ${latestModel.trainingSamples}`,
      `  feature_version: ${latestModel.featureVersion}`,
      `  feature_count: ${latestModel.featureCount}`,
      `  oos_auc: ${latestModel.oosAucRoc ?? "N/A"}`,
      `  deflated_sharpe: ${latestModel.deflatedSharpe ?? "N/A"}`,
      `  pbo: ${latestModel.pbo ?? "N/A"}`,
      `  created_at: ${latestModel.createdAt}`,
    ].join("\n");

    const status = String(latestModel.status);
    const expectedTerminalStatus =
      status === "deployed" || status === "rejected" || status === "retired";
    push(
      "Latest model",
      expectedTerminalStatus ? "pass" : "warn",
      status === "rejected"
        ? `v${latestModel.version} rejected by deployment gate`
        : `v${latestModel.version} (${status})`,
      detail,
    );
  }

  // Check deployed model separately
  const [deployed] = await db
    .select()
    .from(mlModels)
    .where(eq(mlModels.status, "deployed"))
    .orderBy(desc(mlModels.deployedAt))
    .limit(1);

  if (deployed) {
    push(
      "Deployed model",
      "pass",
      `v${deployed.version} — permission=${deployed.permissionLevel}`,
    );
  } else {
    push(
      "Deployed model",
      "warn",
      "No deployed model — ML is in pass-through mode",
    );
  }

  // 7. Outcome distribution sanity check
  console.log("── Outcome Distribution ──");
  const outcomes = await db
    .select({
      outcome: bets.outcome,
      total: sql<number>`count(*)::int`,
      withFeatures: sql<number>`count(*) FILTER (WHERE ${bets.mlFeatures} IS NOT NULL)::int`,
    })
    .from(bets)
    .groupBy(bets.outcome)
    .orderBy(sql`count(*) DESC`);

  const outcomeDetail = outcomes
    .map(
      (r) =>
        `  ${r.outcome.padEnd(12)} total=${String(r.total).padStart(5)} withFeatures=${String(r.withFeatures).padStart(5)}`,
    )
    .join("\n");
  push(
    "Outcome distribution",
    "pass",
    `${outcomes.length} distinct outcomes`,
    outcomeDetail,
  );
}

// ── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mode = process.argv[2]; // 'contract' | 'db' | undefined (all)

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  ML Pipeline Verification                   ║");
  console.log("╚══════════════════════════════════════════════╝");

  if (!mode || mode === "contract") {
    runContractChecks();
  }

  if (!mode || mode === "db") {
    try {
      await runDbChecks();
    } catch (err) {
      push(
        "DB connection",
        "fail",
        `Cannot connect: ${(err as Error).message}`,
      );
    }
  }

  // ── Summary ──────────────────────────────────────────────────────
  console.log("\n═══ Summary ═══\n");
  const passes = results.filter((r) => r.severity === "pass").length;
  const warns = results.filter((r) => r.severity === "warn").length;
  const fails = results.filter((r) => r.severity === "fail").length;

  console.log(`  ✅ Pass: ${passes}`);
  console.log(`  ⚠️  Warn: ${warns}`);
  console.log(`  ❌ Fail: ${fails}`);

  if (fails > 0) {
    console.log(
      "\n❌ CRITICAL: Feature contract violations detected. Fix before deploying.",
    );
    process.exit(2);
  } else if (warns > 0) {
    console.log("\n⚠️  Some warnings — review before production.");
    process.exit(1);
  } else {
    console.log("\n✅ All checks passed!");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});
