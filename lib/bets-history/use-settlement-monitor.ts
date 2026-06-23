"use client";


import { useCallback, useEffect, useRef, useState } from "react";
import {
  getSettlementStatus,
  type SettlementActivityEntry,
  type SettlementStatus,
} from "./api-client";

const ACTIVITY_CAP = 200;
const POLL_INTERVAL_MS = 5_000;

export type UseSettlementMonitorState = {
  status: SettlementStatus | null;
  activity: SettlementActivityEntry[];
  loading: boolean;
  error: string | null;
  sseConnected: boolean;
  refresh: () => Promise<void>;
};

function mergeActivity(
  prev: SettlementActivityEntry[],
  incoming: SettlementActivityEntry[],
): SettlementActivityEntry[] {
  const seen = new Set<string>();
  const out: SettlementActivityEntry[] = [];
  for (const e of [...prev, ...incoming]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  out.sort((a, b) => a.ts - b.ts);
  if (out.length > ACTIVITY_CAP) return out.slice(out.length - ACTIVITY_CAP);
  return out;
}

export function useSettlementMonitor(
  enabled: boolean,
): UseSettlementMonitorState {
  const [status, setStatus] = useState<SettlementStatus | null>(null);
  const [activity, setActivity] = useState<SettlementActivityEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sseConnected, setSseConnected] = useState(false);

  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!mountedRef.current) return;
    setLoading(true);
    setError(null);
    try {
      const data = await getSettlementStatus({ runs: 50, log: 200 });
      if (!mountedRef.current) return;
      setStatus(data);
      setActivity((prev) => mergeActivity(prev, data.activity));
    } catch (err) {
      if (!mountedRef.current) return;
      setError((err as Error).message);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();

    const pollTimer = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);

    let es: EventSource | null = null;
    try {
      es = new EventSource("/api/value-bets/stream");
      es.addEventListener("open", () => setSseConnected(true));
      es.addEventListener("error", () => setSseConnected(false));
      es.addEventListener("settle:log", (e) => {
        try {
          const payload = JSON.parse((e as MessageEvent).data) as {
            entry: SettlementActivityEntry;
          };
          if (payload.entry) {
            setActivity((prev) => mergeActivity(prev, [payload.entry]));
          }
        } catch {
        }
      });
      es.addEventListener("settle:state", (e) => {
        try {
          const payload = JSON.parse((e as MessageEvent).data) as {
            status: Partial<SettlementStatus>;
          };
          if (payload.status) {
            setStatus((prev) => {
              if (!prev) {
                void refresh();
                return prev;
              }
              return { ...prev, ...payload.status };
            });
          }
        } catch {
        }
      });
    } catch {
      setSseConnected(false);
    }

    return () => {
      clearInterval(pollTimer);
      es?.close();
      setSseConnected(false);
    };
  }, [enabled, refresh]);

  return { status, activity, loading, error, sseConnected, refresh };
}
