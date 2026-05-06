/**
 * POST /api/ml/retrain — triggers a Cloud Run Job for model retraining.
 */
import { NextResponse } from "next/server";
import { logger } from "@/lib/shared/logger";
import { ML_FEATURE_VERSION } from "@/lib/shared/constants";

export const dynamic = "force-dynamic";

export async function POST() {
  const jobName = process.env.OPTIMIZER_JOB_NAME;
  const region = process.env.GCP_REGION;
  const projectId = process.env.GCP_PROJECT_ID;

  if (!jobName || !region || !projectId) {
    return NextResponse.json(
      { error: "GCP config not set (OPTIMIZER_JOB_NAME / GCP_REGION / GCP_PROJECT_ID)" },
      { status: 503 },
    );
  }

  try {
    const runModule = await import("@google-cloud/run");
    const JobsClient = runModule.JobsClient || runModule.default?.JobsClient;

    const client = new JobsClient();
    const name = `projects/${projectId}/locations/${region}/jobs/${jobName}`;
    await client.runJob({
      name,
      overrides: {
        containerOverrides: [{
          env: [{ name: "EXPECTED_FEATURE_VERSION", value: String(ML_FEATURE_VERSION) }],
        }],
      },
    });

    logger.info("MLRetrain", `Triggered retraining job: ${jobName}`);

    // Insert dummy training row to make the UI pulse "In Training"
    try {
      const { db } = await import("@/lib/db/client");
      const { mlModels } = await import("@/lib/db/schema");
      const { sql } = await import("drizzle-orm");
      
      const [{ maxVersion }] = await db
        .select({ maxVersion: sql<number>`COALESCE(MAX(${mlModels.version}), 0)::int` })
        .from(mlModels);

      const modelId = `training-${Date.now()}`;
      const newVersion = maxVersion + 1;
        
      await db.insert(mlModels).values({
        id: modelId,
        version: newVersion,
        status: "training",
        modelType: "lightgbm",
        trainingSamples: 0,
        featureCount: 25,
        featureVersion: 2,
        trainingStartedAt: new Date().toISOString(),
      });

      // Emit real-time training-started event for SSE subscribers
      try {
        const { emitTrainingStarted } = await import("@/lib/optimizer/training-poller");
        emitTrainingStarted(modelId, newVersion);
      } catch { /* engine-only module — skip in web process */ }
    } catch (e) {
      logger.warn("MLRetrain", `Failed to insert training row: ${e}`);
    }

    return NextResponse.json({ ok: true, jobName });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("MLRetrain", `Failed to trigger retraining: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
