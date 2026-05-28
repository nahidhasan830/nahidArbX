import { NextResponse } from "next/server";
import {
  createOrReuseLearningSnapshot,
  getLatestLearningSnapshot,
} from "@/lib/ml/learning/builder";
import { explainLearningSnapshot } from "@/lib/ml/learning/explainer";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      force?: boolean;
      modelTier?: "flash" | "pro";
      explanationType?: string;
    };
    const snapshot =
      (await getLatestLearningSnapshot()) ??
      (await createOrReuseLearningSnapshot({ trigger: "manual" }));
    const explanation = await explainLearningSnapshot(snapshot, {
      force: body.force ?? false,
      modelTier: body.modelTier ?? "flash",
      explanationType: body.explanationType ?? "operator",
    });
    return NextResponse.json({ snapshot, explanation });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
