/**
 * Unified AI Provider Hook
 *
 * Fetches all provider data from DB and provides:
 * - Search providers (vertex, brave, tavily) with quota
 * - LLM providers (deepseek, gemini) with quota
 * - Toggle functionality
 * - Auto-refresh
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface AiProvider {
  name: string;
  enabled: boolean;
  disabledReason: string | null;
  modelId: string | null;
  tier: string | null;
  label: string;
  tagline: string | null;
  engineType: "llm" | "search";
  totalUsageCount: number;
  monthlyUsageCount: number;
  monthlyLimit: number | null;
  monthlyRemaining: number | null;
  isExhausted: boolean;
  hasMonthlyLimit: boolean;
}

export interface UseAiProvidersOptions {
  pollMs?: number;
  enabled?: boolean;
}

export interface UseAiProvidersReturn {
  providers: AiProvider[];
  searchProviders: AiProvider[];
  llmProviders: AiProvider[];
  isLoading: boolean;
  error: string | null;
  lastLoadedAt: string | null;
  refresh: () => Promise<void>;
  toggleProvider: (name: string, enabled: boolean) => Promise<void>;
  isToggling: (name: string) => boolean;
}

export function useAiProviders(
  options: UseAiProvidersOptions = {},
): UseAiProvidersReturn {
  const { pollMs = 5000, enabled = true } = options;

  const [providers, setProviders] = useState<AiProvider[]>([]);
  const providersRef = useRef(providers);
  useEffect(() => {
    providersRef.current = providers;
  }, [providers]);

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);
  const [toggleBusy, setToggleBusy] = useState<Set<string>>(() => new Set());
  const toggleBusyRef = useRef(toggleBusy);
  // Keep ref in sync so fetchProviders can read it without stale closure
  useEffect(() => {
    toggleBusyRef.current = toggleBusy;
  }, [toggleBusy]);

  const loadRef = useRef(false);

  const fetchProviders = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/ai-providers", {
        cache: "no-store",
        signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data: AiProvider[] = await res.json();
      // Fixed sort order: Vertex → Brave → Tavily for search providers, then alphabetical for LLMs
      const SEARCH_ORDER: Record<string, number> = {
        vertex: 0,
        brave: 1,
        tavily: 2,
      };
      const getOrder = (name: string) => SEARCH_ORDER[name] ?? 99;
      data.sort((a, b) => getOrder(a.name) - getOrder(b.name));
      // Don't overwrite providers that are currently being toggled
      // (optimistic update is already showing the new state)
      const busy = toggleBusyRef.current;
      const merged = data.map((p) => {
        const uiName = p.name.startsWith("deepseek")
          ? "deepseek"
          : p.name.startsWith("gemini")
            ? "gemini"
            : p.name;
        if (busy.has(uiName)) {
          // Preserve optimistic state for this provider
          const existing = providersRef.current.find(
            (ep) => ep.name === p.name,
          );
          return existing ?? p;
        }
        return p;
      });
      setProviders(merged);
      setError(null);
      setLastLoadedAt(new Date().toISOString());
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") {
        setError(err.message);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    if (loadRef.current) return;
    loadRef.current = true;
    setIsLoading(true);
    await fetchProviders();
    loadRef.current = false;
  }, [fetchProviders]);

  const toggleProvider = useCallback(
    async (name: string, newEnabled: boolean) => {
      // Map UI names to DB names: "deepseek" → "deepseek-flash", "gemini" → "gemini-lite"
      // Note: search providers (brave, vertex, tavily) pass through as-is
      const nameMap: Record<string, string> = {
        deepseek: "deepseek-flash",
        gemini: "gemini-lite",
      };
      const dbName = nameMap[name] ?? name;

      // Optimistic update - update BOTH the UI name and DB name versions
      setProviders((prev) => {
        const updated = prev.map((p) =>
          p.name === name || p.name === dbName
            ? { ...p, enabled: newEnabled }
            : p,
        );
        return updated;
      });

      setToggleBusy((prev) => new Set(prev).add(name));

      try {
        const res = await fetch("/api/ai-engine-config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: dbName,
            enabled: newEnabled,
            reason: "manual",
          }),
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        // Don't call fetchProviders() here — it races with the polling
        // interval. Optimistic update already flipped the UI, and the
        // 3s poll will confirm the actual DB state shortly.
      } catch (err) {
        // Revert on error
        setProviders((prev) =>
          prev.map((p) =>
            p.name === name || p.name === dbName
              ? { ...p, enabled: !newEnabled }
              : p,
          ),
        );
        setError(err instanceof Error ? err.message : "Toggle failed");
      } finally {
        setToggleBusy((prev) => {
          const next = new Set(prev);
          next.delete(name);
          return next;
        });
      }
    },
    [fetchProviders],
  );

  // Initial load
  useEffect(() => {
    if (!enabled) return;
    const abortController = new AbortController();
    fetchProviders(abortController.signal);
    return () => abortController.abort();
  }, [enabled, fetchProviders]);

  // Polling
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(load, pollMs);
    return () => clearInterval(id);
  }, [enabled, load, pollMs]);

  // Derived data
  const searchProviders = providers.filter((p) => p.engineType === "search");
  const llmProviders = providers.filter((p) => p.engineType === "llm");

  return {
    providers,
    searchProviders,
    llmProviders,
    isLoading,
    error,
    lastLoadedAt,
    refresh: load,
    toggleProvider,
    isToggling: (name: string) => toggleBusy.has(name),
  };
}
