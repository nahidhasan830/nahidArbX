/**
 * Backfill ml_score on all settled bets using the current deployed ONNX model.
 *
 * Old ml_score values were produced by models trained on corrupted labels
 * (v100 and earlier, pre-AH-fix). This script re-scores every settled bet
 * with the current deployed model so paper-trading PnL delta and model
 * evaluation reflect the corrected predictions.
 *
 *   npx tsx scripts/backfill-ml-scores.ts            # dry-run
 *   npx tsx scripts/backfill-ml-scores.ts --execute  # apply
 */

import "dotenv/config";
import { ensureDbReady, db } from "../lib/db/client";
import { bets, mlModels } from "../lib/db/schema";
import { and, isNotNull, sql, eq } from "drizzle-orm";
import * as ort from "onnxruntime-node";
import * as fs from "fs";
import * as path from "path";
import { ML_FEATURE_COUNT, ML_FEATURE_VERSION } from "../lib/shared/constants";
import { FEATURE_NAMES_HASH } from "../lib/ml/feature-contract";

const EXECUTE = process.argv.includes("--execute");
const BATCH_SIZE = 500;
const VERSION = 107;

function applyIsotonic(score: number, x: number[], y: number[]): number {
  let idx = 0;
  for (let i = 0; i < x.length; i++) {
    if (score <= x[i]) { idx = i; break; }
    if (i === x.length - 1) idx = i;
  }
  if (idx === 0) return Math.max(0.05, Math.min(0.95, y[0]));
  const lo = x[idx - 1], hi = x[idx];
  const ly = y[idx - 1], hy = y[idx];
  const t = (hi - lo) > 1e-12 ? (score - lo) / (hi - lo) : 0;
  return Math.max(0.05, Math.min(0.95, ly + (hy - ly) * Math.max(0, Math.min(1, t))));
}

async function main(): Promise<void> {
  await ensureDbReady();

  console.log(`[backfill-ml-scores] mode=${EXECUTE ? "EXECUTE" : "DRY-RUN"}`);

  // 1. Find deployed model
  const modelFile = path.join(
    process.cwd(),
    ".ml-models",
    `model-v${VERSION}.onnx`,
  );
  if (!fs.existsSync(modelFile)) {
    console.error(`[backfill-ml-scores] model file not found: ${modelFile}`);
    process.exit(1);
  }

  console.log(`[backfill-ml-scores] loading ONNX model: ${modelFile}`);
  const session = await ort.InferenceSession.create(modelFile, {
    executionProviders: ["cpu"],
  });
  const inputName = session.inputNames[0] ?? "input";
  const outputName =
    session.outputNames.find((n) =>
      /prob/i.test(n),
    ) ?? session.outputNames[session.outputNames.length - 1];
  // For quantized models, prefer the float probabilities output over integer label
  console.log(
    `[backfill-ml-scores] model loaded: input=${inputName}, output=${outputName}`,
  );
  // Check if there's a better output
  console.log(`[backfill-ml-scores] available outputs: ${session.outputNames.join(", ")}`);

  // 2. Calibration params for the target model.
  const [modelRow] = await db
    .select({ trainingReport: mlModels.trainingReport })
    .from(mlModels)
    .where(eq(mlModels.version, VERSION))
    .limit(1);

  const report = modelRow?.trainingReport as {
    calibration_method?: unknown;
    calibration_params?: { x?: unknown; y?: unknown };
  } | undefined;
  if (
    report?.calibration_method !== "isotonic" ||
    !Array.isArray(report.calibration_params?.x) ||
    !Array.isArray(report.calibration_params?.y) ||
    report.calibration_params.x.length !== report.calibration_params.y.length ||
    report.calibration_params.x.length === 0
  ) {
    console.error(`[backfill-ml-scores] missing isotonic calibration for v${VERSION}`);
    process.exit(1);
  }
  const calXS = report.calibration_params.x.map(Number);
  const calYS = report.calibration_params.y.map(Number);
  console.log(`[backfill-ml-scores] loaded v${VERSION} isotonic calibration from ml_models`);

  function calibrate(raw: number): number {
    return applyIsotonic(raw, calXS, calYS);
  }

  // 3. Count how many settled bets have features
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(bets)
    .where(
      and(
        isNotNull(bets.mlFeatures),
        sql`${bets.outcome} IN ('won','lost','half_won','half_lost','void')`,
        sql`${bets.mlFeatureVersion} = ${ML_FEATURE_VERSION}`,
        sql`${bets.mlFeatureCount} = ${ML_FEATURE_COUNT}`,
        sql`${bets.mlFeatureNamesHash} = ${FEATURE_NAMES_HASH}`,
        sql`array_length(${bets.mlFeatures}, 1) = ${ML_FEATURE_COUNT}`,
      ),
    );
  const totalN = Number(total);
  console.log(`[backfill-ml-scores] ${totalN} settled bets with features`);

  // 3. Read in batches, score, compute diffs
  let offset = 0;
  let processed = 0;
  let wouldUpdate = 0;
  let updated = 0;
  const scoreChanges: Array<{
    id: string;
    oldScore: number | null;
    newScore: number;
    diff: number;
  }> = [];

  while (offset < totalN) {
    const rows = await db
      .select({
        id: bets.id,
        features: bets.mlFeatures,
        oldScore: bets.mlScore,
      })
      .from(bets)
      .where(
        and(
          isNotNull(bets.mlFeatures),
          sql`${bets.outcome} IN ('won','lost','half_won','half_lost','void')`,
          sql`${bets.mlFeatureVersion} = ${ML_FEATURE_VERSION}`,
          sql`${bets.mlFeatureCount} = ${ML_FEATURE_COUNT}`,
          sql`${bets.mlFeatureNamesHash} = ${FEATURE_NAMES_HASH}`,
          sql`array_length(${bets.mlFeatures}, 1) = ${ML_FEATURE_COUNT}`,
        ),
      )
      .orderBy(bets.id)
      .limit(BATCH_SIZE)
      .offset(offset);

    if (rows.length === 0) break;

    // Score batch (raw ONNX output)
    const featureArrays = rows.map((r) => {
      const raw = (r.features as unknown[]).slice(0, ML_FEATURE_COUNT).map((v) =>
        typeof v === "bigint" ? Number(String(v)) : Number(v)
      );
      return new Float32Array(raw);
    });

    const batchSize = Math.ceil(featureArrays.length / 50);
    const rawScores: number[] = [];
    for (let b = 0; b < batchSize; b++) {
      const chunk = featureArrays.slice(b * 50, (b + 1) * 50);
      const tensor = new ort.Tensor("float32", new Float32Array(chunk.length * ML_FEATURE_COUNT), [
        chunk.length,
        ML_FEATURE_COUNT,
      ]);
      for (let i = 0; i < Number(chunk.length); i++) {
        tensor.data.set(chunk[i], i * ML_FEATURE_COUNT);
      }
      const results = await session.run({ [inputName]: tensor }, [outputName]);
      const output = results[outputName].data;
      if (output instanceof Float32Array) {
        for (let i = 0; i < Number(chunk.length); i++) {
          rawScores.push(
            output.length === chunk.length * 2 ? output[i * 2 + 1] : output[i],
          );
        }
      } else {
        for (let i = 0; i < Number(chunk.length); i++) {
          const v = output.length === chunk.length * 2
            ? output[i * 2 + 1]
            : output[i];
          rawScores.push(typeof v === "bigint" ? Number(String(v)) : Number(v));
        }
      }
    }

    // Apply calibration (isotonic step function → clip [0.05, 0.95])
    const scores = rawScores.map((s) => calibrate(Math.max(0, Math.min(1, Number(s)))));

    // Compare and update in bulk
    const updates: Array<{ id: string; score: number }> = [];
    for (let i = 0; i < Number(rows.length); i++) {
      const row = rows[i];
      const newScore = Number(scores[i]);
      const oldScoreRaw = row.oldScore;
      const oldScore = oldScoreRaw != null
        ? (typeof oldScoreRaw === "bigint" ? Number(String(oldScoreRaw)) : Number(oldScoreRaw))
        : null;

      processed++;
      if (oldScore == null || Math.abs(Number(newScore) - Number(oldScore)) > 1e-6) {
        wouldUpdate++;
        updates.push({ id: row.id, score: newScore });
      }
    }

    if (updates.length > 0 && EXECUTE) {
      for (const u of updates) {
        await db.update(bets).set({ mlScore: u.score }).where(eq(bets.id, u.id));
        updated++;
      }
    }

    if (updates.length > 0 && scoreChanges.length < 10) {
      for (const u of updates.slice(0, 10)) {
        const old = rows.find((r) => r.id === u.id);
        scoreChanges.push({
          id: u.id,
          oldScore: old?.oldScore != null ? Number(old.oldScore) : null,
          newScore: u.score,
          diff: old?.oldScore != null ? u.score - Number(old.oldScore) : u.score,
        });
      }
    }

    offset += Number(rows.length);
    if (offset % 2000 === 0 || offset >= totalN) {
      console.log(
        `[backfill-ml-scores] progress: ${offset}/${totalN} rows, ${wouldUpdate} would change`,
      );
    }
  }

  console.log(
    `\n[backfill-ml-scores] processed ${processed} bets, ${wouldUpdate} would change (${EXECUTE ? updated + " updated" : "DRY-RUN"})`,
  );

  if (scoreChanges.length > 0) {
    console.log("\n[backfill-ml-scores] sample score changes:");
    for (const c of scoreChanges) {
      console.log(
        `  ${c.id.slice(0, 45)}...  ${c.oldScore?.toFixed(4) ?? "null"} → ${c.newScore.toFixed(4)}  (Δ${c.diff >= 0 ? "+" : ""}${c.diff.toFixed(4)})`,
      );
    }
  }

  if (!EXECUTE) {
    console.log("\n[backfill-ml-scores] DRY-RUN — re-run with --execute to apply.");
  }

  console.log("\n[backfill-ml-scores] done.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-ml-scores] FAILED:", err);
    process.exit(1);
  });
