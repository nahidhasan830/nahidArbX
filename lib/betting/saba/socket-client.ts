import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type WebSocket as PlaywrightWebSocket,
} from "playwright";
import { captureSession } from "./session";
import { parseSabaSocketMessage, type SabaOddsSnapshot } from "./socket-parser";
import { logger } from "../../shared/logger";
import { singleton } from "@/lib/util/singleton";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const CONNECT_TIMEOUT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 12_000;

const SOCKET_BRIDGE_SCRIPT = `
(() => {
  const target = window;
  if (target.__sabaWebSocketPatched) return;
  target.__sabaWebSocketPatched = true;
  target.__sabaOddsSockets = [];

  const NativeWebSocket = window.WebSocket;

  const isOddsSocket = (url) => {
    return String(url).includes("/socket.io/") && !String(url).includes("analysiscloud");
  };

  const rememberSocket = (socket, url) => {
    if (!isOddsSocket(url)) return;
    target.__sabaOddsSockets.push(socket);
    socket.addEventListener("close", () => {
      target.__sabaOddsSockets = target.__sabaOddsSockets.filter(
        (candidate) => candidate !== socket,
      );
    });
  };

  function WrappedWebSocket(url, protocols) {
    const socket =
      protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols);
    rememberSocket(socket, url);
    return socket;
  }

  try {
    Object.setPrototypeOf(WrappedWebSocket, NativeWebSocket);
    WrappedWebSocket.prototype = NativeWebSocket.prototype;

    Object.defineProperty(window, "WebSocket", {
      get: () => WrappedWebSocket,
      set: () => {},
      configurable: true,
    });

    Object.defineProperty(target, "__sabaSendSocketPayload", {
      value: (payload) => {
        const sockets = target.__sabaOddsSockets || [];
        const socket = sockets.find(
          (candidate) =>
            candidate.readyState === NativeWebSocket.OPEN &&
            isOddsSocket(candidate.url),
        );
        if (!socket) return false;
        socket.send(payload);
        return true;
      },
      configurable: false,
      writable: false,
    });
  } catch (err) {
    target.__sabaWebSocketPatchError =
      err && err.message ? err.message : String(err);
  }
})();
`;

interface PendingSnapshot {
  matchId: string;
  baseChannelId: string;
  detailChannelId: string;
  resolve: (snapshot: SabaOddsSnapshot) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

function isSabaOddsSocket(url: string): boolean {
  return url.includes("/socket.io/") && !url.includes("analysiscloud");
}

function parseSocketEvent(payload: string): unknown[] | null {
  if (!payload.startsWith("42")) return null;
  try {
    const parsed = JSON.parse(payload.slice(2));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isEmptySnapshot(snapshot: SabaOddsSnapshot): boolean {
  return (
    snapshot.rows.length === 1 &&
    String(snapshot.rows[0]?.type ?? "").toLowerCase() === "empty"
  );
}

async function installSocketBridge(context: BrowserContext): Promise<void> {
  await context.addInitScript({ content: SOCKET_BRIDGE_SCRIPT });
}

function pendingValues(
  pending: Map<string, PendingSnapshot>,
): PendingSnapshot[] {
  return Array.from(new Set(pending.values()));
}

export class SabaSocketClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private connectPromise: Promise<void> | null = null;
  private readyResolver: (() => void) | null = null;
  private readyRejecter: ((error: Error) => void) | null = null;
  private requestSeq = 0;
  private channelSeq = 5000;
  private socketReady = false;
  private pending = new Map<string, PendingSnapshot>();
  private pages = new Set<Page>();
  private socketPage: Page | null = null;
  private attachedPages = new WeakSet<Page>();
  private attachedSockets = new WeakSet<PlaywrightWebSocket>();

  async requestFullMatchOdds(matchId: string): Promise<SabaOddsSnapshot> {
    await this.ensureConnected();

    const baseChannelId = this.nextChannelId();
    const detailChannelId = this.nextChannelId();

    const snapshot = new Promise<SabaOddsSnapshot>((resolve, reject) => {
      const timer = setTimeout(() => {
        const timedOut = this.pending.get(detailChannelId);
        if (!timedOut) return;
        this.removePending(timedOut);
        void this.unsubscribe([baseChannelId, detailChannelId]);
        timedOut.reject(
          new Error(`SABA odds snapshot timed out for match ${matchId}`),
        );
      }, REQUEST_TIMEOUT_MS);

      const pending = {
        matchId,
        baseChannelId,
        detailChannelId,
        resolve,
        reject,
        timer,
      };
      this.pending.set(baseChannelId, pending);
      this.pending.set(detailChannelId, pending);
    });
    void snapshot.catch(() => {});

    try {
      await this.sendSocketEvent("subscribe", [
        [
          "odds",
          [
            {
              id: baseChannelId,
              rev: "",
              sorting: 0,
              condition: {
                no_stream: true,
                matchid: matchId,
              },
            },
          ],
        ],
      ]);

      if (!this.pending.has(detailChannelId)) return snapshot;

      await this.sendSocketEvent("subscribe", [
        [
          "odds",
          [
            {
              id: detailChannelId,
              rev: "",
              sorting: "n",
              condition: {
                marketid: "D",
                no_stream: true,
                timestamp: 0,
                more: 1,
                matchid: Number(matchId),
              },
            },
          ],
        ],
      ]);
    } catch (err) {
      const pending = this.pending.get(detailChannelId);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        this.removePending(pending);
        void this.unsubscribe([baseChannelId, detailChannelId]);
        const error = err instanceof Error ? err : new Error(String(err));
        pending.reject(error);
        throw error;
      }
      return snapshot;
    }

    return snapshot;
  }

  getConnectionStatus(): { connected: boolean; pendingRequests: number } {
    return {
      connected: this.socketReady,
      pendingRequests: this.pending.size,
    };
  }

  deactivate(): void {
    this.socketReady = false;
    for (const pending of pendingValues(this.pending)) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error("SABA socket client stopped"));
    }
    this.pending.clear();
    this.readyRejecter?.(new Error("SABA socket client stopped"));
    this.readyResolver = null;
    this.readyRejecter = null;
    void this.browser?.close().catch(() => {});
    this.browser = null;
    this.context = null;
    this.page = null;
    this.pages.clear();
    this.socketPage = null;
    this.connectPromise = null;
  }

  private async ensureConnected(): Promise<void> {
    if (this.socketReady && this.page && !this.page.isClosed()) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.connect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async connect(): Promise<void> {
    this.deactivate();
    const session = await captureSession();

    const browser = await chromium.launch({
      headless: process.env.TOKEN_HEADLESS !== "false",
      args: ["--disable-blink-features=AutomationControlled"],
    });
    this.browser = browser;

    try {
      const context = await browser.newContext({
        userAgent: USER_AGENT,
        viewport: { width: 1440, height: 900 },
      });
      this.context = context;
      await installSocketBridge(context);

      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("SABA browser socket connect timed out"));
        }, CONNECT_TIMEOUT_MS);

        this.readyResolver = () => {
          clearTimeout(timer);
          resolve();
        };
        this.readyRejecter = (error) => {
          clearTimeout(timer);
          reject(error);
        };
      });
      ready.catch(() => {});

      context.on("page", (page) => this.attachPage(page));
      const page = await context.newPage();
      this.page = page;
      this.attachPage(page);

      await page.goto(session.gameUrl, {
        waitUntil: "commit",
        timeout: CONNECT_TIMEOUT_MS,
      });

      await ready;
    } catch (err) {
      this.deactivate();
      throw err;
    }
  }

  private attachPage(page: Page): void {
    if (this.attachedPages.has(page)) return;
    this.attachedPages.add(page);
    this.pages.add(page);

    page.on("websocket", (ws) => this.attachSocket(ws, page));
    page.on("close", () => {
      this.pages.delete(page);
      if (this.socketPage === page) this.socketPage = null;
      if (this.page === page) this.handleClose(new Error("SABA page closed"));
    });
  }

  private attachSocket(ws: PlaywrightWebSocket, page: Page): void {
    if (this.attachedSockets.has(ws) || !isSabaOddsSocket(ws.url())) return;
    this.attachedSockets.add(ws);
    this.socketPage = page;
    this.socketReady = false;

    ws.on("framereceived", (frame) => {
      try {
        this.handleMessage(String(frame.payload));
      } catch (err) {
        logger.warn(
          "SabaSocket",
          `message parse failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    });

    ws.on("close", () => {
      this.handleClose(new Error("SABA browser socket closed"));
    });
  }

  private handleMessage(payload: string): void {
    const event = parseSocketEvent(payload);
    if (event?.[0] === "init") {
      this.socketReady = true;
      this.readyResolver?.();
      this.readyResolver = null;
      this.readyRejecter = null;
      return;
    }

    if (event?.[0] !== "m") return;

    const decoded = parseSabaSocketMessage(payload);
    if (!decoded) return;

    for (const channelId of decoded.channelIds) {
      const pending = this.pending.get(channelId);
      if (!pending) continue;

      const snapshot = {
        channelId,
        matchId: pending.matchId,
        rows: decoded.rows,
        fieldMap: decoded.fieldMap,
        capturedAt: Date.now(),
      };
      if (isEmptySnapshot(snapshot)) continue;

      if (pending.timer) clearTimeout(pending.timer);
      this.removePending(pending);
      void this.unsubscribe([pending.baseChannelId, pending.detailChannelId]);
      pending.resolve(snapshot);
    }
  }

  private handleClose(error: Error): void {
    this.socketReady = false;
    this.readyRejecter?.(error);
    this.readyResolver = null;
    this.readyRejecter = null;

    for (const pending of pendingValues(this.pending)) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private removePending(pending: PendingSnapshot): void {
    this.pending.delete(pending.baseChannelId);
    this.pending.delete(pending.detailChannelId);
  }

  private async unsubscribe(channelIds: string[]): Promise<void> {
    if (channelIds.length === 0 || !this.socketReady) return;
    await this.sendSocketEvent("unsubscribe", channelIds).catch(() => {});
  }

  private async sendSocketEvent(
    event: string,
    payload: unknown,
  ): Promise<void> {
    await this.sendRaw(`42${JSON.stringify([event, payload])}`);
  }

  private async sendRaw(payload: string): Promise<void> {
    const candidatePages = [
      this.socketPage,
      this.page,
      ...(this.context?.pages() ?? []),
      ...this.pages,
    ].filter((candidate): candidate is Page => {
      return candidate !== null && !candidate.isClosed();
    });

    if (candidatePages.length === 0) {
      throw new Error("SABA browser page is not available");
    }

    for (const page of candidatePages) {
      for (const frame of page.frames()) {
        const sent = await frame
          .evaluate((framePayload) => {
            const sender = (
              window as Window & {
                __sabaSendSocketPayload?: (payload: string) => boolean;
              }
            ).__sabaSendSocketPayload;
            return typeof sender === "function" ? sender(framePayload) : false;
          }, payload)
          .catch(() => false);

        if (sent) return;
      }
    }

    throw new Error("SABA browser socket is not ready");
  }

  private nextChannelId(): string {
    this.requestSeq += 1;
    this.channelSeq += 1;
    return `c${this.channelSeq}_${this.requestSeq}`;
  }
}

export const sabaSocketClient = singleton(
  "saba:socket-client",
  () => new SabaSocketClient(),
);
