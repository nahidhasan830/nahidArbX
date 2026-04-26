/**
 * Observations log — append-only `name_observations` audit history.
 * Filterable by source / outcome / provider / surface text.
 */

import { NextRequest, NextResponse } from "next/server";
import { listObservations } from "@/lib/db/repositories/entities";
import type {
  ObservationOutcome,
  ObservationSource,
} from "@/lib/db/repositories/entities";

const VALID_SOURCES: ObservationSource[] = [
  "harvester",
  "match-review",
  "learner",
  "settle",
];
const VALID_OUTCOMES: ObservationOutcome[] = [
  "matched",
  "rejected",
  "near-match",
  "manual-confirm",
  "manual-reject",
];

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const source = url.searchParams.get("source") ?? undefined;
  const outcome = url.searchParams.get("outcome") ?? undefined;
  const provider = url.searchParams.get("provider") ?? undefined;
  const search = url.searchParams.get("q") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 500);

  const rows = await listObservations({
    source: VALID_SOURCES.includes(source as ObservationSource)
      ? (source as ObservationSource)
      : undefined,
    outcome: VALID_OUTCOMES.includes(outcome as ObservationOutcome)
      ? (outcome as ObservationOutcome)
      : undefined,
    provider,
    search,
    limit,
  });
  // `id` is a bigint (bigserial) and `JSON.stringify` throws on bigint.
  // Coerce to string at the wire boundary.
  const items = rows.map((r) => ({ ...r, id: String(r.id) }));
  return NextResponse.json({ items, count: items.length });
}
