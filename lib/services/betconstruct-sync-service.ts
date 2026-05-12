/**
 * BetConstruct Real-Time Subscription Sync Service
 *
 * Aligns BetConstruct with the reactive odds engine architecture:
 * - Pinnacle: STOMP WebSocket subscriptions → setOddsBatch → dirty callback
 * - 9W-SB / Velki-SB: HTTP delta polling → processRawOdds → setOddsBatch
 * - BetConstruct: Swarm WebSocket subscriptions → processRawOdds → setOddsBatch  ← THIS
 *
 * The Swarm API supports real-time subscriptions: when `subscribe: true` is set
 * on a `get` command, the server pushes deltas whenever any market/event/price
 * changes. This gives us true push-based reactive odds, similar to Pinnacle.
 *
 * Architecture:
 * - On start, subscribes to each matched BC event via `subscribeToGame()`
 * - Initial snapshot is immediately fed through processRawOdds → setOddsBatch
 * - Subsequent Swarm push deltas trigger a full re-fetch of the game's markets
 *   (the delta format is nested/partial, so a full snapshot is more reliable)
 * - The ReactiveDetector picks up dirty families within 500ms
 *
 * Lifecycle:
 * - `start()` called from instrumentation.ts during boot
 * - Every 60s, re-evaluates active roster (subscribe new, unsubscribe stale)
 * - `stop()` tears down all subscriptions cleanly
 * - Respects `isProviderRuntimeEnabled("betconstruct")` — no work when disabled
 */

import { logger } from "../shared/logger";
import { getMatchedEvents } from "../store";
import { isProviderRuntimeEnabled } from "../providers/runtime-state";
import { getAtomsAdapter } from "../adapters/unified-registry";
import { singleton } from "@/lib/util/singleton";
import { syncBus } from "../events/event-bus";
import {
  subscribeToGame,
  unsubscribeFromGame,
  fetchGameMarkets,
  type BCGame,
} from "../adapters/betconstruct/client";

export class BetConstructSyncService {
  private isRunning = false;
  private intervalId?: NodeJS.Timeout;
  private busUnsubscribe?: () => void;

  /**
   * Maps normalizedEventId → { gameId, providerEventId } for lifecycle tracking.
   * We track by normalizedEventId (like GeniusSportsSyncService) so we can
   * diff against the active roster from getMatchedEvents().
   */
  private trackedEvents = new Map<
    string,
    { gameId: number; providerEventId: string }
  >();

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info(
      "BCSyncService",
      "Starting real-time WebSocket subscription sync service",
    );

    this.syncTrackedEntities();
    this.intervalId = setInterval(() => {
      this.syncTrackedEntities();
    }, 60 * 1000); // Re-evaluate active fixtures every minute

    // React immediately when fixtures finish matching (eliminates 60s boot lag)
    this.busUnsubscribe = syncBus.subscribe((event) => {
      if (event.type === "fixtures:complete") {
        this.syncTrackedEntities();
      }
    });
  }

  public stop() {
    this.isRunning = false;
    if (this.intervalId) clearInterval(this.intervalId);
    if (this.busUnsubscribe) {
      this.busUnsubscribe();
      this.busUnsubscribe = undefined;
    }

    // Unsubscribe all
    for (const [, { gameId }] of this.trackedEvents) {
      unsubscribeFromGame(gameId).catch(() => {});
    }
    this.trackedEvents.clear();
    logger.info("BCSyncService", "Stopped subscription sync service");
  }

  /** Get count of active subscriptions for the engine status bar. */
  public getActiveSubscriptionCount(): number {
    return this.trackedEvents.size;
  }

  /**
   * Re-subscribe all tracked events after a WebSocket reconnect.
   * Swarm subscriptions are session-bound — when the client reconnects
   * and gets a new session, all previous subscriptions are gone.
   */
  public resubscribeAll(): void {
    // Clear local tracking so syncTrackedEntities treats them all as new
    this.trackedEvents.clear();
    // Re-run subscription logic
    this.syncTrackedEntities();
    logger.info("BCSyncService", "Re-subscribing all events after reconnect");
  }

  private syncTrackedEntities() {
    if (!isProviderRuntimeEnabled("betconstruct")) {
      // Provider disabled — tear down all subscriptions
      if (this.trackedEvents.size > 0) {
        for (const [, { gameId }] of this.trackedEvents) {
          unsubscribeFromGame(gameId).catch(() => {});
        }
        this.trackedEvents.clear();
        logger.info(
          "BCSyncService",
          "Provider disabled — all subscriptions removed",
        );
      }
      return;
    }

    const tracked = getMatchedEvents();
    if (!tracked || tracked.length === 0) return;

    const activeIds = new Set<string>();

    for (const entity of tracked) {
      const providerMapping = entity.providers["betconstruct"];
      if (!providerMapping) continue;

      activeIds.add(entity.id);

      if (!this.trackedEvents.has(entity.id)) {
        const gameId = parseInt(providerMapping.eventId, 10);
        if (isNaN(gameId)) continue;

        this.trackedEvents.set(entity.id, {
          gameId,
          providerEventId: providerMapping.eventId,
        });

        // Subscribe (fire and forget)
        this.subscribeEvent(
          gameId,
          providerMapping.eventId,
          entity.id,
          entity.homeTeam,
          entity.awayTeam,
        ).catch((err) =>
          logger.error(
            "BCSyncService",
            `Subscribe failed for ${entity.id}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    }

    // Unsubscribe from events no longer in the active roster
    for (const [id, { gameId }] of this.trackedEvents.entries()) {
      if (!activeIds.has(id)) {
        unsubscribeFromGame(gameId).catch(() => {});
        this.trackedEvents.delete(id);
      }
    }
  }

  private async subscribeEvent(
    gameId: number,
    providerEventId: string,
    normalizedEventId: string,
    homeTeam: string,
    awayTeam: string,
  ) {
    const adapter = getAtomsAdapter("betconstruct");
    if (!adapter) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const baseAdapter = adapter as any;
    if (typeof baseAdapter.processRawOdds !== "function") return;

    const processGame = (game: BCGame) => {
      baseAdapter.processRawOdds(game, {
        providerEventId,
        normalizedEventId,
        homeTeam,
        awayTeam,
        options: {},
      });
    };

    // Subscribe — initial snapshot + push callback
    const initialGame = await subscribeToGame(gameId, async () => {
      // On each Swarm push delta, re-fetch the full game snapshot.
      // The delta format is partial/nested (e.g. only changed prices),
      // which is complex to merge. A full fetch via the existing WS
      // is cheap (~2ms) and gives us a clean BCGame to extract from.
      try {
        const game = await fetchGameMarkets(gameId);
        if (game) processGame(game);
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((err as any)?.silent) {
          // Game expired — clean up
          this.trackedEvents.delete(normalizedEventId);
          unsubscribeFromGame(gameId).catch(() => {});
          return;
        }
        logger.warn(
          "BCSyncService",
          `Delta re-fetch error for game ${gameId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    // Process initial snapshot
    if (initialGame) {
      processGame(initialGame);
    }
  }
}

export const betconstructSyncService = singleton(
  "betconstruct:sync-service",
  () => new BetConstructSyncService(),
);
