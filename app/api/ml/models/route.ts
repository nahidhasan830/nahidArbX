/**
 * GET /api/ml/models — list ML models with training metrics.
 * Direct DB query for the ml_models table.
 */
import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mlModels } from "@/lib/db/schema";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const models = await db
      .select()
      .from(mlModels)
      .orderBy(desc(mlModels.createdAt))
      .limit(50);

    return NextResponse.json({ models });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
