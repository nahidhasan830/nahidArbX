/**
 * POST /api/ml/retrain — triggers a Cloud Run Job for model retraining.
 */
import { NextResponse } from "next/server";
import { logger } from "@/lib/shared/logger";

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
    // Dynamic import to avoid bundling GCP deps in Next.js
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { JobsClient } = require("@google-cloud/run") as {
      JobsClient: new () => {
        runJob(req: { name: string }): Promise<unknown>;
      };
    };

    const client = new JobsClient();
    const name = `projects/${projectId}/locations/${region}/jobs/${jobName}`;
    await client.runJob({ name });

    logger.info("MLRetrain", `Triggered retraining job: ${jobName}`);
    return NextResponse.json({ ok: true, jobName });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("MLRetrain", `Failed to trigger retraining: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
