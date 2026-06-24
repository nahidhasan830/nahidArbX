import { NextResponse } from "next/server";
import { listPlacedBets } from "@/lib/db/repositories/bets";
import { BETTING_PROVIDERS } from "@/lib/betting/registry";
import type { BetRow } from "@/lib/db/schema";
import { addDays, format, getDay, getHours, parseISO } from "date-fns";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export interface BreakdownRow {
  key: string;
  label: string;
  bets: number;
  stake: number;
  profit: number;
  roiPct: number;
  avgClvPct: number | null;
  openBets: number;
  openStake: number;
  settledBets: number;
}

export interface PnlPoint {
  date: string;
  actual: number;
  expected: number;
}

export async function GET() {
  const rows = await listPlacedBets(1000);
  const stats = deriveStats(rows, {
    startingBankroll: 10_000,
    includeExpected: false,
  });
  return NextResponse.json(stats);
}

function deriveStats(
  rows: BetRow[],
  options: { startingBankroll?: number; includeExpected?: boolean } = {},
) {
  const startingBankroll = options.startingBankroll ?? 10_000;
  const includeExpected = options.includeExpected ?? false;
  const active = rows.filter((r) => r.outcome !== "cancelled");
  const settled = active.filter(
    (r) => r.outcome !== "pending" && r.outcome !== "cancelled",
  );
  const open = active.filter((r) => r.outcome === "pending");
  const wonLike = settled.filter(
    (r) => r.outcome === "won" || r.outcome === "half_won",
  );

  const totalStake = sum(active.map((r) => Number(r.stake)));
  const settledStake = sum(settled.map((r) => Number(r.stake)));
  const totalProfit = sum(settled.map((r) => Number(r.pnl ?? 0)));
  const openStake = sum(open.map((r) => Number(r.stake)));

  const withClv = active.filter((r) => r.clvPct !== null);
  const avgClv =
    withClv.length > 0
      ? sum(withClv.map((r) => Number(r.clvPct))) / withClv.length
      : null;
  const pctBeatClv =
    withClv.length > 0
      ? (withClv.filter((r) => Number(r.clvPct) > 0).length / withClv.length) *
        100
      : null;

  const bankroll = round2(startingBankroll + totalProfit - openStake);
  const expectedProfit = includeExpected
    ? round2(sum(settled.map(expectedPnl)))
    : 0;

  return {
    totals: {
      bankroll,
      totalStake: round2(totalStake),
      totalProfit: round2(totalProfit),
      roiPct: settledStake > 0 ? round2((totalProfit / settledStake) * 100) : 0,
      betCount: active.length,
      settledCount: settled.length,
      winRatePct:
        settled.length > 0
          ? round2((wonLike.length / settled.length) * 100)
          : 0,
      avgOdds: round2(avg(active.map((r) => Number(r.odds)))),
      avgStake: round2(avg(active.map((r) => Number(r.stake)))),
      avgClvPct: avgClv !== null ? round2(avgClv) : null,
      pctBeatClv: pctBeatClv !== null ? round2(pctBeatClv) : null,
      openBets: open.length,
      openStake: round2(openStake),
      expectedProfit,
      luckDelta: includeExpected ? round2(totalProfit - expectedProfit) : 0,
      maxDrawdown: computeMaxDrawdown(settled),
    },
    pnlSeries: buildPnlSeries(active, includeExpected),
    byBook: groupBy(
      active,
      (r) => r.provider!,
      (r) => BETTING_PROVIDERS[r.provider!]?.providerDisplayName ?? r.provider!,
    ),
    byMarket: groupBy(
      active,
      (r) => r.familyId,
      (r) => r.familyId,
    ),
    bySport: groupBy(
      active,
      (r) => r.competition ?? "—",
      (r) => r.competition ?? "—",
    ),
    byOddsBucket: groupBy(
      active,
      (r) => oddsBucket(Number(r.odds)),
      (r) => oddsBucket(Number(r.odds)),
    ),
    edgeDecay: { books: [], points: [] },
    heatmap: buildHeatmap(active),
    topWins: buildTopBets(settled, "wins"),
    topLosses: buildTopBets(settled, "losses"),
    streaks: buildStreaks(settled),
    kellyAdherence: {
      avgDeviationPct: 0,
      overstakeCount: 0,
      understakeCount: 0,
    },
    currency: "BDT",
  };
}


function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : sum(xs) / xs.length;
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function oddsBucket(o: number): string {
  if (o < 1.5) return "<1.50";
  if (o < 2.0) return "1.50–2.00";
  if (o < 3.0) return "2.00–3.00";
  if (o < 5.0) return "3.00–5.00";
  return "5.00+";
}

function groupBy(
  rows: BetRow[],
  keyFn: (r: BetRow) => string,
  labelFn: (r: BetRow) => string,
): BreakdownRow[] {
  const map = new Map<string, { label: string; rows: BetRow[] }>();
  for (const r of rows) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, { label: labelFn(r), rows: [] });
    map.get(k)!.rows.push(r);
  }
  return [...map.entries()]
    .map(([k, { label, rows }]) => {
      const settled = rows.filter(
        (r) => r.outcome !== "pending" && r.outcome !== "cancelled",
      );
      const stake = sum(settled.map((r) => Number(r.stake)));
      const profit = sum(settled.map((r) => Number(r.pnl ?? 0)));
      const withClv = rows.filter((r) => r.clvPct !== null);
      const avgClv =
        withClv.length > 0
          ? sum(withClv.map((r) => Number(r.clvPct))) / withClv.length
          : null;
      return {
        key: k,
        label,
        bets: rows.length,
        stake: round2(stake),
        profit: round2(profit),
        roiPct: stake > 0 ? round2((profit / stake) * 100) : 0,
        avgClvPct: avgClv !== null ? round2(avgClv) : null,
        openBets: rows.filter((r) => r.outcome === "pending").length,
        openStake: round2(
          sum(
            rows
              .filter((r) => r.outcome === "pending")
              .map((r) => Number(r.stake)),
          ),
        ),
        settledBets: settled.length,
      };
    })
    .sort((a, b) => b.stake - a.stake);
}

function buildPnlSeries(rows: BetRow[], includeExpected: boolean): PnlPoint[] {
  if (rows.length === 0) return [];
  const byDay = new Map<string, { actual: number; expected: number }>();
  for (const r of rows) {
    if (r.outcome === "pending" || r.outcome === "cancelled") continue;
    const timestamp = r.settledAt ?? r.placedAt;
    if (!timestamp) continue;
    const day = format(parseISO(timestamp), "yyyy-MM-dd");
    const current = byDay.get(day) ?? { actual: 0, expected: 0 };
    current.actual += Number(r.pnl ?? 0);
    current.expected += includeExpected ? expectedPnl(r) : 0;
    byDay.set(day, current);
  }
  const days = [...byDay.keys()].sort();
  if (days.length === 0) return [];
  const filled: string[] = [];
  const start = parseISO(days[0]);
  const end = parseISO(days[days.length - 1]);
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    filled.push(format(d, "yyyy-MM-dd"));
  }
  let actual = 0;
  let expected = 0;
  return filled.map((day) => {
    const value = byDay.get(day);
    actual += value?.actual ?? 0;
    expected += value?.expected ?? 0;
    return { date: day, actual: round2(actual), expected: round2(expected) };
  });
}

function expectedPnl(row: BetRow): number {
  const stake = Number(row.stake ?? 0);
  const odds = Number(row.odds ?? row.softOdds);
  const trueProb = Number(row.sharpTrueProb);
  const commissionPct = Number(row.softCommissionPct ?? 0);
  if (
    !Number.isFinite(stake) ||
    !Number.isFinite(odds) ||
    !Number.isFinite(trueProb) ||
    stake <= 0 ||
    odds <= 1 ||
    trueProb <= 0
  ) {
    return 0;
  }
  const adjustedOdds = 1 + (odds - 1) * (1 - commissionPct / 100);
  return round2(stake * (adjustedOdds * trueProb - 1));
}

function computeMaxDrawdown(settled: BetRow[]): number {
  const chrono = [...settled].sort((a, b) =>
    (a.settledAt ?? a.placedAt ?? "").localeCompare(
      b.settledAt ?? b.placedAt ?? "",
    ),
  );
  let peak = 0;
  let cum = 0;
  let maxDd = 0;
  for (const r of chrono) {
    cum += Number(r.pnl ?? 0);
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }
  return round2(maxDd);
}

function buildHeatmap(rows: BetRow[]) {
  const map = new Map<
    string,
    { dow: number; hour: number; bets: number; stake: number }
  >();
  for (const r of rows) {
    const d = new Date(r.placedAt ?? r.firstSeenAt);
    const dow = getDay(d);
    const hour = getHours(d);
    const key = `${dow}-${hour}`;
    if (!map.has(key)) map.set(key, { dow, hour, bets: 0, stake: 0 });
    const cell = map.get(key)!;
    cell.bets += 1;
    cell.stake += Number(r.stake);
  }
  return [...map.values()].map((c) => ({ ...c, stake: round2(c.stake) }));
}

function buildTopBets(settled: BetRow[], kind: "wins" | "losses") {
  return [...settled]
    .filter((r) => r.pnl !== null)
    .sort((a, b) =>
      kind === "wins"
        ? Number(b.pnl ?? 0) - Number(a.pnl ?? 0)
        : Number(a.pnl ?? 0) - Number(b.pnl ?? 0),
    )
    .slice(0, 5)
    .map((r) => ({
      id: r.id,
      placedAt: r.placedAt ?? r.firstSeenAt,
      eventName: `${r.homeTeam} vs ${r.awayTeam}`,
      marketName: r.marketType,
      selectionName: r.atomLabel,
      provider: r.provider!,
      providerDisplayName:
        BETTING_PROVIDERS[r.provider!]?.providerDisplayName ?? r.provider!,
      stake: Number(r.stake),
      odds: Number(r.odds),
      pnl: Number(r.pnl ?? 0),
      roiPct:
        Number(r.stake) > 0
          ? round2((Number(r.pnl ?? 0) / Number(r.stake)) * 100)
          : 0,
    }));
}

function buildStreaks(settled: BetRow[]) {
  const chrono = [...settled].sort((a, b) =>
    (a.placedAt ?? a.firstSeenAt).localeCompare(b.placedAt ?? b.firstSeenAt),
  );
  let longestWin = 0;
  let longestLoss = 0;
  let runLen = 0;
  let runKind: "W" | "L" | null = null;
  for (const r of chrono) {
    const k: "W" | "L" | null =
      r.outcome === "won" || r.outcome === "half_won"
        ? "W"
        : r.outcome === "lost" || r.outcome === "half_lost"
          ? "L"
          : null;
    if (k === null) {
      runKind = null;
      runLen = 0;
      continue;
    }
    if (runKind === k) runLen += 1;
    else {
      runKind = k;
      runLen = 1;
    }
    if (k === "W" && runLen > longestWin) longestWin = runLen;
    if (k === "L" && runLen > longestLoss) longestLoss = runLen;
  }

  const newestFirst = [...settled].sort((a, b) =>
    (b.placedAt ?? b.firstSeenAt).localeCompare(a.placedAt ?? a.firstSeenAt),
  );
  let currentType: "W" | "L" | "none" = "none";
  let currentLen = 0;
  for (const r of newestFirst) {
    const k: "W" | "L" | null =
      r.outcome === "won" || r.outcome === "half_won"
        ? "W"
        : r.outcome === "lost" || r.outcome === "half_lost"
          ? "L"
          : null;
    if (k === null) continue;
    if (currentType === "none") {
      currentType = k;
      currentLen = 1;
    } else if (k === currentType) {
      currentLen += 1;
    } else break;
  }

  return { currentType, currentLen, longestWin, longestLoss };
}
