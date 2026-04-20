import { NextRequest } from "next/server";
import { apiServerError, apiSuccess } from "@/lib/shared/api-response";
import { listExecutionsForStrategy } from "@/lib/db/repositories/strategy-executions";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? "200");
  try {
    const rows = await listExecutionsForStrategy(
      id,
      Math.min(1000, Math.max(1, limit)),
    );
    return apiSuccess({ rows });
  } catch (err) {
    return apiServerError(err, "Strategies:executions");
  }
}
