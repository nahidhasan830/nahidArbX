/**
 * GET /api/ml/status — proxies to engine for live ONNX scorer state.
 */
import { NextResponse } from "next/server";
import { engineGet } from "@/lib/engine-proxy";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const status = await engineGet<Record<string, unknown>>("/engine/ml/status");
    return NextResponse.json(status);
  } catch (err) {
    return NextResponse.json(
      {
        modelLoaded: false,
        modelVersion: null,
        featureCount: 0,
        totalScored: 0,
        avgInferenceMs: 0,
        lastInferenceMs: 0,
        error: err instanceof Error ? err.message : "Engine unreachable",
      },
      { status: 503 },
    );
  }
}
