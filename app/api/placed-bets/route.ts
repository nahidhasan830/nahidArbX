/**
 * GET /api/placed-bets
 *
 * Returns every placed bet we've recorded, newest first.
 */
import { NextResponse } from "next/server";
import { listPlacedBets } from "@/lib/db/repositories/placed-bets";
import { BETTING_PROVIDERS } from "@/lib/betting/registry";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const rows = await listPlacedBets(200);
  const bets = rows.map((r) => {
    const adapter = BETTING_PROVIDERS[r.provider];
    return {
      id: r.id,
      placedAt: r.placedAt,
      provider: r.provider,
      providerDisplayName: adapter?.providerDisplayName ?? r.provider,
      sport: r.competition ?? "—",
      league: r.competition ?? "—",
      eventName: r.eventName,
      marketName: r.marketType,
      marketFamily: r.familyId,
      selectionName: r.atomLabel,
      stake: Number(r.stake),
      kellyStake: Number(r.stake),
      odds: Number(r.odds),
      closingOdds: r.closingOdds === null ? null : Number(r.closingOdds),
      evPct: 0,
      clvPct: r.clvPct === null ? null : Number(r.clvPct),
      status: mapOutcome(r.outcome),
      pnl: r.pnl === null ? null : Number(r.pnl),
      currency: r.currency,
      isDemo: false,
      mode: r.mode,
    };
  });
  return NextResponse.json({ bets });
}

function mapOutcome(
  o: string,
): "open" | "won" | "lost" | "void" | "half-won" | "half-lost" {
  if (o === "won") return "won";
  if (o === "lost") return "lost";
  if (o === "void") return "void";
  if (o === "half_won") return "half-won";
  if (o === "half_lost") return "half-lost";
  return "open";
}
