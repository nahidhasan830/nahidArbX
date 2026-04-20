import { NextRequest } from "next/server";
import { z } from "zod";
import {
  apiBadRequest,
  apiNotFound,
  apiServerError,
  apiSuccess,
} from "@/lib/shared/api-response";
import {
  deleteStrategy,
  getStrategyById,
  updateStrategy,
} from "@/lib/db/repositories/strategies";

const PatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(1000).nullable().optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
  stakeMultiplier: z.number().positive().max(10).optional(),
  rationale: z.string().max(8000).nullable().optional(),
  status: z.enum(["candidate", "live", "paused", "retired"]).optional(),
  metricsSnapshot: z.record(z.string(), z.unknown()).nullable().optional(),
});

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const row = await getStrategyById(id);
    if (!row) return apiNotFound("Strategy not found");
    return apiSuccess({ row });
  } catch (err) {
    return apiServerError(err, "Strategies:get");
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiBadRequest("Invalid JSON body");
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest(
      parsed.error.issues[0]?.message ?? "Invalid patch payload",
    );
  }
  try {
    const row = await updateStrategy(id, parsed.data);
    if (!row) return apiNotFound("Strategy not found");
    return apiSuccess({ row });
  } catch (err) {
    return apiServerError(err, "Strategies:update");
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const ok = await deleteStrategy(id);
    if (!ok) return apiNotFound("Strategy not found");
    return apiSuccess({ id });
  } catch (err) {
    return apiServerError(err, "Strategies:delete");
  }
}
