/**
 * Inbox — returns candidates that escalated to the operator.
 *
 * Ordered by last seen. The UI renders these as rich "needs your decision"
 * cards where the operator can verify against Gemini or Google AI Mode.
 */
import { NextResponse } from "next/server";
import { listInboxCandidates } from "@/lib/db/repositories/entities";

export async function GET() {
  const items = await listInboxCandidates(100);
  return NextResponse.json({ items, count: items.length });
}
