/**
 * BetConstruct Score Poller
 *
 * Polls BetConstruct API for live score updates.
 * Uses the existing BC WebSocket connection via fetchGameMarkets.
 *
 * Polling strategy:
 * - Poll every 10 seconds for active events
 * - Only poll live events (type=1)
 * - Batch requests where possible
 */

import { fetchGameMarkets } from "../adapters/betconstruct/client";
import { setSourceScore, getNormalizedId } from "./multi-source-store";
import { bcStateToPeriod, type SourceScore } from "./types";
import { singleton } from "../util/singleton";

// ============================================
// Configuration
// ============================================

const POLL_INTERVAL_MS = 10_000; // 10 seconds

// ============================================
// State
// ============================================

// Pinned to globalThis so status reads from route handlers (health check,
// /api/value-bets) see the same state as the scheduler that started the
// poller from instrumentation.ts. Otherwise isBCPollingActive() returns
// stale `false` in the route's module graph.
const s = singleton("scores:bc-poller", () => ({
  timer: null as NodeJS.Timeout | null,
  activeEventIds: new Set<string>(),
}));

// ============================================
// Public API
// ============================================

/**
 * Start polling BC for score updates
 */
export function startBCScorePolling(bcEventIds: string[]): void {
  s.activeEventIds = new Set(bcEventIds);

  if (s.activeEventIds.size === 0) {
    stopBCScorePolling();
    return;
  }

  // Start polling if not already running
  if (!s.timer) {
    s.timer = setInterval(pollAllEvents, POLL_INTERVAL_MS);

    // Initial poll
    pollAllEvents();
  }
}

/**
 * Stop polling
 */
export function stopBCScorePolling(): void {
  if (s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
  s.activeEventIds.clear();
}

/**
 * Add events to poll list
 */
export function addBCEventsToPolling(bcEventIds: string[]): void {
  for (const id of bcEventIds) {
    s.activeEventIds.add(id);
  }

  // Start polling if needed
  if (s.activeEventIds.size > 0 && !s.timer) {
    startBCScorePolling(Array.from(s.activeEventIds));
  }
}

/**
 * Remove events from poll list
 */
export function removeBCEventsFromPolling(bcEventIds: string[]): void {
  for (const id of bcEventIds) {
    s.activeEventIds.delete(id);
  }

  if (s.activeEventIds.size === 0) {
    stopBCScorePolling();
  }
}

/**
 * Check if polling is active
 */
export function isBCPollingActive(): boolean {
  return s.timer !== null;
}

/**
 * Get count of events being polled
 */
export function getBCPollingCount(): number {
  return s.activeEventIds.size;
}

// ============================================
// Internal Polling Logic
// ============================================

/**
 * Poll all active events
 */
async function pollAllEvents(): Promise<void> {
  const eventIds = Array.from(s.activeEventIds);
  if (eventIds.length === 0) return;

  // Poll in parallel with concurrency limit
  const CONCURRENCY = 5;
  const results: Promise<void>[] = [];

  for (let i = 0; i < eventIds.length; i += CONCURRENCY) {
    const batch = eventIds.slice(i, i + CONCURRENCY);
    results.push(Promise.all(batch.map(pollSingleEvent)).then(() => undefined));
  }

  await Promise.all(results);
}

/**
 * Poll a single event
 */
async function pollSingleEvent(bcEventId: string): Promise<void> {
  try {
    const game = await fetchGameMarkets(parseInt(bcEventId, 10));

    if (!game) {
      // Event may have ended
      return;
    }

    // Only process live events with score info
    if (game.type !== 1 || !game.info) {
      return;
    }

    // Get normalized event ID
    const normalizedId = getNormalizedId("betconstruct", bcEventId);
    if (!normalizedId) {
      // No mapping registered yet
      return;
    }

    // Parse score from BC info
    const score: SourceScore = {
      source: "betconstruct",
      homeScore: parseInt(game.info.score1 || "0", 10),
      awayScore: parseInt(game.info.score2 || "0", 10),
      minute: parseInt(game.info.current_game_time || "0", 10),
      period: bcStateToPeriod(game.info.current_game_state),
      updatedAt: Date.now(),
    };

    // Store in multi-source store
    setSourceScore(normalizedId, score);
  } catch {
    // Silently ignore individual event errors
    // Connection issues will be logged by the BC client
  }
}

/**
 * Poll specific events on demand (for manual refresh)
 */
export async function pollBCScoresNow(bcEventIds: string[]): Promise<number> {
  let updated = 0;

  for (const bcEventId of bcEventIds) {
    try {
      await pollSingleEvent(bcEventId);
      updated++;
    } catch {
      // Ignore individual errors
    }
  }

  return updated;
}
