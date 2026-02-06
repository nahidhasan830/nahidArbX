import { getEnabledAdapters } from "../adapters";
import { setEvents, setProviderStatus } from "../store";
import { matchEvents } from "../matching";
import { config } from "../config";
import type { NormalizedEvent } from "../types";

let isRunning = false;
let intervalId: ReturnType<typeof setInterval> | null = null;

async function fetchAll(): Promise<void> {
  const adapters = getEnabledAdapters();

  if (adapters.length === 0) {
    console.log("[Fetcher] No adapters enabled");
    return;
  }

  const allEvents: NormalizedEvent[] = [];

  // Fetch from all providers in parallel
  const results = await Promise.allSettled(
    adapters.map(async (adapter) => {
      try {
        console.log(`[Fetcher] Fetching events from ${adapter.name}...`);
        const events = await adapter.fetchEvents();
        console.log(`[Fetcher] ${adapter.name}: fetched ${events.length} events`);

        setProviderStatus(adapter.name, {
          status: "ok",
          lastFetch: new Date(),
        });

        return { provider: adapter.name, events };
      } catch (error) {
        console.error(`[Fetcher] ${adapter.name} error:`, error);
        setProviderStatus(adapter.name, {
          status: "error",
          lastFetch: new Date(),
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return { provider: adapter.name, events: [] };
      }
    })
  );

  // Collect all events
  for (const result of results) {
    if (result.status === "fulfilled") {
      allEvents.push(...result.value.events);
    }
  }

  console.log(`[Fetcher] Total raw events: ${allEvents.length}`);

  // Match events across providers
  const matchedEvents = matchEvents(allEvents);

  // Count events with multiple providers
  const multiProviderCount = matchedEvents.filter(
    (e) => Object.keys(e.providers).length > 1
  ).length;

  console.log(
    `[Fetcher] After matching: ${matchedEvents.length} events (${multiProviderCount} matched across providers)`
  );

  // Store matched events with raw count for stats
  setEvents(matchedEvents, allEvents.length);
}

export function startFetcher(): void {
  if (isRunning) {
    console.log("[Fetcher] Already running");
    return;
  }

  isRunning = true;
  console.log(`[Fetcher] Starting with ${config.fetchInterval}ms interval`);

  // Initial fetch
  fetchAll();

  // Schedule recurring fetches
  intervalId = setInterval(fetchAll, config.fetchInterval);
}

export function stopFetcher(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  isRunning = false;
  console.log("[Fetcher] Stopped");
}

export function isFetcherRunning(): boolean {
  return isRunning;
}

export async function manualFetch(): Promise<number> {
  console.log("[Fetcher] Manual fetch triggered");
  await fetchAll();
  const { getEvents } = await import("../store");
  return getEvents().length;
}
