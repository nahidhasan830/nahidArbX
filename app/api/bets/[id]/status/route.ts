/**
 * GET /api/bets/placement-status/[id]
 *
 * Tells the frontend what happened to a submission that came back as
 * `status=pending`. Three terminal states the caller can distinguish:
 *
 *   - `pending`  — confirmation tracker still polling the book's feed.
 *   - `placed`   — matching ticket appeared; row is in `bets`.
 *   - `timeout`  — tracker dropped it after the 2-minute deadline
 *                  without finding a matching ticket (no DB row).
 *
 * `id` is the `placementId` returned by POST /api/bets/place. For
 * synchronously confirmed placements (`status=placed` from /place) the
 * id is already the canonical `bets.id`, so polling also works there.
 */
import { NextResponse } from "next/server";
import { getPlacedBetById } from "@/lib/db/repositories/bets";
import { getPendingConfirmationByPlacementId as getNwPending } from "@/lib/betting/ninewickets/placement-confirmation";
import { getPendingConfirmationByPlacementId as getVelkiPending } from "@/lib/betting/velki/placement-confirmation";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const row = await getPlacedBetById(id);
  if (row) {
    return NextResponse.json({
      status: "placed",
      placedBetId: row.id,
      ticketId: row.providerTicketId,
      bookedOdds: Number(row.odds),
      stake: Number(row.stake),
    });
  }

  // Both providers run their own in-memory tracker keyed by the same
  // placementId namespace. The id is unique across providers (UUID v4),
  // so probing both is safe — at most one returns a hit.
  const pending = getNwPending(id) ?? getVelkiPending(id);
  if (pending) {
    return NextResponse.json({
      status: "pending",
      placedBetId: pending.placementId,
      ticketId: pending.ticketIdHint,
      bookedOdds: pending.bookedOdds,
      stake: pending.stake,
      submittedAt: pending.submittedAt,
      deadlineAt: pending.deadlineAt,
    });
  }

  return NextResponse.json({ status: "timeout", placedBetId: id });
}
