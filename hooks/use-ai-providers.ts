
"use client";

import { useCallback, useEffect, useState } from "react";

export type ProviderTier = "lite" | "flash" | "pro";
export type EngineType = "llm" | "search";

export interface AIProvider {
  id: string;
  name: string;
  enabled: boolean;
  disabledReason: string | null;
  modelId: string | null;
  tier: ProviderTier | null;
  label: string;
  tagline: string | null;
  hasWebSearch: boolean;
  engineType: EngineType;
}

type ApiProvider = {
  name: string;
  enabled: boolean;
  disabledReason: string | null;
  modelId: string | null;
  tier: ProviderTier | null;
  label: string | null;
  tagline: string | null;
  hasWebSearch: boolean;
  engineType: EngineType;
};

function apiToClient(p: ApiProvider): AIProvider {
  return {
    id: p.name,
    name: p.name,
    enabled: p.enabled,
    disabledReason: p.disabledReason,
    modelId: p.modelId,
    tier: p.tier,
    label: p.label ?? p.name,
    tagline: p.tagline,
    hasWebSearch: false,
    engineType: p.engineType,
  };
}

export function useAiProviders(pollMs = 0) {
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/ai-providers", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as ApiProvider[];
        setProviders(data.map(apiToClient));
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

  return { providers, loading, refresh: load };
}

export function useAiProvidersByType(type: EngineType) {
  const { providers, loading, refresh } = useAiProviders();
  const filtered = providers.filter((p) => p.engineType === type);
  return { providers: filtered, loading, refresh };
}

export function useLLMProviders() {
  return useAiProvidersByType("llm");
}

export function useSearchProviders() {
  return useAiProvidersByType("search");
}
