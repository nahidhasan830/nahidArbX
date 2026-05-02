/**
 * GET  /api/betting-settings  → current settings
 * PUT  /api/betting-settings  → update any subset of fields
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getBettingSettings,
  updateBettingSettings,
} from "@/lib/db/repositories/betting-settings";
import { logger } from "@/lib/shared/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const positiveNumber = z.number().positive();
const nonNegativeNumber = z.number().min(0);

const PatchSchema = z
  .object({
    useLiveBalance: z.boolean(),
    manualBankrollBdt: positiveNumber,
    unitSizeBdt: positiveNumber,
    kellyCapPct: z.number().min(0).max(100),
    kellyFraction: z.number().gt(0).max(1),
    minStakeBdt: nonNegativeNumber,
    stakeBucketBdt: positiveNumber,
    minEvPct: nonNegativeNumber,
  })
  .partial();

export async function GET() {
  const { row, ready, error } = await getBettingSettings();
  return NextResponse.json({
    settings: row,
    ready,
    error: ready ? undefined : (error ?? "Settings unavailable"),
  });
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  // Cross-field invariant: when use_live_balance=false, a positive
  // manual bankroll is required. We don't enforce it here unconditionally
  // because the caller may be PATCHing just one field — we re-check
  // after merging with the stored row.
  const { row: current } = await getBettingSettings();
  const merged = { ...current, ...parsed.data };
  if (!merged.useLiveBalance && !(merged.manualBankrollBdt > 0)) {
    return NextResponse.json(
      {
        error:
          "manualBankrollBdt must be positive when useLiveBalance is false",
      },
      { status: 400 },
    );
  }
  if (merged.stakeBucketBdt > merged.minStakeBdt) {
    return NextResponse.json(
      {
        error:
          "stakeBucketBdt must not exceed minStakeBdt (otherwise sub-min stakes slip through)",
      },
      { status: 400 },
    );
  }

  const updated = await updateBettingSettings(parsed.data);
  logger.info(
    "BettingSettings",
    `updated fields: ${Object.keys(parsed.data).join(", ")}`,
  );
  return NextResponse.json({ settings: updated });
}
