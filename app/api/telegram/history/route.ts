/**
 * GET /api/telegram/history — recent incoming-command log + summary stats.
 */

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
  return NextResponse.json({
    entries: getCommandHistory(n),
    stats: getCommandHistoryStats(),
    counts: getCommandCounts(),
  });
}
