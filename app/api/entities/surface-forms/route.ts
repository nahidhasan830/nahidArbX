/**
 * Surface-form list — every entity_names row (candidate / active /
 * retired) with filtering. Powers the "Surface forms" tab in the
 * EntityInspector UI.
 *
 *   GET /api/entities/surface-forms?status=candidate&provider=pinnacle&q=athletic
 */

import { NextRequest, NextResponse } from "next/server";
import { listEntityNames } from "@/lib/db/repositories/entities";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status") as
    | "candidate"
    | "active"
    | "retired"
    | null;
  const provider = url.searchParams.get("provider");
  const search = url.searchParams.get("q");
  const limit = Number(url.searchParams.get("limit") ?? 200);
  const offset = Number(url.searchParams.get("offset") ?? 0);

  const items = await listEntityNames({
    status: status ?? undefined,
    provider: provider ?? undefined,
    search: search ?? undefined,
    limit,
    offset,
  });
  return NextResponse.json({ items, count: items.length });
}
