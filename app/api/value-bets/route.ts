/**
 * Value Bets API — Proxy to Engine
 *
 * In web-only mode (NAHIDARBX_ENGINE=1), the in-memory stores
 * (events, value bets, odds, connection health) live in the
 * engine process. This route proxies to the engine HTTP API.
 *
 * GET  → proxies to engine /engine/value-bets (all query params forwarded)
 * POST → proxies to engine /engine/scheduler (action forwarding)
 */

import { NextResponse } from "next/server";
import { engineGet, enginePost } from "@/lib/engine-proxy";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const queryString = url.search; // includes the leading ?
  const enginePath = `/engine/value-bets${queryString}`;

  const data = await engineGet(enginePath);
  if (data === null) {
    return NextResponse.json(
      {
        events: [],
        summary: {
          totalEvents: 0,
          matchedEvents: 0,
          eventsWithValue: 0,
          eventsWithOdds: 0,
          totalValueBets: 0,
          bestEvPct: null,
        },
        providerCounts: {},
        stats: {
          rawTotal: 0,
          matchedCount: 0,
          unmatchedCount: 0,
          storedTotal: 0,
        },
        connectionHealth: null,
        providerStatus: {},
        syncStatus: null,
        _engineError: "Engine unreachable",
      },
      {
        status: 200,
        headers: { "Cache-Control": "private, no-cache" },
      },
    );
  }

  // Forward the engine's ETag if present
  const etag = (data as Record<string, unknown>)._etag as string | undefined;
  const headers: Record<string, string> = {
    "Cache-Control": "private, no-cache",
  };
  if (etag) headers["ETag"] = etag;

  return NextResponse.json(data, { headers });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = await enginePost("/engine/scheduler", body);
    if (result === null) {
      return NextResponse.json(
        { ok: false, error: "Engine unreachable" },
        { status: 503 },
      );
    }
    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request" },
      { status: 400 },
    );
  }
}
