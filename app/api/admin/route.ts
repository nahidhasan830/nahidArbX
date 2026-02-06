import { NextResponse } from "next/server";
import {
  getEvents,
  getAllProviderStatus,
  getLastUpdate,
  getMatchingStats,
} from "@/lib/store";
import { startFetcher, isFetcherRunning, manualFetch } from "@/lib/background/fetcher";

// Start background fetcher (runs every 10s)
if (!isFetcherRunning()) {
  startFetcher();
}

export async function GET() {
  // Return cached data instantly
  const events = getEvents();
  const providerStatus = getAllProviderStatus();
  const lastUpdate = getLastUpdate();
  const stats = getMatchingStats();

  const providerCounts = {
    pslive: events.filter((e) => e.providers.pslive).length,
    ninewickets: events.filter((e) => e.providers.ninewickets).length,
  };

  return NextResponse.json({
    events,
    count: events.length,
    providerStatus,
    providerCounts,
    lastUpdate: lastUpdate?.toISOString() || null,
    stats,
  });
}

export async function POST() {
  try {
    const count = await manualFetch();
    const providerStatus = getAllProviderStatus();

    return NextResponse.json({
      success: true,
      count,
      providerStatus,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
