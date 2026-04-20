import { NextResponse } from "next/server";
import { getEvents } from "@/lib/store";
import { isOddsSyncInProgress } from "@/lib/background/fetcher";
import { fetchOddsForSingleEvent } from "@/lib/atoms/fetcher";
import { invalidateResponseCache } from "@/lib/cache/response-cache";
import {
  subscribeToScore,
  getDisplayScore,
  type DisplayScore,
} from "@/lib/scores";
import { withTimeout } from "@/lib/shared/timeout";
import type { NormalizedEvent } from "@/lib/types";

/**
 * POST /api/value-bets/refresh-event
 * Refreshes odds for a single event from all providers
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { eventId, providers } = body as {
      eventId: string;
      providers?: Record<string, string>; // provider -> providerEventId
    };

    if (!eventId || typeof eventId !== "string") {
      return NextResponse.json(
        { ok: false, error: "eventId is required" },
        { status: 400 },
      );
    }

    // Skip refresh if background sync is in progress (avoids API contention)
    if (isOddsSyncInProgress()) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        message: "Sync in progress - data refreshing automatically",
        eventId,
      });
    }

    // Try store first, use frontend data as fallback (avoids race condition during sync)
    let event = getEvents().find((e) => e.id === eventId);

    if (!event && providers) {
      // Build minimal event from frontend data for refresh
      event = {
        id: eventId,
        homeTeam: "Unknown",
        awayTeam: "Unknown",
        competition: "Unknown",
        startTime: new Date(),
        providers: Object.fromEntries(
          Object.entries(providers).map(([k, v]) => [
            k,
            { eventId: v, fetchedAt: new Date() },
          ]),
        ),
      } as NormalizedEvent;
    }

    if (!event) {
      return NextResponse.json(
        { ok: false, error: "Event not found" },
        { status: 404 },
      );
    }

    // Fetch fresh odds from all providers with 15s timeout
    // (Prevents hanging if Pinnacle token capture is slow)
    const result = await withTimeout(
      fetchOddsForSingleEvent(event),
      15000,
      "Refresh timed out - some providers may be slow",
    );

    // Invalidate response cache so next GET reflects changes
    invalidateResponseCache();

    // Subscribe to live score updates if event has Pinnacle data
    const pinnacleEventId = event.providers.pinnacle?.eventId;
    let liveScore: DisplayScore | undefined;
    if (pinnacleEventId) {
      // Ensure we're subscribed to this event's score updates
      subscribeToScore(pinnacleEventId);
      // Get current score (may be undefined if no score data yet)
      liveScore = getDisplayScore(pinnacleEventId);
    }

    return NextResponse.json({
      ok: true,
      eventId,
      oddsCount: result.totalOdds,
      byProvider: result.byProvider,
      liveScore,
      refreshedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[API] refresh-event error:", err);
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
