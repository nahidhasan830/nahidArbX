import { Client, StompSubscription } from "@stomp/stompjs";
import WebSocket from "ws";
import { logger } from "../../shared/logger";
import { parsePinnacleWsMessage } from "./ws-parser";
import { setOddsBatch } from "../../atoms/store";
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
      onConnect: (frame) => {
        logger.info("PinnacleWs", "Connected to STOMP server");
        this.isConnected = true;
        this.resubscribeAll();
      },
      onStompError: (frame) => {
        logger.error("PinnacleWs", `Broker reported error: ${frame.headers["message"]}`);
        logger.error("PinnacleWs", `Additional details: ${frame.body}`);
      },
      onWebSocketError: (event) => {
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
        "accept-version": "1.2,1.1,1.0"
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
    if (this.activeSubscriptions.has(providerEventId)) return;

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
      const body = message.body;
      const entries = parsePinnacleWsMessage(
        dest,
        body,
        ctx.providerEventId,
        ctx.normalizedEventId
      );

      if (entries.length > 0) {
        // Feed directly into atoms store!
        setOddsBatch(entries);
        logger.info("PinnacleWs", `Processed ${entries.length} live odds updates for ${ctx.providerEventId}`);
      }
    });
    
    logger.info("PinnacleWs", `Subscribed to ${dest}`);
  }

  private resubscribeAll() {
    for (const [_, ctx] of this.activeSubscriptions) {
      this.doSubscribe(ctx);
    }
  }

  /** Get connection status for the UI engine status bar. */
  public getConnectionStatus(): {
    connected: boolean;
    subscribedEvents: number;
  } {
    return {
      connected: this.isConnected,
      subscribedEvents: this.activeSubscriptions.size,
    };
  }

  public deactivate() {
    this.client.deactivate();
  }
}

export const pinnacleWsClient = singleton(
  "pinnacle:ws-client",
  () => new PinnacleWsClient(),
);
