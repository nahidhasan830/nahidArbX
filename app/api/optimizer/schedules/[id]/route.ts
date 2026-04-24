/**
 * GET    /api/optimizer/schedules/[id]            — schedule + recent run history
 * PATCH  /api/optimizer/schedules/[id]            — { enabled?: boolean }
 *                                                    (extend with full edit later)
 * DELETE /api/optimizer/schedules/[id]            — drop the schedule
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteSchedule,
  getSchedule,
  listRunsForSchedule,
  setScheduleEnabled,
} from "@/lib/optimizer/schedules";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const schedule = await getSchedule(id);
  if (!schedule)
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  const history = await listRunsForSchedule(id, 50);
  return NextResponse.json({ schedule, history });
}

const patchBody = z.object({ enabled: z.boolean().optional() });

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: z.infer<typeof patchBody>;
  try {
    body = patchBody.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      {
        error: "invalid_body",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 400 },
    );
  }
  if (typeof body.enabled === "boolean") {
    const ok = await setScheduleEnabled(id, body.enabled);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const schedule = await getSchedule(id);
  return NextResponse.json({ schedule });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ok = await deleteSchedule(id);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
