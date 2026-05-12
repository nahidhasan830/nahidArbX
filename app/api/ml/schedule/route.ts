/**
 * GET/POST /api/ml/schedule — ML retraining scheduler settings.
 *
 * GET:  Returns current scheduler config + runtime state.
 * POST: Updates scheduler config (enabled, cadence, thresholds).
 *
 * Single-row config in `ml_scheduler_settings` (id='default').
 * The engine's scheduler reads this table every tick.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, ensureDbReady } from "@/lib/db/client";
import { mlSchedulerSettings } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";

async function getOrCreateSettings() {
  await ensureDbReady();
  const [existing] = await db
    .select()
    .from(mlSchedulerSettings)
    .where(eq(mlSchedulerSettings.id, "default"))
    .limit(1);

  if (existing) return existing;

  // Seed defaults
  const [created] = await db
    .insert(mlSchedulerSettings)
    .values({ id: "default" })
    .onConflictDoNothing()
    .returning();

  return (
    created ??
    (await db
      .select()
      .from(mlSchedulerSettings)
      .where(eq(mlSchedulerSettings.id, "default"))
      .limit(1)
      .then((r) => r[0]))
  );
}

export async function GET() {
  try {
    const settings = await getOrCreateSettings();

    // Fetch engine scheduler runtime state
    let engineState: Record<string, unknown> | null = null;
    try {
      const enginePort = process.env.ENGINE_PORT || "3001";
      const resp = await fetch(
        `http://127.0.0.1:${enginePort}/engine/ml/scheduler`,
        {
          signal: AbortSignal.timeout(2000),
        },
      );
      if (resp.ok) {
        engineState = (await resp.json()) as Record<string, unknown>;
      }
    } catch {
      // Engine not running — fine for dev
    }

    return NextResponse.json({
      settings,
      runtime: engineState,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Record<string, unknown>;

    // Validate fields
    const updates: Record<string, unknown> = {};

    if (typeof body.enabled === "boolean") {
      updates.enabled = body.enabled;
    }
    if (
      typeof body.cadenceHours === "number" &&
      body.cadenceHours >= 1 &&
      body.cadenceHours <= 168
    ) {
      updates.cadenceHours = Math.round(body.cadenceHours);
    }
    if (
      typeof body.minNewSettledExamples === "number" &&
      body.minNewSettledExamples >= 10 &&
      body.minNewSettledExamples <= 1000
    ) {
      updates.minNewSettledExamples = Math.round(body.minNewSettledExamples);
    }
    if (
      typeof body.minGrowthPct === "number" &&
      body.minGrowthPct >= 5 &&
      body.minGrowthPct <= 100
    ) {
      updates.minGrowthPct = Math.round(body.minGrowthPct);
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: "No valid fields to update" },
        { status: 400 },
      );
    }

    await ensureDbReady();

    // Upsert: update existing or create default row
    const [updated] = await db
      .insert(mlSchedulerSettings)
      .values({ id: "default", ...updates })
      .onConflictDoUpdate({
        target: mlSchedulerSettings.id,
        set: {
          ...updates,
          updatedAt: sql`now()`,
        },
      })
      .returning();

    return NextResponse.json({ settings: updated });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
