/**
 * Client hook to fetch AI providers from DB.
 * Used by dropdown components to get provider list with enabled/disabled state.
 */

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

/**
 * Fetch all AI providers once and optionally poll.
 * @param pollMs - polling interval in ms. 0 = fetch once.
 */
export function useAiProviders(pollMs = 0) {
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/ai-providers", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as AIProvider[];
        setProviders(data);
      }
    } catch {
      // non-fatal
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

/**
 * Filter providers by engine type.
 */
export function useAiProvidersByType(type: EngineType) {
  const { providers, loading, refresh } = useAiProviders();
  const filtered = providers.filter((p) => p.engineType === type);
  return { providers: filtered, loading, refresh };
}

/**
 * Get only LLM providers.
 */
export function useLLMProviders() {
  return useAiProvidersByType("llm");
}

/**
 * Get only search providers.
 */
export function useSearchProviders() {
  return useAiProvidersByType("search");
}