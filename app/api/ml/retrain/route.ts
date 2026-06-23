import { NextResponse } from "next/server";
import { logger } from "@/lib/shared/logger";
import { triggerCloudTraining } from "@/lib/optimizer/cloud-training";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await triggerCloudTraining({ trigger: "manual" });

    if (!result.ok) {
      const status = result.reason === "already_running" ? 409 : 500;
      return NextResponse.json({ error: result.message }, { status });
    }

    return NextResponse.json({ ok: true, modelId: result.modelId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("MLCloudTrain", `Failed: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
