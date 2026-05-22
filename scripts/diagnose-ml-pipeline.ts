/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * End-to-end ML pipeline diagnostic.
 * Validates every stage: data → features → training → scoring → shadow.
 *
 * Run: npx dotenvx run -- npx tsx scripts/diagnose-ml-pipeline.ts
 */
import { ensureDbReady, db } from "../lib/db/client";
import { sql } from "drizzle-orm";
import { FEATURE_COUNT, FEATURE_SQL_INDEX } from "../lib/ml/feature-contract";
import { computeRawStakeMultiplier } from "../lib/ml/staker";
import { ML_FEATURE_VERSION } from "../lib/shared/constants";

const PASS = "✅";
const FAIL = "❌";
const WARN = "⚠️";

let totalChecks = 0;
let passed = 0;
let failed = 0;
let warnings = 0;

function check(name: string, ok: boolean, detail: string) {
  totalChecks++;
  if (ok) {
    passed++;
    console.log(`  ${PASS} ${name}: ${detail}`);
  } else {
    failed++;
    console.log(`  ${FAIL} ${name}: ${detail}`);
  }
}
function warn(name: string, detail: string) {
  totalChecks++;
  warnings++;
  console.log(`  ${WARN} ${name}: ${detail}`);
}

async function main() {
  await ensureDbReady();

  // ═══════════════════════════════════════════════════════════════
  // 1. TRAINING DATA INTEGRITY
  // ═══════════════════════════════════════════════════════════════
  console.log("\n══ 1. TRAINING DATA INTEGRITY ══");

  // 1a. No duplicate semantic training rows. Different example types for the
  // same bet are allowed; the Python loader canonicalizes those to one row.
  const dupes = await db.execute(sql`
    SELECT count(*) as cnt FROM (
      SELECT source_bet_id, example_type FROM ml_training_examples
      WHERE label IS NOT NULL AND features IS NOT NULL
      GROUP BY source_bet_id, example_type HAVING count(*) > 1
    ) sub
  `);
  const nDupes = Number(dupes.rows[0]?.cnt ?? 0);
  check(
    "No duplicate source/type examples",
    nDupes === 0,
    nDupes === 0
      ? "All examples are unique per source/type"
      : `${nDupes} source/type groups have duplicate examples`,
  );

  // 1b. All features have the current contract length
  const badLen = await db.execute(sql`
    SELECT count(*) as cnt FROM ml_training_examples
    WHERE features IS NOT NULL AND array_length(features, 1) != ${FEATURE_COUNT}
  `);
  const nBadLen = Number(badLen.rows[0]?.cnt ?? 0);
  check(
    "All feature vectors match the current contract",
    nBadLen === 0,
    nBadLen === 0
      ? "All correct"
      : `${nBadLen} examples have wrong feature length`,
  );

  // 1c. No NaN/Inf in features
  const nanFeats = await db.execute(sql`
    SELECT count(*) as cnt FROM ml_training_examples
    WHERE features IS NOT NULL AND label IS NOT NULL
      AND (
        'NaN' = ANY(SELECT unnest(features)::text)
        OR 'Infinity' = ANY(SELECT unnest(features)::text)
        OR '-Infinity' = ANY(SELECT unnest(features)::text)
      )
  `);
  const nNan = Number(nanFeats.rows[0]?.cnt ?? 0);
  check(
    "No NaN/Inf in features",
    nNan === 0,
    nNan === 0 ? "All finite" : `${nNan} examples have NaN/Inf features`,
  );

  // 1d. Feature version consistency
  const fvCheck = await db.execute(sql`
    SELECT feature_version, count(*) as cnt
    FROM ml_training_examples WHERE label IS NOT NULL AND features IS NOT NULL
    GROUP BY feature_version
  `);
  const versions = fvCheck.rows
    .map((r: any) => `v${r.feature_version}(${r.cnt})`)
    .join(", ");
  check(
    "Single feature version",
    fvCheck.rows.length === 1,
    fvCheck.rows.length === 1
      ? `All at ${versions}`
      : `Mixed versions: ${versions}`,
  );

  // 1e. Class balance sanity
  const classBal = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE label = 'positive') as pos,
      count(*) FILTER (WHERE label = 'negative') as neg,
      count(*) as total
    FROM ml_training_examples
    WHERE label IS NOT NULL AND features IS NOT NULL
  `);
  const pos = Number(classBal.rows[0]?.pos ?? 0);
  const neg = Number(classBal.rows[0]?.neg ?? 0);
  const total = Number(classBal.rows[0]?.total ?? 0);
  const posRate = total > 0 ? ((pos / total) * 100).toFixed(1) : "0";
  const balOk = total > 0 && pos / total > 0.25 && pos / total < 0.75;
  check(
    "Class balance reasonable",
    balOk,
    `${pos} pos / ${neg} neg (${posRate}% positive rate)`,
  );

  // 1f. Labels match bets outcomes
  const labelMismatch = await db.execute(sql`
    SELECT count(*) as cnt
    FROM ml_training_examples m
    JOIN bets b ON m.source_bet_id = b.id
    WHERE m.label IS NOT NULL AND b.outcome NOT IN ('pending', 'void')
      AND (
        (m.label = 'positive' AND b.outcome NOT IN ('won', 'half_won'))
        OR (m.label = 'negative' AND b.outcome NOT IN ('lost', 'half_lost'))
      )
  `);
  const nMismatch = Number(labelMismatch.rows[0]?.cnt ?? 0);
  check(
    "Labels match bet outcomes",
    nMismatch === 0,
    nMismatch === 0
      ? "All labels consistent"
      : `${nMismatch} label/outcome mismatches!`,
  );

  // ═══════════════════════════════════════════════════════════════
  // 2. FEATURE CONSISTENCY (runtime vs training)
  // ═══════════════════════════════════════════════════════════════
  console.log("\n══ 2. FEATURE CONSISTENCY ══");

  // 2a. Features in training examples match features stored on bets
  const featDrift = await db.execute(sql`
    SELECT
      count(*) as total,
      count(*) FILTER (WHERE m.features = b.ml_features) as exact_match,
      count(*) FILTER (WHERE m.features != b.ml_features) as differ,
      count(*) FILTER (WHERE b.ml_features IS NULL) as bet_missing
    FROM ml_training_examples m
    JOIN bets b ON m.source_bet_id = b.id
    WHERE m.features IS NOT NULL AND m.label IS NOT NULL
      AND m.example_type = 'settled_detected'
  `);
  const r = featDrift.rows[0] as any;
  const matchRate =
    r.total > 0
      ? ((Number(r.exact_match) / Number(r.total)) * 100).toFixed(1)
      : "N/A";
  check(
    "Training features match bets table",
    Number(r.differ) === 0,
    `${r.exact_match}/${r.total} exact match (${matchRate}%), ${r.differ} differ, ${r.bet_missing} missing on bet`,
  );

  // 2b. Feature ranges sanity (sharp_true_prob, soft_odds, adjusted_soft_odds, competition_tier)
  const ranges = await db.execute(sql`
    SELECT
      round(min(features[${FEATURE_SQL_INDEX.sharp_true_prob}])::numeric, 3) as min_sharp_prob,
      round(max(features[${FEATURE_SQL_INDEX.sharp_true_prob}])::numeric, 3) as max_sharp_prob,
      round(min(features[${FEATURE_SQL_INDEX.soft_odds}])::numeric, 3) as min_soft_odds,
      round(max(features[${FEATURE_SQL_INDEX.soft_odds}])::numeric, 3) as max_soft_odds,
      round(min(features[${FEATURE_SQL_INDEX.adjusted_soft_odds}])::numeric, 3) as min_adjusted_soft_odds,
      round(max(features[${FEATURE_SQL_INDEX.adjusted_soft_odds}])::numeric, 3) as max_adjusted_soft_odds,
      round(min(features[${FEATURE_SQL_INDEX.competition_tier}])::numeric, 3) as min_competition_tier,
      round(max(features[${FEATURE_SQL_INDEX.competition_tier}])::numeric, 3) as max_competition_tier
    FROM ml_training_examples
    WHERE features IS NOT NULL AND label IS NOT NULL
  `);
  const rng = ranges.rows[0] as any;
  const probOk =
    Number(rng.min_sharp_prob) >= 0 && Number(rng.max_sharp_prob) <= 1;
  check(
    "sharp_true_prob in [0,1]",
    probOk,
    `[${rng.min_sharp_prob}, ${rng.max_sharp_prob}]`,
  );
  const oddsOk = Number(rng.min_soft_odds) >= 1;
  check(
    "soft_odds >= 1.0",
    oddsOk,
    `[${rng.min_soft_odds}, ${rng.max_soft_odds}]`,
  );
  const adjustedOddsOk = Number(rng.min_adjusted_soft_odds) >= 1;
  check(
    "adjusted_soft_odds >= 1.0",
    adjustedOddsOk,
    `[${rng.min_adjusted_soft_odds}, ${rng.max_adjusted_soft_odds}]`,
  );
  const tierOk =
    Number(rng.min_competition_tier) >= 1 &&
    Number(rng.max_competition_tier) <= 3;
  check(
    "competition_tier in [1,3]",
    tierOk,
    `[${rng.min_competition_tier}, ${rng.max_competition_tier}]`,
  );

  // 2c. Feature hash consistency on recent bets
  const hashCheck = await db.execute(sql`
    SELECT ml_feature_names_hash, count(*) as cnt
    FROM bets WHERE ml_feature_names_hash IS NOT NULL
      AND first_seen_at > NOW() - INTERVAL '24 hours'
    GROUP BY ml_feature_names_hash
  `);
  check(
    "Single feature hash (24h)",
    hashCheck.rows.length <= 1,
    hashCheck.rows.length === 0
      ? "No recent scored bets"
      : hashCheck.rows.length === 1
        ? `All same hash (${(hashCheck.rows[0] as any).cnt} bets)`
        : `Multiple hashes — contract drift!`,
  );

  // ═══════════════════════════════════════════════════════════════
  // 3. MODEL QUALITY & DEPLOYMENT
  // ═══════════════════════════════════════════════════════════════
  console.log("\n══ 3. MODEL QUALITY & DEPLOYMENT ══");

  const deployed = await db.execute(sql`
    SELECT version, oos_auc_roc, oos_log_loss, calibration_error,
           oos_roi_mean, deflated_sharpe, training_samples,
           permission_level, training_report, deployed_at
    FROM ml_models WHERE status = 'deployed'
    ORDER BY deployed_at DESC LIMIT 1
  `);
  if (deployed.rows.length === 0) {
    check("Deployed model exists", false, "No deployed model found!");
  } else {
    const m = deployed.rows[0] as any;
    console.log(`  Model v${m.version} deployed at ${m.deployed_at}`);

    const auc = Number(m.oos_auc_roc);
    check("AUC-ROC > 0.55 (baseline)", auc > 0.55, `AUC=${auc.toFixed(4)}`);
    if (auc < 0.6)
      warn(
        "AUC-ROC < 0.60 (weak)",
        `AUC=${auc.toFixed(4)} — model has limited discrimination`,
      );

    const ll = Number(m.oos_log_loss);
    check("LogLoss < 0.75", ll < 0.75, `LL=${ll.toFixed(4)}`);

    const ce = Number(m.calibration_error);
    check("CalibrationError < 0.15", ce < 0.15, `CalErr=${ce.toFixed(4)}`);

    const dsr = Number(m.deflated_sharpe);
    check("DSR >= 0.6", dsr >= 0.6, `DSR=${dsr.toFixed(4)}`);

    // Score bucket analysis
    const tr = m.training_report as Record<string, any> | null;
    if (tr?.score_bucket_report) {
      const br = tr.score_bucket_report;
      const roiMono = Number(br.roi_monotonicity ?? 0);
      const clvMono = Number(br.clv_monotonicity ?? 0);
      const buckets = br.buckets as any[];
      const finiteClvBuckets = buckets.filter((b) =>
        Number.isFinite(Number(b.mean_clv_pct)),
      ).length;
      const profitMono =
        finiteClvBuckets >= 2 ? (roiMono + clvMono) / 2 : roiMono;
      check(
        "Score bucket profit monotonicity >= 0.6",
        profitMono >= 0.6,
        `Profit=${profitMono.toFixed(2)} (ROI=${roiMono}, CLV=${clvMono}; win-rate is diagnostic only)`,
      );

      // Check for the ROI inversion bug we fixed
      if (buckets.length >= 2) {
        const firstROI = buckets[0]?.roi_pct ?? 0;
        const lastROI = buckets[buckets.length - 1]?.roi_pct ?? 0;
        const firstWR = buckets[0]?.win_rate ?? 0;
        const lastWR = buckets[buckets.length - 1]?.win_rate ?? 0;
        const firstClv = Number(buckets[0]?.mean_clv_pct ?? NaN);
        const lastClv = Number(
          buckets[buckets.length - 1]?.mean_clv_pct ?? NaN,
        );
        check(
          "Highest edge bucket has better profit signal than lowest",
          lastROI > firstROI ||
            (Number.isFinite(firstClv) &&
              Number.isFinite(lastClv) &&
              lastClv > firstClv),
          `Q1 ROI=${firstROI.toFixed(1)}%, CLV=${Number.isFinite(firstClv) ? firstClv.toFixed(1) : "n/a"} → Q${buckets.length} ROI=${lastROI.toFixed(1)}%, CLV=${Number.isFinite(lastClv) ? lastClv.toFixed(1) : "n/a"}; WR ${((firstWR ?? 0) * 100).toFixed(1)}%→${((lastWR ?? 0) * 100).toFixed(1)}%`,
        );

        if (firstROI > lastROI + 5) {
          warn(
            "ROI inversion persists",
            `Q1 ROI=${firstROI.toFixed(1)}% > Q${buckets.length} ROI=${lastROI.toFixed(1)}% — lowest scores still most profitable`,
          );
        } else {
          check(
            "No severe ROI inversion",
            true,
            `Q1 ROI=${firstROI.toFixed(1)}% vs Q${buckets.length} ROI=${lastROI.toFixed(1)}%`,
          );
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 4. LIVE SCORING HEALTH
  // ═══════════════════════════════════════════════════════════════
  console.log("\n══ 4. LIVE SCORING HEALTH ══");

  // 4a. Are new bets getting scored?
  const scoringRate = await db.execute(sql`
    SELECT
      count(*) as total,
      count(ml_score) as scored,
      count(ml_features) as has_features
    FROM bets
    WHERE first_seen_at > NOW() - INTERVAL '6 hours'
  `);
  const sr = scoringRate.rows[0] as any;
  const scorePct =
    Number(sr.total) > 0
      ? ((Number(sr.scored) / Number(sr.total)) * 100).toFixed(1)
      : "N/A";
  check(
    "Recent bets are being scored",
    Number(sr.scored) > 0 || Number(sr.total) === 0,
    `${sr.scored}/${sr.total} scored (${scorePct}%) in last 6h`,
  );

  // 4b. Score distribution health (not all same value)
  const scoreDist = await db.execute(sql`
    SELECT
      round(avg(ml_score)::numeric, 4) as avg_score,
      round(stddev(ml_score)::numeric, 4) as std_score,
      round(min(ml_score)::numeric, 4) as min_score,
      round(max(ml_score)::numeric, 4) as max_score,
      count(DISTINCT round(ml_score::numeric, 2)) as unique_bins
    FROM bets
    WHERE ml_score IS NOT NULL AND first_seen_at > NOW() - INTERVAL '6 hours'
  `);
  const sd = scoreDist.rows[0] as any;
  if (sd.avg_score != null) {
    const std = Number(sd.std_score ?? 0);
    check(
      "Score distribution has variance",
      std > 0.05,
      `avg=${sd.avg_score} std=${sd.std_score} range=[${sd.min_score}, ${sd.max_score}] bins=${sd.unique_bins}`,
    );
  } else {
    warn("No scored bets in 6h", "Cannot check score distribution");
  }

  // 4c. Score separation (wins vs losses) on settled bets
  const separation = await db.execute(sql`
    SELECT
      round(avg(ml_score) FILTER (WHERE outcome IN ('won', 'half_won'))::numeric, 4) as avg_win,
      round(avg(ml_score) FILTER (WHERE outcome IN ('lost', 'half_lost'))::numeric, 4) as avg_lose,
      count(*) FILTER (WHERE outcome IN ('won', 'half_won')) as n_win,
      count(*) FILTER (WHERE outcome IN ('lost', 'half_lost')) as n_lose
    FROM bets
    WHERE ml_score IS NOT NULL AND outcome NOT IN ('pending', 'void')
      AND first_seen_at > NOW() - INTERVAL '7 days'
  `);
  const sep = separation.rows[0] as any;
  if (sep.avg_win != null && sep.avg_lose != null) {
    const gap = Number(sep.avg_win) - Number(sep.avg_lose);
    check(
      "Winners score higher than losers",
      gap > 0,
      `WinAvg=${sep.avg_win} LoseAvg=${sep.avg_lose} gap=${gap.toFixed(4)} (N: ${sep.n_win}W/${sep.n_lose}L)`,
    );
    if (gap < 0.03)
      warn(
        "Score separation very weak",
        `gap=${gap.toFixed(4)} — model barely distinguishes W/L`,
      );
  }

  // ═══════════════════════════════════════════════════════════════
  // 5. SHADOW A/B PIPELINE
  // ═══════════════════════════════════════════════════════════════
  console.log("\n══ 5. SHADOW A/B PIPELINE ══");

  // 5a. Shadow data availability
  const shadowData = await db.execute(sql`
    SELECT
      count(*) as total,
      count(*) FILTER (WHERE ml_score IS NOT NULL AND ml_features IS NOT NULL) as shadow_ready,
      count(*) FILTER (WHERE outcome NOT IN ('pending', 'void')) as settled
    FROM bets
    WHERE first_seen_at > NOW() - INTERVAL '7 days'
  `);
  const shd = shadowData.rows[0] as any;
  check(
    "Shadow data available (7d)",
    Number(shd.shadow_ready) > 0,
    `${shd.shadow_ready}/${shd.total} bets have score+features, ${shd.settled} settled`,
  );

  // 5b. Staker multiplier sanity — verify on a sample of scored bets
  const sampleBets = await db.execute(sql`
    SELECT ml_score, ml_features, outcome
    FROM bets
    WHERE ml_score IS NOT NULL AND ml_features IS NOT NULL
      AND outcome NOT IN ('pending', 'void')
      AND first_seen_at > NOW() - INTERVAL '7 days'
    ORDER BY first_seen_at DESC LIMIT 20
  `);

  let multiplierIssues = 0;
  let skippedByModelEdge = 0;
  let positiveModelEdge = 0;

  for (const row of sampleBets.rows) {
    const score = Number((row as any).ml_score);
    const features = (row as any).ml_features as number[];
    if (!features || features.length !== FEATURE_COUNT) {
      multiplierIssues++;
      continue;
    }

    const mult = computeRawStakeMultiplier(score, features);
    if (mult === 0) skippedByModelEdge++;
    else positiveModelEdge++;

    if (!isFinite(mult) || mult < 0) multiplierIssues++;
  }
  check(
    "Staker multiplier produces valid values",
    multiplierIssues === 0,
    `Checked ${sampleBets.rows.length} bets: ${positiveModelEdge} positive model edge, ${skippedByModelEdge} skipped by model edge, ${multiplierIssues} issues`,
  );

  // ═══════════════════════════════════════════════════════════════
  // 6. TRAINING → SCORING CONSISTENCY
  // ═══════════════════════════════════════════════════════════════
  console.log("\n══ 6. TRAINING → SCORING CONSISTENCY ══");

  // 6a. Training examples have outcomes that span recent data
  const recency = await db.execute(sql`
    SELECT
      min(coalesce(settled_at, created_at)) as oldest,
      max(coalesce(settled_at, created_at)) as newest,
      count(*) FILTER (WHERE created_at > NOW() - INTERVAL '3 days') as last_3d,
      count(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as last_7d
    FROM ml_training_examples
    WHERE label IS NOT NULL AND features IS NOT NULL
  `);
  const rec = recency.rows[0] as any;
  check(
    "Training data spans recent period",
    Number(rec.last_7d) > 0,
    `Oldest: ${rec.oldest}, Newest: ${rec.newest}, Last 3d: ${rec.last_3d}, Last 7d: ${rec.last_7d}`,
  );

  // 6b. Unsettled shadow_scored pending examples
  const pending = await db.execute(sql`
    SELECT count(*) as cnt
    FROM ml_training_examples
    WHERE label IS NULL AND features IS NOT NULL
  `);
  const nPending = Number(pending.rows[0]?.cnt ?? 0);
  if (nPending > 100) {
    warn(
      "Many unlabeled training examples",
      `${nPending} pending — may need label backfill`,
    );
  } else {
    check("Unlabeled examples count reasonable", true, `${nPending} pending`);
  }

  // 6c. Bets with features but no training example (gap check)
  const gap = await db.execute(sql`
    SELECT count(*) as cnt
    FROM bets b
    WHERE b.outcome NOT IN ('pending', 'void')
      AND b.ml_features IS NOT NULL
      AND b.ml_feature_version = ${ML_FEATURE_VERSION}
      AND b.first_seen_at > NOW() - INTERVAL '3 days'
      AND NOT EXISTS (
        SELECT 1 FROM ml_training_examples m
        WHERE m.source_bet_id = b.id
      )
  `);
  const nGap = Number(gap.rows[0]?.cnt ?? 0);
  if (nGap > 50) {
    warn(
      "Training example gap",
      `${nGap} settled bets in 3d have features but no training example`,
    );
  } else {
    check("Training examples cover recent bets", true, `${nGap} uncovered`);
  }

  // ═══════════════════════════════════════════════════════════════
  // 7. CALIBRATION DEEP CHECK
  // ═══════════════════════════════════════════════════════════════
  console.log("\n══ 7. CALIBRATION DEEP CHECK ══");

  // Use only recent bets (48h) to avoid contamination from old model scores
  const cal = await db.execute(sql`
    WITH buckets AS (
      SELECT
        CASE
          WHEN ml_score < 0.3 THEN '1_low'
          WHEN ml_score < 0.5 THEN '2_mid_low'
          WHEN ml_score < 0.7 THEN '3_mid_high'
          ELSE '4_high'
        END as bucket,
        ml_score, outcome
      FROM bets
      WHERE ml_score IS NOT NULL AND outcome NOT IN ('pending', 'void')
        AND first_seen_at > NOW() - INTERVAL '48 hours'
    )
    SELECT bucket, count(*) as n,
      round(avg(ml_score)::numeric, 3) as predicted,
      round(count(*) FILTER (WHERE outcome IN ('won','half_won'))::numeric / NULLIF(count(*),0), 3) as actual
    FROM buckets GROUP BY bucket ORDER BY bucket
  `);
  if (cal.rows.length === 0) {
    warn(
      "No settled+scored bets in 48h",
      "Cannot check calibration yet — waiting for data",
    );
  } else {
    let worstCalGap = 0;
    for (const row of cal.rows) {
      const b = row as any;
      const pred = Number(b.predicted);
      const actual = Number(b.actual);
      const n = Number(b.n);
      const gap = Math.abs(pred - actual);
      if (gap > worstCalGap) worstCalGap = gap;
      const calStatus =
        n < 10 ? WARN : gap < 0.1 ? PASS : gap < 0.2 ? WARN : FAIL;
      const small = n < 10 ? " small-sample" : "";
      console.log(
        `  ${calStatus} ${b.bucket}: predicted=${b.predicted} actual=${b.actual} gap=${gap.toFixed(3)} (N=${b.n}${small})`,
      );
    }
    if (worstCalGap > 0.25) {
      warn(
        "Calibration gap > 25% (may include stale model scores)",
        `Worst gap: ${(worstCalGap * 100).toFixed(1)}% — this should improve as the current model scores more settled bets`,
      );
    } else {
      check(
        "Calibration within 25%",
        true,
        `Worst gap: ${(worstCalGap * 100).toFixed(1)}%`,
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 8. MONOTONE CONSTRAINT VERIFICATION
  // ═══════════════════════════════════════════════════════════════
  console.log("\n══ 8. MONOTONE CONSTRAINT CHECK (trainer.py) ══");

  // Read the trainer file to verify constraints
  const fs = await import("fs");
  const trainerSrc = fs.readFileSync(
    "services/optimizer/app/trainer.py",
    "utf-8",
  );
  const constraintMatch = trainerSrc.match(
    /"monotone_constraints":\s*\[([\s\S]*?)\]/,
  );
  if (constraintMatch) {
    const constraintStr = constraintMatch[1];
    const constraints = constraintStr
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.match(/^[01-]/));

    const values = constraints.map((l) => parseInt(l));
    // sharp_true_prob is index 1, implied_prob_gap is index 4
    check(
      "sharp_true_prob is unconstrained (0)",
      values[1] === 0,
      `Constraint value: ${values[1]} (was 1, should be 0 after fix)`,
    );
    check(
      "implied_prob_gap is unconstrained (0)",
      values[4] === 0,
      `Constraint value: ${values[4]} (was 1, should be 0 after fix)`,
    );
    check(
      "ev_pct still constrained (+1)",
      values[0] === 1,
      `Constraint value: ${values[0]}`,
    );
    check(
      "kelly_fraction_raw still constrained (+1)",
      values[19] === 1,
      `Constraint value: ${values[19]}`,
    );
  } else {
    check("Found monotone_constraints in trainer.py", false, "Could not parse");
  }

  // ═══════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════
  console.log("\n" + "═".repeat(50));
  console.log(
    `RESULTS: ${totalChecks} checks — ${PASS} ${passed} passed, ${FAIL} ${failed} failed, ${WARN} ${warnings} warnings`,
  );
  if (failed > 0) {
    console.log("\n🔴 Pipeline has issues that need attention.");
    process.exit(1);
  } else if (warnings > 0) {
    console.log("\n🟡 Pipeline is functional but has advisory warnings.");
  } else {
    console.log("\n🟢 Pipeline is fully healthy.");
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
