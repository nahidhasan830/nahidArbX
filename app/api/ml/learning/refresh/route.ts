import { NextResponse } from "next/server";
import { createOrReuseLearningSnapshot } from "@/lib/ml/learning/builder";
import { explainLearningSnapshot } from "@/lib/ml/learning/explainer";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      explain?: boolean;
      modelTier?: "flash" | "pro";
      trigger?: string;
    };
    const snapshot = await createOrReuseLearningSnapshot({
      trigger: body.trigger ?? "manual",
    });
    const explanation = body.explain
      ? await explainLearningSnapshot(snapshot, {
          modelTier: body.modelTier ?? "flash",
          force: false,
        })
      : null;

    return NextResponse.json({ snapshot, explanation });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
