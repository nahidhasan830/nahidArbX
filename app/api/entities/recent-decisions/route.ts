/**
 * Recent Decisions — feeds the main dashboard audit feed.
 *
 * Returns the last 50 auto-decisions (metadata->>'auto' = 'true') so the
 * operator can review and optionally override them.
 */
import { NextResponse } from "next/server";
import { listRecentDecisions } from "@/lib/db/repositories/entities";

export async function GET() {
  const items = await listRecentDecisions(50);
  // bigint id — coerce to string for JSON serialization
  const rows = items.map((r) => ({ ...r, id: String(r.id) }));
  return NextResponse.json({ items: rows, count: rows.length });
}
