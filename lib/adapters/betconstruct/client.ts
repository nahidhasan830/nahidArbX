import WebSocket from "ws";
import { logger } from "../../shared/logger";

const log = logger.withContext("BetConstruct");

const WS_URL = "wss://eu-swarm-newm.betconstruct.com/";
const ORIGIN = "https://bc.cc2ps.cc";
const SITE_ID = "1848";

let ws: WebSocket | null = null;
let sessionId: string | null = null;
let isConnecting = false;
let requestIdCounter = 0;

let consecutiveTimeouts = 0;
let keepAliveInterval: NodeJS.Timeout | null = null;
let reconnectTimeout: NodeJS.Timeout | null = null;
let isReconnecting = false;

const MAX_CONSECUTIVE_TIMEOUTS = 5;
const KEEP_ALIVE_INTERVAL = 30000;
const RECONNECT_DELAY = 2000;
const MAX_RECONNECT_FAILURES = 5;

let consecutiveReconnectFailures = 0;

let onReconnectCallback: (() => void) | null = null;
let onFatalFailureCallback: (() => void) | null = null;

const subscriptionCallbacks = new Map<string, (data: unknown) => void>();
const gameSubscriptions = new Map<number, string>();

const pendingRequests = new Map<
  string,
  {
    resolve: (data: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }
>();

const REQUEST_TIMEOUT = 15000;

const BC_ERROR_CODES: Record<number, { message: string; silent: boolean }> = {
  40: { message: "Game not found (expired or removed)", silent: true },
};

export class BetConstructError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly silent: boolean = false,
  ) {
    super(message);
    this.name = "BetConstructError";
  }
}

export interface BetConstructErrorLike {
  silent?: boolean;
}

interface SwarmSessionResponse {
  data?: {
    sid?: string;
    subid?: string | number;
    data?: {
      sport?: Record<string, BCSport>;
    };
  };
  code?: number;
  rid?: string;
}

async function ensureConnection(): Promise<void> {
  if (ws && ws.readyState === WebSocket.OPEN && sessionId) {
    return;
  }

  if (isConnecting) {
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (sessionId && ws?.readyState === WebSocket.OPEN) {
          clearInterval(check);
          resolve();
        }
      }, 100);
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, 10000);
    });
    return;
  }

  isConnecting = true;

  try {
    await connect();
    await requestSession();
  } finally {
    isConnecting = false;
  }
}

function connect(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws) {
      try {
        ws.removeAllListeners();
      } catch {
      }
      ws.close();
      ws = null;
    }

    sessionId = null;

    ws = new WebSocket(WS_URL, {
      headers: {
        Origin: ORIGIN,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
    });

    const timeout = setTimeout(() => {
      reject(new Error("WebSocket connection timeout"));
      ws?.close();
    }, 10000);

    ws.on("open", () => {
      clearTimeout(timeout);
      resolve();
    });

    ws.on("message", (data) => {
      handleMessage(data.toString());
    });

    ws.on("close", (code, _reason) => {
      sessionId = null;
      stopKeepAlive();

      for (const [rid, pending] of pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("WebSocket disconnected"));
        pendingRequests.delete(rid);
      }

      if (!isReconnecting && code !== 1000) {
        scheduleReconnect();
      }
    });

    ws.on("error", (err) => {
      log.error("WebSocket error", err.message);
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function requestSession(): Promise<void> {
  const response = await sendRequest({
    command: "request_session",
    params: {
      language: "en",
      site_id: SITE_ID,
    },
  });

  const data = response as SwarmSessionResponse;
  if (data?.data?.sid) {
    sessionId = data.data.sid;
    startKeepAlive();
    consecutiveTimeouts = 0;
  } else {
    throw new Error("Failed to get session ID");
  }
}

function startKeepAlive(): void {
  stopKeepAlive();
  keepAliveInterval = setInterval(async () => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !sessionId) {
      return;
    }

    try {
      await sendRequest({
        command: "get",
        params: {
          source: "betting",
          what: { sport: ["alias"] },
          where: { sport: { alias: "Soccer" } },
          subscribe: false,
        },
        sid: sessionId,
      });
      consecutiveTimeouts = 0;
    } catch {
      log.warn("Keep-alive failed, connection may be stale");
      consecutiveTimeouts++;
      checkHealthAndReconnect();
    }
  }, KEEP_ALIVE_INTERVAL);
}

function stopKeepAlive(): void {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

function scheduleReconnect(): void {
  if (reconnectTimeout || isReconnecting) {
    return;
  }

  reconnectTimeout = setTimeout(async () => {
    reconnectTimeout = null;
    await forceReconnect();
  }, RECONNECT_DELAY);
}

function safeCloseWebSocket(): void {
  if (!ws) return;

  try {
    ws.removeAllListeners();
    if (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    ) {
      ws.close();
    }
  } catch (err) {
    log.warn(
      "Error closing WebSocket (ignoring)",
      err instanceof Error ? err.message : err,
    );
  } finally {
    ws = null;
  }
}

async function forceReconnect(): Promise<void> {
  if (isReconnecting) {
    return;
  }

  isReconnecting = true;

  try {
    stopKeepAlive();
    safeCloseWebSocket();
    sessionId = null;
    isConnecting = false;

    await connect();
    await requestSession();
    consecutiveTimeouts = 0;
    consecutiveReconnectFailures = 0;

    if (onReconnectCallback) {
      try {
        onReconnectCallback();
      } catch (err) {
        log.error("Reconnect callback error", err);
      }
    }
  } catch (err) {
    log.error("Reconnect failed", err instanceof Error ? err.message : err);
    consecutiveReconnectFailures++;

    if (consecutiveReconnectFailures >= MAX_RECONNECT_FAILURES) {
      log.error(
        `FATAL: ${consecutiveReconnectFailures} consecutive reconnect failures - triggering server restart`,
      );
      if (onFatalFailureCallback) {
        onFatalFailureCallback();
      }
      return;
    }

    scheduleReconnect();
  } finally {
    isReconnecting = false;
  }
}

function checkHealthAndReconnect(): void {
  if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
    log.warn(`${consecutiveTimeouts} consecutive timeouts - forcing reconnect`);
    forceReconnect();
  }
}

function handleMessage(data: string): void {
  try {
    const message = JSON.parse(data);
    const rid = message.rid;

    const pending = pendingRequests.get(rid);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingRequests.delete(rid);

      if (message.code === 0) {
        consecutiveTimeouts = 0;
        pending.resolve(message);
      } else {
        const errorInfo = BC_ERROR_CODES[message.code];
        const errorMessage = errorInfo
          ? `BetConstruct: ${errorInfo.message}`
          : `BetConstruct error: code ${message.code}`;
        const silent = errorInfo?.silent ?? false;

        pending.reject(
          new BetConstructError(message.code, errorMessage, silent),
        );
      }
      return;
    }

    if (message.data && typeof message.data === "object") {
      for (const [subid, delta] of Object.entries(message.data)) {
        const cb = subscriptionCallbacks.get(subid);
        if (cb) {
          try {
            cb(delta);
          } catch (err) {
            log.error(`Subscription callback error for subid ${subid}`, err);
          }
        }
      }
    }
  } catch (err) {
    log.error("Failed to parse message", err);
  }
}

function generateRequestId(): string {
  return `req-${Date.now()}-${requestIdCounter++}`;
}

function sendRequest(message: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error("WebSocket not connected"));
      return;
    }

    const rid = generateRequestId();
    const fullMessage = { ...message, rid };

    const timeout = setTimeout(() => {
      pendingRequests.delete(rid);
      consecutiveTimeouts++;
      if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
        checkHealthAndReconnect();
      }
      reject(new Error(`Request timeout: ${rid}`));
    }, REQUEST_TIMEOUT);

    pendingRequests.set(rid, { resolve, reject, timeout });

    ws.send(JSON.stringify(fullMessage));
  });
}

async function sendSessionRequest(
  message: Record<string, unknown>,
): Promise<unknown> {
  await ensureConnection();

  if (!sessionId) {
    throw new Error("No session ID");
  }

  return sendRequest({ ...message, sid: sessionId });
}

export interface BCGame {
  id: number;
  team1_name: string;
  team2_name: string;
  team1_id?: number;
  team2_id?: number;
  start_ts: number;
  markets_count: number;
  is_blocked: number;
  type: number;
  info?: {
    current_game_state?: string;
    current_game_time?: string;
    score1?: string;
    score2?: string;
    add_minutes?: string;
  };
  stats?: Record<
    string,
    { team1_value: number | null; team2_value: number | null }
  >;
  market?: Record<string, BCMarket>;
}

export interface BCMarket {
  id: number;
  type: string;
  name: string;
  base?: number;
  display_key?: string;
  express_id?: number;
  event?: Record<string, BCEvent>;
}

export interface BCEvent {
  id: number;
  type_1: string;
  price: number;
  name: string;
  base?: number;
  order: number;
}

export interface BCCompetition {
  name: string;
  game: Record<string, BCGame>;
}

export interface BCRegion {
  name: string;
  competition: Record<string, BCCompetition>;
}

export interface BCSport {
  name: string;
  alias?: string;
  region: Record<string, BCRegion>;
}

export async function fetchAllEvents(): Promise<BCGame[]> {
  const response = await sendSessionRequest({
    command: "get",
    params: {
      source: "betting",
      what: {
        sport: [],
        region: [],
        competition: ["name"],
        game: [
          [
            "id",
            "team1_name",
            "team2_name",
            "start_ts",
            "type",
            "is_blocked",
            "info",
            "markets_count",
          ],
        ],
      },
      where: {
        sport: { alias: "Soccer" },
        market: { display_key: "WINNER", display_sub_key: "MATCH" },
      },
      subscribe: false,
    },
  });

  return extractGamesFromResponse(response);
}

export async function fetchGameMarkets(gameId: number): Promise<BCGame | null> {
  const response = await sendSessionRequest({
    command: "get",
    params: {
      source: "betting",
      what: {
        sport: ["name"],
        region: ["name"],
        competition: ["name"],
        game: [
          [
            "id",
            "stats",
            "info",
            "markets_count",
            "type",
            "start_ts",
            "team1_id",
            "team1_name",
            "team2_id",
            "team2_name",
            "is_blocked",
          ],
        ],
        market: [
          "id",
          "group_id",
          "group_name",
          "type",
          "name",
          "base",
          "display_key",
          "express_id",
        ],
        event: ["id", "type_1", "price", "name", "base", "order"],
      },
      where: {
        game: { id: gameId },
        sport: { alias: "Soccer" },
      },
      subscribe: false,
    },
  });

  const games = extractGamesFromResponse(response);
  return games.length > 0 ? games[0] : null;
}

function extractGamesFromResponse(response: unknown): BCGame[] {
  const games: BCGame[] = [];

  const data = (response as SwarmSessionResponse).data?.data;
  if (!data) return games;

  const sports: Record<string, BCSport> = data.sport || {};
  for (const sport of Object.values(sports)) {
    const regions = sport.region || {};
    for (const region of Object.values(regions)) {
      const competitions = region.competition || {};
      for (const competition of Object.values(competitions)) {
        const competitionGames = competition.game || {};
        for (const game of Object.values(competitionGames)) {
          if (!game.team2_name) continue;

          const enrichedGame: BCGame & {
            competitionName?: string;
            regionName?: string;
          } = {
            ...game,
            competitionName: competition.name,
            regionName: region.name,
          };

          games.push(enrichedGame as BCGame);
        }
      }
    }
  }

  return games;
}

export async function subscribeToGame(
  gameId: number,
  onUpdate: (delta: unknown) => void,
): Promise<BCGame | null> {
  if (gameSubscriptions.has(gameId)) return null;

  const response = await sendSessionRequest({
    command: "get",
    params: {
      source: "betting",
      what: {
        sport: ["name"],
        region: ["name"],
        competition: ["name"],
        game: [
          [
            "id",
            "stats",
            "info",
            "markets_count",
            "type",
            "start_ts",
            "team1_id",
            "team1_name",
            "team2_id",
            "team2_name",
            "is_blocked",
          ],
        ],
        market: [
          "id",
          "group_id",
          "group_name",
          "type",
          "name",
          "base",
          "display_key",
          "express_id",
        ],
        event: ["id", "type_1", "price", "name", "base", "order"],
      },
      where: {
        game: { id: gameId },
        sport: { alias: "Soccer" },
      },
      subscribe: true,
    },
  });

  const resp = response as SwarmSessionResponse;
  const subid = resp?.data?.subid;

  if (!subid) {
    log.warn(`subscribeToGame(${gameId}): no subid in response`);
    return null;
  }

  subscriptionCallbacks.set(String(subid), onUpdate);
  gameSubscriptions.set(gameId, String(subid));

  const games = extractGamesFromResponse(response);
  return games.length > 0 ? games[0] : null;
}

export async function unsubscribeFromGame(gameId: number): Promise<void> {
  const subid = gameSubscriptions.get(gameId);
  if (!subid) return;

  subscriptionCallbacks.delete(subid);
  gameSubscriptions.delete(gameId);

  try {
    await sendSessionRequest({
      command: "unsubscribe",
      params: { subid },
    });
  } catch {
  }
}

export function getSubscribedGameIds(): number[] {
  return Array.from(gameSubscriptions.keys());
}

export function disconnect(): void {
  stopKeepAlive();
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  isReconnecting = false;
  consecutiveTimeouts = 0;

  subscriptionCallbacks.clear();
  gameSubscriptions.clear();

  if (ws) {
    ws.removeAllListeners();
    ws.close(1000, "Intentional disconnect");
    ws = null;
  }
  sessionId = null;
  isConnecting = false;

  for (const [rid, pending] of pendingRequests) {
    clearTimeout(pending.timeout);
    pending.reject(new Error("Disconnected"));
    pendingRequests.delete(rid);
  }
}

export function isConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN && sessionId !== null;
}

export function getConnectionHealth(): {
  connected: boolean;
  sessionId: string | null;
  consecutiveTimeouts: number;
  isReconnecting: boolean;
  pendingRequests: number;
} {
  return {
    connected: isConnected(),
    sessionId,
    consecutiveTimeouts,
    isReconnecting,
    pendingRequests: pendingRequests.size,
  };
}

export async function reconnect(): Promise<void> {
  await forceReconnect();
}

export function onReconnect(callback: () => void): void {
  onReconnectCallback = callback;
}

export function onFatalFailure(callback: () => void): void {
  onFatalFailureCallback = callback;
}
