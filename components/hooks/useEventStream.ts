"use client";


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
  onSyncComplete?: (data: {
    duration: number;
    valueBetCount: number;
    dirtyFamilies: number;
  }) => void;
  onFixturesComplete?: (data: {
    matchedEvents: number;
    rawEvents: number;
  }) => void;
  onPhaseChange?: (data: {
    phase: string;
    progress?: { current: number; total: number };
  }) => void;
  onValueChange?: (data: {
    added: number;
    removed: number;
    total: number;
  }) => void;
  onDelta?: (data: DeltaUpdate) => void;
  onFullRefreshNeeded?: (data: FullRefreshSignal) => void;
}

interface UseEventStreamReturn {
  isConnected: boolean;
  serverVersion: number;
  clientCount: number;
}

export function useEventStream(
  callbacks: SSECallbacks,
  enabled = true,
): UseEventStreamReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [serverVersion, setServerVersion] = useState(0);
  const [clientCount, setClientCount] = useState(0);

  const callbacksRef = useRef(callbacks);
  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);

  const serverVersionRef = useRef(serverVersion);
  useEffect(() => {
    serverVersionRef.current = serverVersion;
  }, [serverVersion]);

  const sourceRef = useRef<EventSource | null>(null);

  const connect = useCallback(() => {
    if (!enabled) return;

    sourceRef.current?.close();

    const es = new EventSource("/api/value-bets/stream");
    sourceRef.current = es;

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

    es.addEventListener("sync:complete", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      setServerVersion(data.version ?? serverVersionRef.current);
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

    es.onerror = () => {
      setIsConnected(false);
    };

    es.onopen = () => {
      setIsConnected(true);
    };

    return es;
  }, [enabled]);

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
