import { pinnacleWsClient } from "../adapters/pinnacle/ws-client";
import { getPinnacleToken, isTokenValid } from "../auth/token-manager";
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

    await this.ensureValidToken();

    this.tokenCheckIntervalId = setInterval(() => {
      this.ensureValidToken();
    }, 60 * 1000);

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
      let token = await getPinnacleToken(false, true);
      if (!token || !isTokenValid()) {
        logger.info(
          "PinnacleSync",
          "No valid stored token available. Capturing fresh token...",
        );
        token = await getPinnacleToken(true);
      }

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

    const activeProviderIds = new Set<string>();

    for (const entity of tracked) {
      const providerMapping = entity.providers["pinnacle"];
      if (providerMapping) {
        activeProviderIds.add(providerMapping.eventId);
        pinnacleWsClient.subscribe(providerMapping.eventId, entity.id);
      }
    }

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
