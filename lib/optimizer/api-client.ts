/**
 * Triggers Cloud Run Jobs executions for the optimizer sidecar.
 *
 * Replaces the old HTTP wrapper around a long-running FastAPI sidecar.
 * Each call to `triggerJobExecution(runId)` POSTs to the Cloud Run
 * Admin API (`projects.locations.jobs.run`) with `RUN_ID` injected via
 * `containerOverrides.env`. The Job container reads `RUN_ID`, runs the
 * sweep to completion, and exits — no orphaned background tasks, no
 * autoscaler reaping (the issue that motivated the migration).
 *
 * Cancellation is purely DB-driven: `runner._cancel_watcher` polls
 * `optimization_runs.status='cancelled'` every 2s and exits cleanly.
 * The Next.js cancel route just flips the DB row; it no longer needs
 * to call the sidecar.
 *
 * Auth: Application Default Credentials via `google-auth-library`.
 * Locally, ADC is the operator's `gcloud auth application-default login`
 * identity. In a deployed Next.js, the runtime SA needs
 * `roles/run.invoker` (or `roles/run.developer`) on the Job.
 */

import { GoogleAuth } from "google-auth-library";
import { logger } from "../shared/logger";

const tag = "OptimizerJobsClient";

const SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];

// Lazy singleton — the GoogleAuth instance caches token refresh internally.
let _auth: GoogleAuth | null = null;
function getAuth(): GoogleAuth {
  if (_auth) return _auth;
  _auth = new GoogleAuth({ scopes: SCOPES });
  return _auth;
}

interface JobsRunConfig {
  projectId: string;
  region: string;
  jobName: string;
}

function getConfig(): JobsRunConfig {
  const projectId = process.env.GCP_PROJECT_ID;
  const region = process.env.GCP_REGION;
  const jobName = process.env.OPTIMIZER_JOB_NAME;
  if (!projectId || !region || !jobName) {
    throw new Error(
      "Missing GCP_PROJECT_ID / GCP_REGION / OPTIMIZER_JOB_NAME — required to trigger the optimizer Job",
    );
  }
  return { projectId, region, jobName };
}

/**
 * Trigger a fresh Cloud Run Jobs execution for `runId`. Returns when the
 * Admin API has accepted the request (= execution is queued); does NOT
 * wait for the sweep to complete (sweeps can run for hours).
 *
 * Throws on any 4xx/5xx — caller should log and retry on the next tick
 * (the scheduler does this; the immediate-kick route swallows + logs).
 */
export async function triggerJobExecution(
  runId: string,
): Promise<{ executionName: string }> {
  const { projectId, region, jobName } = getConfig();
  const auth = getAuth();
  const tokenResp = await auth.getAccessToken();
  const token = typeof tokenResp === "string" ? tokenResp : tokenResp;
  if (!token) {
    throw new Error("ADC returned an empty access token");
  }

  const url = `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/jobs/${jobName}:run`;
  const body = {
    overrides: {
      containerOverrides: [
        {
          env: [{ name: "RUN_ID", value: runId }],
        },
      ],
    },
  };

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`jobs:run ${res.status}: ${text || res.statusText}`);
    }
    const data = (await res.json()) as {
      name?: string;
      metadata?: { name?: string };
    };
    // The Operation response has `name` like
    // `projects/<p>/locations/<r>/operations/<op-id>`. The execution name
    // (a child of the Job) appears in `metadata.name`. Either is fine for
    // logging; prefer metadata.name when present.
    const executionName = data.metadata?.name ?? data.name ?? "<unknown>";
    logger.info(
      tag,
      `Job execution triggered for run ${runId}: ${executionName}`,
    );
    return { executionName };
  } finally {
    clearTimeout(timeout);
  }
}
