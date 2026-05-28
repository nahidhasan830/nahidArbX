import { NextResponse } from "next/server";
import {
  createOrReuseLearningSnapshot,
  getLatestLearningSnapshot,
  hasLearningEvidence,
} from "@/lib/ml/learning/builder";
import { getLatestLearningExplanation } from "@/lib/db/repositories/ml-learning";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    let snapshot = await getLatestLearningSnapshot();
    if (!snapshot && (await hasLearningEvidence())) {
      snapshot = await createOrReuseLearningSnapshot({ trigger: "auto" });
    }
    const explanation = snapshot
      ? await getLatestLearningExplanation(snapshot.snapshotHash)
      : null;
    return NextResponse.json(
      { snapshot, explanation },
      { headers: { "Cache-Control": "private, no-cache" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
