/**
 * GET  /api/optimizer/schedules — list every recurring optimization schedule.
 * POST /api/optimizer/schedules — create a new schedule.
 *
 * Body shape (POST) — frequency is a discriminated union to keep the UI
 * honest (no free-form cron string in v1):
 *   { kind: "every_n_hours", hours: 1|2|4|6|12 }
 *   { kind: "daily",         hourLocal: 0..23 }
 *   { kind: "weekly",        dayOfWeek: 0..6, hourLocal: 0..23 }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSchedule, listSchedules } from "@/lib/optimizer/schedules";

const frequency = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("every_n_hours"),
    hours: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(4),
      z.literal(6),
      z.literal(12),
    ]),
  }),
  z.object({
    kind: z.literal("daily"),
    hourLocal: z.number().int().min(0).max(23),
  }),
  z.object({
    kind: z.literal("weekly"),
    dayOfWeek: z.number().int().min(0).max(6),
    hourLocal: z.number().int().min(0).max(23),
  }),
]);

const createBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
  timezone: z.string().optional(),
  frequency,
  nTrialsTarget: z.number().int().min(10).max(50_000).optional(),
  searchAlgorithm: z.enum(["random", "tpe", "nsga2", "ensemble"]).optional(),
  searchSpace: z
    .object({ dimensions: z.array(z.record(z.string(), z.unknown())) })
    .optional(),
  cvStrategy: z
    .object({
      type: z.enum(["cpcv", "walkforward"]).optional(),
      n_groups: z.number().int().min(2).max(20).optional(),
      n_test_groups: z.number().int().min(1).max(10).optional(),
      embargo_pct: z.number().min(0).max(0.2).optional(),
    })
    .optional(),
  dataFilters: z
    .object({
      excludeSoftProviders: z.array(z.string()).optional(),
      includeSoftProviders: z.array(z.string()).optional(),
      excludeMarketTypes: z.array(z.string()).optional(),
      includeMarketTypes: z.array(z.string()).optional(),
      eventStartFrom: z.string().datetime().optional(),
      eventStartTo: z.string().datetime().optional(),
      placedOnly: z.boolean().optional(),
    })
    .optional(),
  notifyOnComplete: z.boolean().optional(),
});

export async function GET() {
  const schedules = await listSchedules();
  return NextResponse.json({ schedules });
}

export async function POST(req: Request) {
  let parsed: z.infer<typeof createBody>;
  try {
    parsed = createBody.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      {
        error: "invalid_body",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 400 },
    );
  }

  const sched = await createSchedule({
    name: parsed.name,
    description: parsed.description,
    enabled: parsed.enabled,
    timezone: parsed.timezone,
    frequency: parsed.frequency,
    nTrialsTarget: parsed.nTrialsTarget,
    searchAlgorithm: parsed.searchAlgorithm,
    searchSpace: parsed.searchSpace as never,
    cvStrategy: parsed.cvStrategy as never,
    dataFilters: parsed.dataFilters,
    notifyOnComplete: parsed.notifyOnComplete,
  });

  return NextResponse.json({ schedule: sched }, { status: 201 });
}
