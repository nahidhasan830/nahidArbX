/**
 * GET /api/ml/models — list ML models with training metrics.
 * Direct DB query for the ml_models table.
 */
import { NextResponse } from "next/server";
import { desc, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mlModels } from "@/lib/db/schema";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const models = await db
      .select({
        id: mlModels.id,
        version: mlModels.version,
        status: mlModels.status,
        modelType: mlModels.modelType,
        trainingSamples: mlModels.trainingSamples,
        featureCount: mlModels.featureCount,
        featureVersion: mlModels.featureVersion,
        featureNamesHash: mlModels.featureNamesHash,
        trainingStartedAt: mlModels.trainingStartedAt,
        trainingCompletedAt: mlModels.trainingCompletedAt,
        oosRoiMean: mlModels.oosRoiMean,
        oosAccuracy: mlModels.oosAccuracy,
        oosAucRoc: mlModels.oosAucRoc,
        oosLogLoss: mlModels.oosLogLoss,
        deflatedSharpe: mlModels.deflatedSharpe,
        pbo: mlModels.pbo,
        calibrationError: mlModels.calibrationError,
        permissionLevel: mlModels.permissionLevel,
        rejectionReasons: mlModels.rejectionReasons,
        deployedAt: mlModels.deployedAt,
        retiredAt: mlModels.retiredAt,
        notifiedAt: mlModels.notifiedAt,
        createdAt: mlModels.createdAt,
      })
      .from(mlModels)
      .where(sql`NOT (${mlModels.version} = 0 AND ${mlModels.status} = 'failed')`)
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
