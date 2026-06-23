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
  type BetConstructErrorLike,
} from "../adapters/betconstruct/client";
import type { RawOddsAtomsProviderAdapter } from "../adapters/unified-registry";

export class BetConstructSyncService {
  private isRunning = false;
  private intervalId?: NodeJS.Timeout;
  private busUnsubscribe?: () => void;

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
    }, 60 * 1000);

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

    for (const [, { gameId }] of this.trackedEvents) {
      unsubscribeFromGame(gameId).catch(() => {});
    }
    this.trackedEvents.clear();
    logger.info("BCSyncService", "Stopped subscription sync service");
  }

  public getActiveSubscriptionCount(): number {
    return this.trackedEvents.size;
  }

  public resubscribeAll(): void {
    this.trackedEvents.clear();
    this.syncTrackedEntities();
    logger.info("BCSyncService", "Re-subscribing all events after reconnect");
  }

  private syncTrackedEntities() {
    if (!isProviderRuntimeEnabled("betconstruct")) {
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

    const baseAdapter = adapter as RawOddsAtomsProviderAdapter;
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

    const initialGame = await subscribeToGame(gameId, async () => {
      try {
        const game = await fetchGameMarkets(gameId);
        if (game) processGame(game);
      } catch (err) {
        if ((err as BetConstructErrorLike)?.silent) {
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

    if (initialGame) {
      processGame(initialGame);
    }
  }
}

export const betconstructSyncService = singleton(
  "betconstruct:sync-service",
  () => new BetConstructSyncService(),
);
