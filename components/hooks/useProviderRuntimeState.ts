"use client";


import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  PROVIDER_IDS,
  getProviderDisplayName,
  type ProviderKey,
} from "@/lib/providers/registry";

export interface ProviderRuntimeState {
  disabled: Set<ProviderKey>;
  providerHealthTelegramEnabled: boolean;
  isProviderHealthTelegramUpdating: boolean;
  isEnabled: (id: ProviderKey) => boolean;
  toggle: (id: ProviderKey, enabled: boolean) => Promise<void>;
  toggleProviderHealthTelegram: (enabled: boolean) => Promise<void>;
  isLoading: boolean;
  refresh: () => Promise<void>;
}

export function useProviderRuntimeState(): ProviderRuntimeState {
  const [disabled, setDisabled] = useState<Set<ProviderKey>>(new Set());
  const [providerHealthTelegramEnabled, setProviderHealthTelegramEnabled] =
    useState(false);
  const [
    isProviderHealthTelegramUpdating,
    setIsProviderHealthTelegramUpdating,
  ] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/providers");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        disabled: ProviderKey[];
        healthTelegram?: { enabled?: boolean };
      };
      setDisabled(new Set(data.disabled || []));
      setProviderHealthTelegramEnabled(data.healthTelegram?.enabled === true);
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

  const toggleProviderHealthTelegram = useCallback(async (enabled: boolean) => {
    setProviderHealthTelegramEnabled(enabled);
    setIsProviderHealthTelegramUpdating(true);

    try {
      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "setHealthTelegramEnabled",
          enabled,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      toast.success(
        enabled
          ? "Telegram provider alerts enabled"
          : "Telegram provider alerts disabled",
        {
          description: enabled
            ? "Provider down and recovered events will send to Telegram"
            : "Provider down and recovered events will stay silent",
        },
      );
    } catch (err) {
      setProviderHealthTelegramEnabled(!enabled);
      toast.error("Couldn't update Telegram provider alerts", {
        description: (err as Error).message,
      });
    } finally {
      setIsProviderHealthTelegramUpdating(false);
    }
  }, []);

  return {
    disabled,
    providerHealthTelegramEnabled,
    isProviderHealthTelegramUpdating,
    isEnabled,
    toggle,
    toggleProviderHealthTelegram,
    isLoading,
    refresh,
  };
}
