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
