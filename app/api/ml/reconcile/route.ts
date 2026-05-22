/**
 * POST /api/ml/reconcile — run reconcileMissingSettledExamples in-process.
 *
 * Idempotent. Safe to retry. Returns the number of training examples
 * actually written (0 when the corpus is fully covered).
 */

import { NextResponse } from "next/server";
import { logger } from "@/lib/shared/logger";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const { reconcileMissingSettledExamples } = await import(
      "@/lib/ml/training-example-writer"
    );
    const written = await reconcileMissingSettledExamples(500);
    return NextResponse.json({ ok: true, written });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("MLReconcile", `Failed: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
