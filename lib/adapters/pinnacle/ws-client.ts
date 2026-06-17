import { Client, StompSubscription } from "@stomp/stompjs";
import WebSocket from "ws";
import { logger } from "../../shared/logger";
import { parsePinnacleWsMessage } from "./ws-parser";
import { applyProviderSnapshot } from "../../atoms/store";
import { singleton } from "@/lib/util/singleton";

Object.assign(global, { WebSocket });

interface SubscriptionContext {
  providerEventId: string;
  normalizedEventId: string;
  stompSub?: StompSubscription;
}

export class PinnacleWsClient {
  private client: Client;
  private token: string | null = null;
  private activeSubscriptions = new Map<string, SubscriptionContext>();
  private isConnected = false;
  /** Timestamp of the last received STOMP message (or connect). Null until first connect. */
  private lastMessageAt: number | null = null;
  private baseUrl = "wss://www.ps388win.com/proteus-websocket/mews";

  constructor() {
    this.client = new Client({
      webSocketFactory: () => new WebSocket(this.baseUrl),
      reconnectDelay: 5000,
      heartbeatIncoming: 20000,
      heartbeatOutgoing: 20000,
      // debug: (str) => {
      //   logger.debug("PinnacleWs", str);
      // },
      onConnect: (_frame) => {
        logger.info("PinnacleWs", "Connected to STOMP server");
        this.isConnected = true;
        this.lastMessageAt = Date.now();
        this.resubscribeAll();
      },
      onStompError: (frame) => {
        logger.error(
          "PinnacleWs",
          `Broker reported error: ${frame.headers["message"]}`,
        );
        logger.error("PinnacleWs", `Additional details: ${frame.body}`);
      },
      onWebSocketError: (_event) => {
        logger.error("PinnacleWs", "WebSocket Error occurred");
      },
      onWebSocketClose: () => {
        logger.warn("PinnacleWs", "WebSocket Closed. Disconnected.");
        this.isConnected = false;
      },
    });
  }

  public setToken(token: string) {
    if (this.token !== token) {
      this.token = token;
      logger.info("PinnacleWs", "Token updated, reconnecting STOMP client...");

      this.client.connectHeaders = {
        authorization: `Bearer ${this.token}`,
        "accept-version": "1.2,1.1,1.0",
      };

      if (this.client.active) {
        this.client.deactivate().then(() => this.client.activate());
      } else {
        this.client.activate();
      }
    }
  }

  public setBaseUrl(url: string) {
    this.baseUrl = url;
  }

  public subscribe(providerEventId: string, normalizedEventId: string) {
    const existing = this.activeSubscriptions.get(providerEventId);
    if (existing) {
      if (existing.normalizedEventId === normalizedEventId) return;

      const previousNormalizedEventId = existing.normalizedEventId;
      existing.normalizedEventId = normalizedEventId;
      applyProviderSnapshot(previousNormalizedEventId, "pinnacle", []);

      if (existing.stompSub) {
        existing.stompSub.unsubscribe();
        existing.stompSub = undefined;
      }

      if (this.isConnected) {
        this.doSubscribe(existing);
      }

      logger.info(
        "PinnacleWs",
        `Remapped ${providerEventId} from ${previousNormalizedEventId} to ${normalizedEventId}`,
      );
      return;
    }

    const ctx: SubscriptionContext = { providerEventId, normalizedEventId };
    this.activeSubscriptions.set(providerEventId, ctx);

    if (this.isConnected) {
      this.doSubscribe(ctx);
    }
  }

  public unsubscribe(providerEventId: string) {
    const ctx = this.activeSubscriptions.get(providerEventId);
    if (ctx) {
      if (ctx.stompSub) {
        ctx.stompSub.unsubscribe();
      }
      this.activeSubscriptions.delete(providerEventId);
    }
  }

  /** Get all currently subscribed provider event IDs (for lifecycle cleanup). */
  public getSubscribedIds(): string[] {
    return Array.from(this.activeSubscriptions.keys());
  }

  private doSubscribe(ctx: SubscriptionContext) {
    if (!this.isConnected || !this.client.active) return;

    const dest = `/market/decimal/${ctx.providerEventId}/A`;

    ctx.stompSub = this.client.subscribe(dest, (message) => {
      this.lastMessageAt = Date.now();
      const body = message.body;
      const { entries, isSnapshot } = parsePinnacleWsMessage(
        dest,
        body,
        ctx.providerEventId,
        ctx.normalizedEventId,
      );

      if (isSnapshot) {
        // Full snapshot: diff against the store so markets Pinnacle
        // dropped are pruned and unchanged prices don't churn the dirty
        // set. An isSnapshot message with 0 entries clears all Pinnacle
        // odds for the event (drop-detection semantics).
        applyProviderSnapshot(ctx.normalizedEventId, "pinnacle", entries);
        if (entries.length > 0) {
          logger.info(
            "PinnacleWs",
            `Processed ${entries.length} live odds updates for ${ctx.providerEventId}`,
          );
        }
      }
    });

    logger.info("PinnacleWs", `Subscribed to ${dest}`);
  }

  private resubscribeAll() {
    for (const [_, ctx] of this.activeSubscriptions) {
      this.doSubscribe(ctx);
    }
  }

  /** Get connection status for the UI engine status bar and health checks. */
  public getConnectionStatus(): {
    connected: boolean;
    subscribedEvents: number;
    lastMessageAt: number | null;
  } {
    return {
      connected: this.isConnected,
      subscribedEvents: this.activeSubscriptions.size,
      lastMessageAt: this.lastMessageAt,
    };
  }

  /**
   * Force a full STOMP reconnect (healing action for silent/zombie
   * sockets). Re-subscription happens automatically via onConnect →
   * resubscribeAll.
   */
  public async forceReconnect(): Promise<void> {
    logger.warn("PinnacleWs", "Force-reconnecting STOMP client (healing)");
    await this.client.deactivate();
    this.client.activate();
  }

  public deactivate() {
    this.client.deactivate();
  }
}

export const pinnacleWsClient = singleton(
  "pinnacle:ws-client",
  () => new PinnacleWsClient(),
);
