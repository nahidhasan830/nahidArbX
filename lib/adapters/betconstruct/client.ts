/**
 * BetConstruct Swarm WebSocket Client
 *
 * Connects to BetConstruct's Swarm API via WebSocket.
 * Uses simple JSON protocol (not STOMP).
 *
 * Connection flow:
 * 1. Connect to WebSocket
 * 2. Send request_session to get sid
 * 3. Use get command with sid for queries
 */

import WebSocket from "ws";
import { logger } from "../../shared/logger";

const log = logger.withContext("BetConstruct");

// Connection config
const WS_URL = "wss://eu-swarm-newm.betconstruct.com/";
const ORIGIN = "https://bc.cc2ps.cc";
const SITE_ID = "1848";

// Connection state
let ws: WebSocket | null = null;
let sessionId: string | null = null;
let isConnecting = false;
let requestIdCounter = 0;

// Auto-healing state
let consecutiveTimeouts = 0;
let keepAliveInterval: NodeJS.Timeout | null = null;
let reconnectTimeout: NodeJS.Timeout | null = null;
let isReconnecting = false;

// Thresholds for auto-healing
const MAX_CONSECUTIVE_TIMEOUTS = 5; // Force reconnect after 5 consecutive timeouts
const KEEP_ALIVE_INTERVAL = 30000; // Send keep-alive every 30 seconds
const RECONNECT_DELAY = 2000; // Wait 2 seconds before reconnecting
const MAX_RECONNECT_FAILURES = 5; // Trigger server restart after 5 failed reconnects

// Track reconnect failures for server restart
let consecutiveReconnectFailures = 0;

// Callback for reconnection events (to trigger sync)
let onReconnectCallback: (() => void) | null = null;

// Callback for fatal failures (to trigger server restart)
let onFatalFailureCallback: (() => void) | null = null;

// ============================================
// Subscription State
// ============================================

/** subid → callback for routing subscription push updates */
const subscriptionCallbacks = new Map<string, (data: unknown) => void>();

/** gameId → subid for lifecycle management (subscribe/unsubscribe) */
const gameSubscriptions = new Map<number, string>();

// Pending requests waiting for response
const pendingRequests = new Map<
  string,
  {
    resolve: (data: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }
>();

// Request timeout (15 seconds)
const REQUEST_TIMEOUT = 15000;

// BetConstruct error codes
// Based on observed behavior - codes may mean:
// 0: Success
// 40: Game/event not found (expired or removed)
// Other codes: Unknown errors
const BC_ERROR_CODES: Record<number, { message: string; silent: boolean }> = {
  40: { message: "Game not found (expired or removed)", silent: true },
};

/**
 * Custom error class for BetConstruct errors with code information
 */
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

// ============================================
// Connection Management
// ============================================

/**
 * Ensure WebSocket is connected and session is established
 */
async function ensureConnection(): Promise<void> {
  if (ws && ws.readyState === WebSocket.OPEN && sessionId) {
    return;
  }

  if (isConnecting) {
    // Wait for existing connection attempt
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (sessionId && ws?.readyState === WebSocket.OPEN) {
          clearInterval(check);
          resolve();
        }
      }, 100);
      // Timeout after 10 seconds
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

/**
 * Connect to WebSocket
 */
function connect(): Promise<void> {
  return new Promise((resolve, reject) => {
    // MEMORY-LEAK GUARD — DO NOT REMOVE.
    // ws.close() does NOT detach the open/message/close/error listeners
    // attached below; those closures capture `pendingRequests`, the keep-
    // alive timer, and the reconnect callback. Without removeAllListeners()
    // every soft reconnect (e.g. on a 1006 from BetConstruct) leaks the
    // previous socket + closures. `safeCloseWebSocket()` and `disconnect()`
    // already handle this — keep `connect()` consistent.
    if (ws) {
      try {
        ws.removeAllListeners();
      } catch {
        // already detached — ignore
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

      // Reject all pending requests
      for (const [rid, pending] of pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("WebSocket disconnected"));
        pendingRequests.delete(rid);
      }

      // Auto-reconnect after delay (unless intentionally disconnected)
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

/**
 * Request a new session
 */
async function requestSession(): Promise<void> {
  const response = await sendRequest({
    command: "request_session",
    params: {
      language: "en",
      site_id: SITE_ID,
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = response as any;
  if (data?.data?.sid) {
    sessionId = data.data.sid;
    // Start keep-alive after successful session
    startKeepAlive();
    // Reset timeout counter on successful connection
    consecutiveTimeouts = 0;
  } else {
    throw new Error("Failed to get session ID");
  }
}

// ============================================
// Auto-Healing: Keep-Alive & Reconnect
// ============================================

/**
 * Start periodic keep-alive pings to detect dead connections
 */
function startKeepAlive(): void {
  stopKeepAlive();
  keepAliveInterval = setInterval(async () => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !sessionId) {
      return;
    }

    try {
      // Send a lightweight get command as keep-alive
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
      // Successful ping - reset timeout counter
      consecutiveTimeouts = 0;
    } catch {
      log.warn("Keep-alive failed, connection may be stale");
      consecutiveTimeouts++;
      checkHealthAndReconnect();
    }
  }, KEEP_ALIVE_INTERVAL);
}

/**
 * Stop keep-alive pings
 */
function stopKeepAlive(): void {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

/**
 * Schedule a reconnection attempt
 */
function scheduleReconnect(): void {
  if (reconnectTimeout || isReconnecting) {
    return;
  }

  reconnectTimeout = setTimeout(async () => {
    reconnectTimeout = null;
    await forceReconnect();
  }, RECONNECT_DELAY);
}

/**
 * Safely close WebSocket (handles all states)
 */
function safeCloseWebSocket(): void {
  if (!ws) return;

  try {
    ws.removeAllListeners();
    // Only close if in OPEN or CONNECTING state
    if (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    ) {
      ws.close();
    }
  } catch (err) {
    // Ignore close errors - the connection is dead anyway
    log.warn(
      "Error closing WebSocket (ignoring)",
      err instanceof Error ? err.message : err,
    );
  } finally {
    ws = null;
  }
}

/**
 * Force a full reconnection (close existing, create new)
 */
async function forceReconnect(): Promise<void> {
  if (isReconnecting) {
    return;
  }

  isReconnecting = true;

  try {
    // Clean up existing connection safely
    stopKeepAlive();
    safeCloseWebSocket();
    sessionId = null;
    isConnecting = false;

    // Reconnect
    await connect();
    await requestSession();
    consecutiveTimeouts = 0;
    consecutiveReconnectFailures = 0; // Reset on success

    // Notify listeners (e.g., trigger a sync to refresh data)
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

    // Check if we should trigger a fatal failure (server restart)
    if (consecutiveReconnectFailures >= MAX_RECONNECT_FAILURES) {
      log.error(
        `FATAL: ${consecutiveReconnectFailures} consecutive reconnect failures - triggering server restart`,
      );
      if (onFatalFailureCallback) {
        onFatalFailureCallback();
      }
      return; // Don't schedule another reconnect, let the restart happen
    }

    // Schedule another attempt
    scheduleReconnect();
  } finally {
    isReconnecting = false;
  }
}

/**
 * Check connection health and reconnect if needed
 */
function checkHealthAndReconnect(): void {
  if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
    log.warn(`${consecutiveTimeouts} consecutive timeouts - forcing reconnect`);
    forceReconnect();
  }
}

// ============================================
// Message Handling
// ============================================

function handleMessage(data: string): void {
  try {
    const message = JSON.parse(data);
    const rid = message.rid;

    // Check if this is a response to a pending request
    const pending = pendingRequests.get(rid);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingRequests.delete(rid);

      if (message.code === 0) {
        // Successful response - reset timeout counter
        consecutiveTimeouts = 0;
        pending.resolve(message);
      } else {
        // Look up error code info
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

    // Subscription push updates — Swarm sends deltas keyed by subid
    // Format: { code: 0, rid: 0, data: { [subid]: { game: { [gameId]: { ...delta } } } } }
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

// ============================================
// Request Helpers
// ============================================

function generateRequestId(): string {
  return `req-${Date.now()}-${requestIdCounter++}`;
}

/**
 * Send a raw request (without session ID requirement)
 */
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
      // Check if we should reconnect due to too many timeouts
      if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
        checkHealthAndReconnect();
      }
      reject(new Error(`Request timeout: ${rid}`));
    }, REQUEST_TIMEOUT);

    pendingRequests.set(rid, { resolve, reject, timeout });

    ws.send(JSON.stringify(fullMessage));
  });
}

/**
 * Send a request with session ID
 */
async function sendSessionRequest(
  message: Record<string, unknown>,
): Promise<unknown> {
  await ensureConnection();

  if (!sessionId) {
    throw new Error("No session ID");
  }

  return sendRequest({ ...message, sid: sessionId });
}

// ============================================
// Public API
// ============================================

export interface BCGame {
  id: number;
  team1_name: string;
  team2_name: string;
  team1_id?: number;
  team2_id?: number;
  start_ts: number;
  markets_count: number;
  is_blocked: number;
  type: number; // 0=prematch, 1=live, 2=scheduled
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

/**
 * Fetch ALL football events (live, prematch, and scheduled) with 1X2 market.
 *
 * Game types:
 * - type=0: Prematch
 * - type=1: Live/in-play
 * - type=2: Scheduled (upcoming)
 *
 * This optimized query is 40% faster than fetching live/prematch separately:
 * - Uses empty arrays for sport/region (no fields needed)
 * - Removes market/event from 'what' (filter still works)
 * - No game type filter (returns all types)
 */
export async function fetchAllEvents(): Promise<BCGame[]> {
  const response = await sendSessionRequest({
    command: "get",
    params: {
      source: "betting",
      what: {
        sport: [], // Empty - no fields needed
        region: [], // Empty - no fields needed
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
        // NO market/event - not needed for event fetching
      },
      where: {
        sport: { alias: "Soccer" },
        // NO game type filter - returns all types (0, 1, 2)
        market: { display_key: "WINNER", display_sub_key: "MATCH" },
      },
      subscribe: false,
    },
  });

  return extractGamesFromResponse(response);
}

/**
 * Fetch full markets for a specific game
 */
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

/**
 * Extract games from nested API response
 * Response structure: sport > region > competition > game
 */
function extractGamesFromResponse(response: unknown): BCGame[] {
  const games: BCGame[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (response as any)?.data?.data;
  if (!data) return games;

  // Navigate through nested structure
  const sports: Record<string, BCSport> = data.sport || {};
  for (const sport of Object.values(sports)) {
    const regions = sport.region || {};
    for (const region of Object.values(regions)) {
      const competitions = region.competition || {};
      for (const competition of Object.values(competitions)) {
        const competitionGames = competition.game || {};
        for (const game of Object.values(competitionGames)) {
          // Skip outright markets (no team2_name)
          if (!game.team2_name) continue;

          // Attach competition name to game for reference
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

// ============================================
// Subscription Management (Real-Time Odds)
// ============================================

/**
 * Subscribe to a game's markets for real-time push updates.
 *
 * Swarm sends the initial market snapshot in the response, then pushes
 * deltas via the WebSocket whenever any market/event/price changes.
 * Updates arrive in `handleMessage` and are routed to the `onUpdate`
 * callback keyed by the `subid` Swarm assigns.
 *
 * @param gameId - BetConstruct numeric game ID
 * @param onUpdate - Called with delta data on every push update
 * @returns The initial BCGame snapshot (with full markets), or null
 */
export async function subscribeToGame(
  gameId: number,
  onUpdate: (delta: unknown) => void,
): Promise<BCGame | null> {
  // Already subscribed — skip
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resp = response as any;
  const subid = resp?.data?.subid;

  if (!subid) {
    log.warn(`subscribeToGame(${gameId}): no subid in response`);
    return null;
  }

  // Register callback
  subscriptionCallbacks.set(String(subid), onUpdate);
  gameSubscriptions.set(gameId, String(subid));

  // Extract initial game snapshot
  const games = extractGamesFromResponse(response);
  return games.length > 0 ? games[0] : null;
}

/**
 * Unsubscribe from a game's real-time updates.
 */
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
    // Best-effort — connection may already be dead
  }
}

/**
 * Get all currently subscribed game IDs.
 */
export function getSubscribedGameIds(): number[] {
  return Array.from(gameSubscriptions.keys());
}

/**
 * Close the WebSocket connection (intentionally)
 */
export function disconnect(): void {
  // Stop auto-healing
  stopKeepAlive();
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  isReconnecting = false;
  consecutiveTimeouts = 0;

  // Clear all subscriptions
  subscriptionCallbacks.clear();
  gameSubscriptions.clear();

  if (ws) {
    ws.removeAllListeners();
    ws.close(1000, "Intentional disconnect"); // Code 1000 prevents auto-reconnect
    ws = null;
  }
  sessionId = null;
  isConnecting = false;

  // Clear pending requests
  for (const [rid, pending] of pendingRequests) {
    clearTimeout(pending.timeout);
    pending.reject(new Error("Disconnected"));
    pendingRequests.delete(rid);
  }
}

/**
 * Check if connected
 */
export function isConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN && sessionId !== null;
}

/**
 * Get connection health info
 */
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

/**
 * Manually trigger a reconnection (exposed for external health checks)
 */
export async function reconnect(): Promise<void> {
  await forceReconnect();
}

/**
 * Set a callback to be invoked when the connection is restored after a failure.
 * Use this to trigger a sync or cache invalidation after auto-healing.
 */
export function onReconnect(callback: () => void): void {
  onReconnectCallback = callback;
}

/**
 * Set a callback to be invoked when the connection fails catastrophically
 * (after MAX_RECONNECT_FAILURES consecutive reconnect attempts fail).
 * Use this to trigger a server restart.
 */
export function onFatalFailure(callback: () => void): void {
  onFatalFailureCallback = callback;
}
