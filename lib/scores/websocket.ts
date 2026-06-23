
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

const NULL_CHAR = "\x00";

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
  const cleaned = data.replace(/\x00+$/, "");
  const lines = cleaned.split("\n");

  if (lines.length < 1) return null;

  const command = lines[0];
  const headers: Record<string, string> = {};
  let bodyStartIndex = 1;

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


function handleMessage(data: string): void {
  if (data.startsWith("ping:") || data.startsWith("pong:")) {
    return;
  }

  const frame = parseStompFrame(data);
  if (!frame) return;

  switch (frame.command) {
    case "CONNECTED":
      s.connected = true;
      s.failures = 0;
      for (const eventId of s.subscribed) {
        sendSubscribe(eventId);
      }
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
      break;

    default:
      break;
  }
}

function handleScoreMessage(
  headers: Record<string, string>,
  body: string,
): void {
  const destination = headers["destination"] || "";

  if (!destination.startsWith("/in-running/")) return;

  const eventId = destination.replace("/in-running/", "");

  if (!body || body.trim() === "") return;

  if (body.startsWith("ping:") || body.startsWith("pong:")) return;

  if (!body.startsWith("[")) return;

  try {
    const messages: LiveScoreMessage[] = JSON.parse(body);

    for (const msg of messages) {
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
        const stored = getLiveScore(eventId);

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
    s.socket.send("\n");
  }
}


function connect(): void {
  if (s.socket) {
    try {
      s.socket.removeAllListeners();
      s.socket.on("error", () => {});
    } catch {
    }
    try {
      s.socket.close();
    } catch {
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
  }, 5000);
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


export function subscribeToScore(pinnacleEventId: string): void {
  if (s.subscribed.has(pinnacleEventId)) return;

  s.subscribed.add(pinnacleEventId);

  if (!s.socket || s.socket.readyState !== WebSocket.OPEN) {
    connect();
  } else if (s.connected) {
    sendSubscribe(pinnacleEventId);
  }
}

export function unsubscribeFromScore(pinnacleEventId: string): void {
  if (!s.subscribed.has(pinnacleEventId)) return;

  s.subscribed.delete(pinnacleEventId);
  sendUnsubscribe(pinnacleEventId);

  if (s.subscribed.size === 0 && s.socket) {
    s.socket.close();
    s.socket = null;
  }
}

export function subscribeToScores(pinnacleEventIds: string[]): void {
  for (const eventId of pinnacleEventIds) {
    subscribeToScore(eventId);
  }
}

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

export function isScoreWebSocketConnected(): boolean {
  return (
    s.connected && s.socket !== null && s.socket.readyState === WebSocket.OPEN
  );
}

export function getSubscribedEventIds(): string[] {
  return Array.from(s.subscribed);
}

export async function reconnect(): Promise<void> {
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
    }
    s.socket = null;
  }

  s.connected = false;
  stopHeartbeat();

  if (s.reconnectTimer) {
    clearTimeout(s.reconnectTimer);
    s.reconnectTimer = null;
  }

  if (s.subscribed.size > 0) {
    connect();
  }
}

export function onReconnect(callback: () => void): void {
  s.onReconnectCb = callback;
}

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
