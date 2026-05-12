import { pinnacleWsClient } from "../adapters/pinnacle/ws-client";
import {
  getPinnacleToken,
  isTokenValid,
  refreshTokenIfNeeded,
} from "../auth/token-manager";
import { logger } from "../shared/logger";
import { getMatchedEvents } from "../store";
import { isProviderRuntimeEnabled } from "../providers/runtime-state";
import { singleton } from "@/lib/util/singleton";
import { syncBus } from "../events/event-bus";

export class PinnacleSyncService {
  private isRunning = false;
  private intervalId?: NodeJS.Timeout;
  private tokenCheckIntervalId?: NodeJS.Timeout;
  private busUnsubscribe?: () => void;

  public async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info("PinnacleSync", "Starting real-time WebSocket sync service");

    // 1. Initial token load
    await this.ensureValidToken();

    // 2. Start monitoring token expiry
    this.tokenCheckIntervalId = setInterval(() => {
      this.ensureValidToken();
    }, 60 * 1000); // Check every minute

    // 3. Start syncing tracked entities
    this.syncTrackedEntities();
    this.intervalId = setInterval(() => {
      this.syncTrackedEntities();
    }, 60 * 1000); // Re-sync entity list every minute

    // 4. React immediately when fixtures finish matching (eliminates 60s boot lag)
    this.busUnsubscribe = syncBus.subscribe((event) => {
      if (event.type === "fixtures:complete") {
        this.syncTrackedEntities();
      }
    });
  }

  public stop() {
    this.isRunning = false;
    if (this.intervalId) clearInterval(this.intervalId);
    if (this.tokenCheckIntervalId) clearInterval(this.tokenCheckIntervalId);
    if (this.busUnsubscribe) {
      this.busUnsubscribe();
      this.busUnsubscribe = undefined;
    }
    pinnacleWsClient.deactivate();
    logger.info("PinnacleSync", "Stopped real-time WebSocket sync service");
  }

  private async ensureValidToken() {
    try {
      if (!isTokenValid()) {
        logger.info(
          "PinnacleSync",
          "Token invalid or expiring soon. Attempting refresh...",
        );
        await refreshTokenIfNeeded();
      }

      const token = await getPinnacleToken(false, true);
      if (token) {
        pinnacleWsClient.setToken(token);
      } else {
        logger.warn(
          "PinnacleSync",
          "Could not obtain valid Pinnacle token for WS connection",
        );
      }
    } catch (err) {
      logger.error("PinnacleSync", `Error in ensureValidToken: ${err}`);
    }
  }

  private syncTrackedEntities() {
    if (!isProviderRuntimeEnabled("pinnacle")) {
      pinnacleWsClient.deactivate();
      return;
    }

    const tracked = getMatchedEvents();
    if (!tracked || tracked.length === 0) return;

    // Build set of currently active Pinnacle event IDs
    const activeProviderIds = new Set<string>();

    for (const entity of tracked) {
      const providerMapping = entity.providers["pinnacle"];
      if (providerMapping) {
        activeProviderIds.add(providerMapping.eventId);
        // Subscribe (idempotent — skips if already subscribed)
        pinnacleWsClient.subscribe(providerMapping.eventId, entity.id);
      }
    }

    // Unsubscribe from events no longer in the active roster
    const staleIds = pinnacleWsClient
      .getSubscribedIds()
      .filter((id) => !activeProviderIds.has(id));

    for (const id of staleIds) {
      pinnacleWsClient.unsubscribe(id);
      logger.debug("PinnacleSync", `Unsubscribed stale event ${id}`);
    }

    if (staleIds.length > 0) {
      logger.info(
        "PinnacleSync",
        `Subscription cleanup: removed ${staleIds.length}, active: ${activeProviderIds.size}`,
      );
    }
  }
}

export const pinnacleSyncService = singleton(
  "pinnacle:sync-service",
  () => new PinnacleSyncService(),
);
