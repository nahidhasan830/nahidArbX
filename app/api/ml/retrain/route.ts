/**
 * POST /api/ml/retrain — cloud-only training via Cloud Build + Cloud Run Job.
 *
 * Flow:
 *   1. Insert a "training" row → UI shows spinner immediately
 *   2. Spawn `scripts/cloud-train.sh` in background which:
 *      a. `gcloud builds submit` → builds fresh Docker image from current source
 *      b. Deploys the image to the Cloud Run Job
 *      c. `gcloud run jobs execute` → runs the training pipeline
 *   3. Python job writes results to DB → UI auto-updates
 *
 * This permanently eliminates stale-image failures because the image
 * is always rebuilt from current source before the job executes.
 */
import { NextResponse } from "next/server";
import { logger } from "@/lib/shared/logger";
import { ML_FEATURE_COUNT, ML_FEATURE_VERSION } from "@/lib/shared/constants";
import { FEATURE_NAMES_HASH } from "@/lib/ml/features";
import { spawn, execSync } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function POST() {
  try {
    // ── 1. Guard against duplicate training runs ─────────────────────
    const { db } = await import("@/lib/db/client");
    const { mlModels } = await import("@/lib/db/schema");
    const { sql, eq } = await import("drizzle-orm");

    const [existing] = await db
      .select({ id: mlModels.id })
      .from(mlModels)
      .where(eq(mlModels.status, "training"))
      .limit(1);

    if (existing) {
      return NextResponse.json(
        {
          error:
            "A training run is already in progress. Wait for it to complete or check the dashboard.",
        },
        { status: 409 },
      );
    }

    // ── 2. Insert training row → UI shows spinner ────────────────────

    const [{ maxVersion }] = await db
      .select({
        maxVersion: sql<number>`COALESCE(MAX(${mlModels.version}), 0)::int`,
      })
      .from(mlModels);

    const modelId = `cloud-training-${Date.now()}`;

    // Use version 0 for the training placeholder — the Python job assigns
    // the real version number only on success. This prevents failed
    // attempts from wasting version numbers.
    await db.insert(mlModels).values({
      id: modelId,
      version: 0,
      status: "training",
      modelType: "lightgbm",
      trainingSamples: 0,
      featureCount: ML_FEATURE_COUNT,
      featureVersion: ML_FEATURE_VERSION,
      featureNamesHash: FEATURE_NAMES_HASH,
      trainingStartedAt: new Date().toISOString(),
    });

    // Emit SSE event for real-time UI updates
    try {
      const { emitTrainingStarted } =
        await import("@/lib/optimizer/training-poller");
      emitTrainingStarted(modelId, maxVersion + 1);
    } catch {
      /* engine-only module — skip in web process */
    }

    // ── 2. Resolve git SHA early (needed for notification + build) ───
    const repoRoot = process.cwd();
    let shortSha: string;
    try {
      shortSha = execSync("git rev-parse --short HEAD", { cwd: repoRoot })
        .toString()
        .trim();
    } catch {
      shortSha = `manual-${Date.now().toString(36)}`;
    }

    // ── 3. Spawn build → deploy → run pipeline in background ─────────
    const scriptPath = path.join(repoRoot, "scripts/cloud-train.sh");
    const child = spawn("bash", [scriptPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        SHORT_SHA: shortSha,
        EXPECTED_FEATURE_VERSION: String(ML_FEATURE_VERSION),
        TRAINING_MODEL_ID: modelId,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    child.stdout.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) logger.info("MLCloudTrain", line.trim());
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) logger.warn("MLCloudTrain", line.trim());
      }
    });

    child.on("exit", async (code) => {
      if (code !== 0 && code !== null) {
        logger.warn("MLCloudTrain", `Pipeline exited with code ${code}`);
        try {
          const { db: d } = await import("@/lib/db/client");
          const { mlModels: m } = await import("@/lib/db/schema");
          const { eq } = await import("drizzle-orm");
          await d
            .update(m)
            .set({
              status: "failed",
              rejectionReasons: [
                `Cloud Build + Run pipeline failed (exit code ${code})`,
              ],
              trainingCompletedAt: new Date().toISOString(),
            })
            .where(eq(m.id, modelId));
        } catch {
          /* best effort */
        }
      }
    });

    child.unref();
    logger.info("MLCloudTrain", `Started cloud training: SHA=${shortSha}`);

    // ── 4. Send Telegram notification out-of-band ───────────────────
    // Notification/accounting work must never block the frontend action or
    // prevent the Cloud Run job from starting.
    void withTimeout(
      (async () => {
        const { desc, eq: eqOp } = await import("drizzle-orm");
        const { getTrainingSampleAccounting } = await import(
          "@/lib/ml/training-sample-accounting"
        );
        const { writeMissingSettledExamples } = await import(
          "@/lib/ml/training-example-writer"
        );
        await writeMissingSettledExamples(500);
        const accounting = await getTrainingSampleAccounting(db);

        const [prevModel] = await db
          .select({
            version: mlModels.version,
            trainingSamples: mlModels.trainingSamples,
          })
          .from(mlModels)
          .where(eqOp(mlModels.status, "deployed"))
          .orderBy(desc(mlModels.deployedAt))
          .limit(1);

        const { notify } = await import("@/lib/notifier");
        await notify({
          type: "ml:training_started",
          at: new Date().toISOString(),
          modelId,
          version: maxVersion + 1,
          qualifiedBets: accounting.qualifiedBets,
          rawLabeledExamples: accounting.rawLabeledExamples,
          canonicalExamples: accounting.canonicalExamples,
          uncoveredQualifiedBets: accounting.uncoveredQualifiedBets,
          trainerExpectedSamples: accounting.trainerExpectedSamples,
          featureVersion: ML_FEATURE_VERSION,
          featureCount: ML_FEATURE_COUNT,
          trigger: "manual",
          gitSha: shortSha,
          previousModelVersion: prevModel?.version ?? undefined,
          previousModelSamples: prevModel?.trainingSamples ?? undefined,
        });
      })(),
      10_000,
      "Telegram ML training notification",
    ).catch((notifyErr) => {
      logger.warn(
        "MLCloudTrain",
        `Telegram notification failed: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`,
      );
    });

    return NextResponse.json({ ok: true, modelId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("MLCloudTrain", `Failed: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
