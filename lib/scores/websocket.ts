/**
 * Pinnacle Live Score WebSocket Client
 *
 * Connects to Pinnacle's WebSocket to receive live score updates.
 * Uses STOMP protocol over WebSocket.
 *
 * Subscribe to: /in-running/{eventId}
 * Returns: LiveScoreMessage with homeScore, awayScore, elapsed, state
 */

import WebSocket from "ws";
import { setLiveScore, setCornersScore, getLiveScore } from "./store";
import { setSourceScore, getNormalizedId } from "./multi-source-store";
import type {
  LiveScore,
  LiveScoreMessage,
  CornersScore,
  SourceScore,
} from "./types";
import { stateToPeriod } from "./types";
import { config } from "../config";
import { singleton } from "../util/singleton";
import { logger } from "../shared/logger";

const log = logger.withContext("Scores WS");

// STOMP frame terminator
const NULL_CHAR = "\x00";

// Pinned to globalThis so route-handler status reads (isScoreWebSocketConnected,
// getConnectionHealth) see the same socket that the scheduler opened from
// instrumentation.ts. Without this, every reader in a separate module graph
// starts with a fresh null socket and reports "disconnected" forever.
const s = singleton("scores:websocket", () => ({
  socket: null as WebSocket | null,
  connected: false,
  reconnectTimer: null as NodeJS.Timeout | null,
  heartbeatTimer: null as NodeJS.Timeout | null,
  subscribed: new Set<string>(),
  subCounter: 0,
  subIds: new Map<string, string>(),
  failures: 0,
  onReconnectCb: null as (() => void) | null,
}));

const WS_URL = `wss://${new URL(config.providers.pinnacle.baseUrl).host}/proteus-websocket/mews`;

// ============================================
// STOMP Frame Helpers
// ============================================

function buildStompFrame(
  command: string,
  headers: Record<string, string>,
  body = "",
): string {
  let frame = command + "\n";
  for (const [key, value] of Object.entries(headers)) {
    frame += `${key}:${value}\n`;
  }
  frame += "\n" + body + NULL_CHAR;
  return frame;
}

function parseStompFrame(
  data: string,
): { command: string; headers: Record<string, string>; body: string } | null {
  // Remove trailing NULL chars
  const cleaned = data.replace(/\x00+$/, "");
  const lines = cleaned.split("\n");

  if (lines.length < 1) return null;

  const command = lines[0];
  const headers: Record<string, string> = {};
  let bodyStartIndex = 1;

  // Parse headers until empty line
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") {
      bodyStartIndex = i + 1;
      break;
    }
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      headers[line.substring(0, colonIndex)] = line.substring(colonIndex + 1);
    }
  }

  const body = lines.slice(bodyStartIndex).join("\n");
  return { command, headers, body };
}

// ============================================
// Message Handlers
// ============================================

function handleMessage(data: string): void {
  // Ignore ping/pong messages (not STOMP frames)
  if (data.startsWith("ping:") || data.startsWith("pong:")) {
    return;
  }

  const frame = parseStompFrame(data);
  if (!frame) return;

  switch (frame.command) {
    case "CONNECTED":
      s.connected = true;
      s.failures = 0; // Reset on successful connection
      // Resubscribe to all events
      for (const eventId of s.subscribed) {
        sendSubscribe(eventId);
      }
      // Notify listeners of successful reconnection
      if (s.onReconnectCb) {
        try {
          s.onReconnectCb();
        } catch (err) {
          log.error("Reconnect callback error", err);
        }
      }
      break;

    case "MESSAGE":
      handleScoreMessage(frame.headers, frame.body);
      break;

    case "ERROR":
      log.error("STOMP error", frame.body);
      break;

    case "RECEIPT":
      // Acknowledgement, can ignore
      break;

    default:
      // Heartbeat or unknown, ignore
      break;
  }
}

function handleScoreMessage(
  headers: Record<string, string>,
  body: string,
): void {
  const destination = headers["destination"] || "";

  // Check if it's an in-running message: /in-running/{eventId}
  if (!destination.startsWith("/in-running/")) return;

  // Extract event ID from destination
  const eventId = destination.replace("/in-running/", "");

  if (!body || body.trim() === "") return;

  // Skip ping/pong messages that might be in the body
  if (body.startsWith("ping:") || body.startsWith("pong:")) return;

  // Body should be valid JSON array
  if (!body.startsWith("[")) return;

  try {
    const messages: LiveScoreMessage[] = JSON.parse(body);

    for (const msg of messages) {
      // Track Regular (goals) scores
      if (msg.resultingUnit === "Regular") {
        const score: LiveScore = {
          eventId: String(msg.eventParentId),
          homeScore: msg.homeScore,
          awayScore: msg.awayScore,
          elapsed: msg.elapsed,
          state: msg.state,
          homeRedCards: msg.homeRedCards,
          awayRedCards: msg.awayRedCards,
          resultingUnit: msg.resultingUnit,
          version: msg.version,
          updatedAt: Date.now(),
        };
        setLiveScore(eventId, score);
        // `setLiveScore` reconciles htHome/htAway using the previous
        // state=1 snapshot when it observes a transition into 2H.
        // Read it back so the multi-source store sees HT too.
        const stored = getLiveScore(eventId);

        // Also update multi-source store
        const normalizedId = getNormalizedId("pinnacle", eventId);
        if (normalizedId) {
          const sourceScore: SourceScore = {
            source: "pinnacle",
            homeScore: msg.homeScore,
            awayScore: msg.awayScore,
            htHome: stored?.htHome,
            htAway: stored?.htAway,
            minute: msg.elapsed,
            period: stateToPeriod(msg.state, msg.elapsed),
            homeRedCards: msg.homeRedCards,
            awayRedCards: msg.awayRedCards,
            updatedAt: Date.now(),
            version: msg.version,
          };
          setSourceScore(normalizedId, sourceScore);
        }
      }

      // Track Corners scores (for corners handicap adjustment)
      if (msg.resultingUnit === "Corners") {
        const cornersScore: CornersScore = {
          eventId: String(msg.eventParentId),
          homeCorners: msg.homeScore, // homeScore field contains corners count
          awayCorners: msg.awayScore, // awayScore field contains corners count
          version: msg.version,
          updatedAt: Date.now(),
        };
        setCornersScore(eventId, cornersScore);
      }
    }
  } catch (err) {
    log.error("Failed to parse score message", err);
  }
}

// ============================================
// STOMP Commands
// ============================================

function sendConnect(): void {
  if (!s.socket || s.socket.readyState !== WebSocket.OPEN) return;

  const frame = buildStompFrame("CONNECT", {
    "accept-version": "1.2,1.1,1.0",
    "heart-beat": "10000,10000",
  });

  s.socket.send(frame);
}

function sendSubscribe(eventId: string): void {
  if (!s.socket || s.socket.readyState !== WebSocket.OPEN || !s.connected)
    return;

  const subId = `sub-${s.subCounter++}`;
  s.subIds.set(eventId, subId);

  const frame = buildStompFrame("SUBSCRIBE", {
    id: subId,
    destination: `/in-running/${eventId}`,
  });

  s.socket.send(frame);
}

function sendUnsubscribe(eventId: string): void {
  if (!s.socket || s.socket.readyState !== WebSocket.OPEN || !s.connected)
    return;

  const subId = s.subIds.get(eventId);
  if (!subId) return;

  const frame = buildStompFrame("UNSUBSCRIBE", { id: subId });
  s.socket.send(frame);
  s.subIds.delete(eventId);
}

function sendHeartbeat(): void {
  if (s.socket && s.socket.readyState === WebSocket.OPEN) {
    s.socket.send("\n"); // STOMP heartbeat
  }
}

// ============================================
// Connection Management
// ============================================

function connect(): void {
  // MEMORY-LEAK GUARD — DO NOT REMOVE.
  // ws.close() does NOT detach event listeners. Without removeAllListeners()
  // the old socket's open/message/close/error closures (which capture `s`,
  // module-level state, and indirectly the score store) stay attached to a
  // closed socket and prevent it from being GC'd. The `reconnect()` helper
  // below already does this correctly — keep `connect()` consistent so
  // every reconnection path frees its predecessor cleanly.
  if (s.socket) {
    try {
      s.socket.removeAllListeners();
      // Re-attach a no-op error handler — removeAllListeners() strips it,
      // and if the socket emits 'error' during close() Node.js crashes
      // with an unhandled error event.
      s.socket.on("error", () => {});
    } catch {
      // already detached — ignore
    }
    try {
      s.socket.close();
    } catch {
      // close can throw if socket is in a bad state
    }
    s.socket = null;
  }

  s.socket = new WebSocket(WS_URL, ["v12.stomp", "v11.stomp", "v10.stomp"], {
    headers: {
      Origin: config.providers.pinnacle.baseUrl,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
  });

  s.socket.on("open", () => {
    sendConnect();
    startHeartbeat();
  });

  s.socket.on("message", (data) => {
    handleMessage(data.toString());
  });

  s.socket.on("close", () => {
    s.connected = false;
    s.failures++;
    stopHeartbeat();
    scheduleReconnect();
  });

  s.socket.on("error", (err) => {
    log.error("Error", err.message);
    s.failures++;
  });
}

function scheduleReconnect(): void {
  if (s.reconnectTimer) return;

  s.reconnectTimer = setTimeout(() => {
    s.reconnectTimer = null;
    if (s.subscribed.size > 0) {
      connect();
    }
  }, 5000); // Reconnect after 5 seconds
}

function startHeartbeat(): void {
  stopHeartbeat();
  s.heartbeatTimer = setInterval(sendHeartbeat, 10000);
}

function stopHeartbeat(): void {
  if (s.heartbeatTimer) {
    clearInterval(s.heartbeatTimer);
    s.heartbeatTimer = null;
  }
}

// ============================================
// Public API
// ============================================

/**
 * Subscribe to live score updates for an event
 */
export function subscribeToScore(pinnacleEventId: string): void {
  if (s.subscribed.has(pinnacleEventId)) return;

  s.subscribed.add(pinnacleEventId);

  // Connect if not already connected
  if (!s.socket || s.socket.readyState !== WebSocket.OPEN) {
    connect();
  } else if (s.connected) {
    sendSubscribe(pinnacleEventId);
  }
}

/**
 * Unsubscribe from live score updates for an event
 */
export function unsubscribeFromScore(pinnacleEventId: string): void {
  if (!s.subscribed.has(pinnacleEventId)) return;

  s.subscribed.delete(pinnacleEventId);
  sendUnsubscribe(pinnacleEventId);

  // Disconnect if no more subscriptions
  if (s.subscribed.size === 0 && s.socket) {
    s.socket.close();
    s.socket = null;
  }
}

/**
 * Subscribe to scores for multiple events
 */
export function subscribeToScores(pinnacleEventIds: string[]): void {
  for (const eventId of pinnacleEventIds) {
    subscribeToScore(eventId);
  }
}

/**
 * Clear all subscriptions and disconnect
 */
export function disconnectScores(): void {
  s.subscribed.clear();
  s.subIds.clear();

  if (s.reconnectTimer) {
    clearTimeout(s.reconnectTimer);
    s.reconnectTimer = null;
  }

  stopHeartbeat();

  if (s.socket) {
    s.socket.close();
    s.socket = null;
  }

  s.connected = false;
}

/**
 * Check if WebSocket is connected
 */
export function isScoreWebSocketConnected(): boolean {
  return (
    s.connected && s.socket !== null && s.socket.readyState === WebSocket.OPEN
  );
}

/**
 * Get list of subscribed event IDs
 */
export function getSubscribedEventIds(): string[] {
  return Array.from(s.subscribed);
}

/**
 * Force reconnection (for healing)
 */
export async function reconnect(): Promise<void> {
  // Close existing connection
  if (s.socket) {
    s.socket.removeAllListeners();
    try {
      if (
        s.socket.readyState === WebSocket.OPEN ||
        s.socket.readyState === WebSocket.CONNECTING
      ) {
        s.socket.close();
      }
    } catch {
      // Ignore close errors
    }
    s.socket = null;
  }

  s.connected = false;
  stopHeartbeat();

  if (s.reconnectTimer) {
    clearTimeout(s.reconnectTimer);
    s.reconnectTimer = null;
  }

  // Only reconnect if we have subscriptions
  if (s.subscribed.size > 0) {
    connect();
  }
}

/**
 * Set callback to be invoked when connection is restored
 */
export function onReconnect(callback: () => void): void {
  s.onReconnectCb = callback;
}

/**
 * Get connection health info
 */
export function getConnectionHealth(): {
  connected: boolean;
  consecutiveFailures: number;
  subscribedEvents: number;
} {
  return {
    connected:
      s.connected &&
      s.socket !== null &&
      s.socket.readyState === WebSocket.OPEN,
    consecutiveFailures: s.failures,
    subscribedEvents: s.subscribed.size,
  };
}
