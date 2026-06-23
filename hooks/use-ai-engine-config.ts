
"use client";

import { useCallback, useEffect, useState } from "react";

export interface EngineStatus {
  enabled: boolean;
  disabledReason: string | null;
}

export type EngineConfigMap = Record<string, EngineStatus>;

export function useAiEngineConfig(pollMs = 0) {
  const [configs, setConfigs] = useState<EngineConfigMap>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/ai-engine-config", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as EngineConfigMap;
        setConfigs(data);
      }
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    if (pollMs > 0) {
      const id = setInterval(load, pollMs);
      return () => clearInterval(id);
    }
  }, [load, pollMs]);

  const isEngineEnabled = useCallback(
    (name: string) => configs[name]?.enabled !== false,
    [configs],
  );

  return { configs, loading, isEngineEnabled, refresh: load };
}
