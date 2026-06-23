
import { NextResponse } from "next/server";
import { engineGet, enginePost } from "@/lib/engine-proxy";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const queryString = url.search;
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
        providerAlerts: [],
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
