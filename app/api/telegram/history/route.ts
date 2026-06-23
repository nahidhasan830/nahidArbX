
import { NextResponse } from "next/server";
import {
  getCommandCounts,
  getCommandHistory,
  getCommandHistoryStats,
} from "@/lib/telegram/history";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const n = Math.min(
    200,
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50),
  );
  const [entries, stats, counts] = await Promise.all([
    getCommandHistory(n),
    getCommandHistoryStats(),
    getCommandCounts(),
  ]);

  return NextResponse.json({
    entries,
    stats,
    counts,
  });
}
