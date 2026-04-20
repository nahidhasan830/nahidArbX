/**
 * Raw Data API Endpoint
 *
 * Fetches raw odds/markets data for a specific event from a provider.
 * Used for debugging - copies raw API response to clipboard.
 *
 * GET /api/value-bets/raw-data/{eventId}?provider=pinnacle&providerEventId=123
 *
 * The providerEventId param is optional - if provided, skips event store lookup
 * (useful when the event might have been removed during a sync).
 */

import { NextRequest, NextResponse } from "next/server";
import { getEvent } from "@/lib/store";
import { PROVIDER_REGISTRY, type ProviderKey } from "@/lib/providers/registry";
import { debugFetchAndStorePinnacleOdds } from "@/lib/atoms/adapters/pinnacle";
import { debugFetchAndStoreNwExchangeOdds } from "@/lib/atoms/adapters/ninewickets-exchange";
import { debugFetchAndStoreNwSportsbookOdds } from "@/lib/atoms/adapters/ninewickets-sportsbook";
import { debugFetchAndStoreBetConstructOdds } from "@/lib/atoms/adapters/betconstruct";

// Type for debug fetch functions
type DebugFetchFn = (
  providerEventId: string,
  normalizedEventId: string,
  homeTeam: string,
  awayTeam: string,
) => Promise<{
  rawResponses: Array<{ status: number; data: unknown; durationMs: number }>;
}>;

// Registry of debug fetch functions per provider
const debugFetchers: Record<ProviderKey, DebugFetchFn> = {
  pinnacle: debugFetchAndStorePinnacleOdds,
  "ninewickets-exchange": debugFetchAndStoreNwExchangeOdds,
  "ninewickets-sportsbook": debugFetchAndStoreNwSportsbookOdds,
  betconstruct: debugFetchAndStoreBetConstructOdds,
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const provider = request.nextUrl.searchParams.get(
    "provider",
  ) as ProviderKey | null;
  const providerEventIdParam =
    request.nextUrl.searchParams.get("providerEventId");

  // Validate provider
  if (!provider || !PROVIDER_REGISTRY[provider]) {
    return NextResponse.json(
      {
        error: "Invalid provider",
        validProviders: Object.keys(PROVIDER_REGISTRY),
      },
      { status: 400 },
    );
  }

  // Try to get provider event ID from param first (avoids stale data issues)
  let providerEventId = providerEventIdParam;
  let homeTeam = "Home";
  let awayTeam = "Away";
  let competition = "Unknown";
  let startTime: Date | string = new Date();

  if (!providerEventId) {
    // Fall back to looking up event in store
    const event = getEvent(eventId);
    if (!event) {
      return NextResponse.json(
        { error: "Event not found (try refreshing the page)", eventId },
        { status: 404 },
      );
    }

    // Check if provider has this event
    const providerData = event.providers[provider];
    if (!providerData) {
      return NextResponse.json(
        {
          error: "Provider does not have this event",
          eventId,
          provider,
          availableProviders: Object.keys(event.providers),
        },
        { status: 404 },
      );
    }

    providerEventId = providerData.eventId;
    homeTeam = event.homeTeam;
    awayTeam = event.awayTeam;
    competition = event.competition;
    startTime = event.startTime;
  }

  // Get the debug fetcher for this provider
  const fetcher = debugFetchers[provider];
  if (!fetcher) {
    return NextResponse.json(
      { error: "Debug fetcher not available for provider", provider },
      { status: 500 },
    );
  }

  try {
    // Fetch raw data
    const result = await fetcher(providerEventId, eventId, homeTeam, awayTeam);

    // Return only the raw responses (the actual API response data)
    const rawResponses = result.rawResponses.map((r) => r.data);

    // For multi-step providers like NW Sportsbook (catalog + odds),
    // return only the final odds response, not the catalog
    const primaryResponse =
      rawResponses.length > 1
        ? rawResponses[rawResponses.length - 1]
        : rawResponses[0];

    return NextResponse.json({
      eventId,
      provider,
      providerEventId,
      event: {
        homeTeam,
        awayTeam,
        competition,
        startTime,
      },
      // Return the final/primary response (odds for multi-step, single for others)
      rawResponse: primaryResponse,
      // Include all responses for debugging if needed
      allResponses: rawResponses.length > 1 ? rawResponses : undefined,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(
      `[Raw Data API] Error fetching ${provider} data for ${eventId}:`,
      error,
    );
    return NextResponse.json(
      {
        error: "Failed to fetch raw data",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
