"use client";

/**
 * Hook that mirrors the server-side `enabled-providers` state.
 *
 * The provider dropdown in the spreadsheet toolbar drives this. Unchecking a
 * provider disables fixture fetching, odds fetching, and AI match analysis
 * for that provider on the backend — not just a UI filter.
 *
 * State is authoritative on the server (persisted to data/config/enabled-providers.json).
 * This hook hydrates once on mount, does optimistic updates on toggle, and
 * reverts on error with a toast.
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  PROVIDER_IDS,
  getProviderDisplayName,
  type ProviderKey,
} from "@/lib/providers/registry";

export interface ProviderRuntimeState {
  disabled: Set<ProviderKey>;
  isEnabled: (id: ProviderKey) => boolean;
  toggle: (id: ProviderKey, enabled: boolean) => Promise<void>;
  isLoading: boolean;
  refresh: () => Promise<void>;
}

export function useProviderRuntimeState(): ProviderRuntimeState {
  const [disabled, setDisabled] = useState<Set<ProviderKey>>(new Set());
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/providers");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { disabled: ProviderKey[] };
      setDisabled(new Set(data.disabled || []));
    } catch (err) {
      console.error("Failed to load provider state:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const isEnabled = useCallback(
    (id: ProviderKey) => PROVIDER_IDS.includes(id) && !disabled.has(id),
    [disabled],
  );

  const toggle = useCallback(async (id: ProviderKey, enabled: boolean) => {
    // Optimistic update
    setDisabled((prev) => {
      const next = new Set(prev);
      if (enabled) next.delete(id);
      else next.add(id);
      return next;
    });

    try {
      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "setEnabled",
          provider: id,
          enabled,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const label = getProviderDisplayName(id);
      if (!enabled) {
        toast.success(`⏸️ ${label} disabled`, {
          description: data.purgedEvents
            ? `Paused fetching, odds, and AI — purged ${data.purgedEvents} event${data.purgedEvents === 1 ? "" : "s"}`
            : "Paused fetching, odds, and AI",
        });
      } else {
        toast.success(`▶️ ${label} enabled`, {
          description: "Data will repopulate on the next sync",
        });
      }
    } catch (err) {
      // Revert optimistic change
      setDisabled((prev) => {
        const next = new Set(prev);
        if (enabled) next.add(id);
        else next.delete(id);
        return next;
      });
      toast.error("❌ Couldn't update provider", {
        description: `${getProviderDisplayName(id)} — ${(err as Error).message}`,
      });
    }
  }, []);

  return { disabled, isEnabled, toggle, isLoading, refresh };
}
