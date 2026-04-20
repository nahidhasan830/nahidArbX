"use client";

/**
 * useEventStream - SSE hook for real-time dashboard updates
 *
 * Connects to /api/value-bets/stream and fires callbacks when
 * the server pushes sync events. Replaces polling with event-driven updates.
 *
 * Browser's EventSource handles auto-reconnect natively (retry: 5000ms from server).
 */

import { useEffect, useRef, useCallback, useState } from "react";

export interface DeltaUpdate {
  type: "delta";
  version: number;
  timestamp: number;
  valueBetsAdded: unknown[];
  valueBetsRemoved: string[];
  summary: {
    totalValueBets: number;
    bestEvPct: number | null;
  };
  changeCount: number;
}

export interface FullRefreshSignal {
  type: "full-refresh";
  version: number;
  reason: string;
}

export interface SSECallbacks {
  /** Called when odds sync completes — time to refetch dashboard data */
  onSyncComplete?: (data: {
    duration: number;
    valueBetCount: number;
    dirtyFamilies: number;
  }) => void;
  /** Called when fixtures sync completes — events list changed */
  onFixturesComplete?: (data: {
    matchedEvents: number;
    rawEvents: number;
  }) => void;
  /** Called when sync phase changes — update progress UI */
  onPhaseChange?: (data: {
    phase: string;
    progress?: { current: number; total: number };
  }) => void;
  /** Called when value bet count changes */
  onValueChange?: (data: {
    added: number;
    removed: number;
    total: number;
  }) => void;
  /** Called with delta update — apply changes without full refresh */
  onDelta?: (data: DeltaUpdate) => void;
  /** Called when full refresh is needed (delta too large or fixtures changed) */
  onFullRefreshNeeded?: (data: FullRefreshSignal) => void;
}

interface UseEventStreamReturn {
  /** Whether the SSE connection is open */
  isConnected: boolean;
  /** Current server data version (for ETag) */
  serverVersion: number;
  /** Number of connected SSE clients (from heartbeat) */
  clientCount: number;
}

export function useEventStream(
  callbacks: SSECallbacks,
  enabled = true,
): UseEventStreamReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [serverVersion, setServerVersion] = useState(0);
  const [clientCount, setClientCount] = useState(0);

  // Ref to always use latest callbacks without re-creating EventSource
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const sourceRef = useRef<EventSource | null>(null);

  const connect = useCallback(() => {
    if (!enabled) return;

    // Close any existing connection
    sourceRef.current?.close();

    const es = new EventSource("/api/value-bets/stream");
    sourceRef.current = es;

    // -- Connection lifecycle --
    es.addEventListener("connected", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      setIsConnected(true);
      setServerVersion(data.version);
    });

    es.addEventListener("heartbeat", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      setServerVersion(data.version);
      setClientCount(data.clients ?? 0);
    });

    // -- Sync events --
    es.addEventListener("sync:complete", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      setServerVersion(data.version ?? serverVersion);
      callbacksRef.current.onSyncComplete?.(data);
    });

    es.addEventListener("fixtures:complete", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      callbacksRef.current.onFixturesComplete?.(data);
    });

    es.addEventListener("sync:phase", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      callbacksRef.current.onPhaseChange?.(data);
    });

    es.addEventListener("value:change", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      callbacksRef.current.onValueChange?.(data);
    });

    // -- Delta updates --
    es.addEventListener("data:delta", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      if (data.type === "delta") {
        setServerVersion(data.version);
        callbacksRef.current.onDelta?.(data);
      } else if (data.type === "full-refresh") {
        setServerVersion(data.version);
        callbacksRef.current.onFullRefreshNeeded?.(data);
      }
    });

    // -- Error handling --
    es.onerror = () => {
      setIsConnected(false);
      // EventSource auto-reconnects; no manual logic needed
    };

    es.onopen = () => {
      setIsConnected(true);
    };

    return es;
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const es = connect();
    return () => {
      es?.close();
      sourceRef.current = null;
      setIsConnected(false);
    };
  }, [connect]);

  return { isConnected, serverVersion, clientCount };
}
