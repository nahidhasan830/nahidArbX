/**
 * PATCH /api/ml/training/[id] — operator controls for an active training row.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mlModels } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

const ALLOWED_ACTIONS = new Set(["cancel", "fail"]);

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    reason?: string;
  };
  const action = body.action ?? "cancel";

  if (!ALLOWED_ACTIONS.has(action)) {
    return NextResponse.json(
      { error: "Unsupported training action" },
      { status: 400 },
    );
  }

  const reason =
    body.reason?.trim() ||
    (action === "cancel"
      ? "Training cancelled by operator."
      : "Training marked failed by operator.");

  await db
    .update(mlModels)
    .set({
      status: "failed",
      rejectionReasons: [reason],
      trainingStage: "failed",
      progressMessage: reason,
      lastHeartbeatAt: new Date().toISOString(),
      estimatedTimeRemainingMs: 0,
      trainingCompletedAt: new Date().toISOString(),
    })
    .where(eq(mlModels.id, id));

  return NextResponse.json({ ok: true, modelId: id, status: "failed" });
}
