"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  filterDismissedProviderAlerts,
  parseDismissedProviderAlertFingerprints,
  PROVIDER_ALERT_DISMISS_STORAGE_KEY,
  serializeDismissedProviderAlertFingerprints,
  type ProviderAlert,
} from "@/lib/providers/health-alerts";

const EMPTY_ALERTS: ProviderAlert[] = [];

async function fetchProviderAlerts(): Promise<ProviderAlert[]> {
  const res = await fetch("/api/value-bets?fields=providerAlerts", {
    cache: "no-store",
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    providerAlerts?: ProviderAlert[];
    connectionHealth?: { providerAlerts?: ProviderAlert[] };
  };
  return data.providerAlerts ?? data.connectionHealth?.providerAlerts ?? [];
}

function readDismissedFingerprints(): Set<string> {
  if (typeof window === "undefined") return new Set();
  return parseDismissedProviderAlertFingerprints(
    window.localStorage.getItem(PROVIDER_ALERT_DISMISS_STORAGE_KEY),
  );
}

function writeDismissedFingerprints(values: Iterable<string>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    PROVIDER_ALERT_DISMISS_STORAGE_KEY,
    serializeDismissedProviderAlertFingerprints(values),
  );
}

export function useProviderHealthAlerts() {
  const [dismissed, setDismissed] = React.useState<Set<string>>(
    () => new Set(),
  );

  React.useEffect(() => {
    setDismissed(readDismissedFingerprints());

    const onStorage = (event: StorageEvent) => {
      if (event.key !== PROVIDER_ALERT_DISMISS_STORAGE_KEY) return;
      setDismissed(readDismissedFingerprints());
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const query = useQuery({
    queryKey: ["provider-health-alerts"],
    queryFn: fetchProviderAlerts,
    refetchInterval: 5_000,
    staleTime: 3_000,
    placeholderData: (prev) => prev,
  });

  const alerts = query.data ?? EMPTY_ALERTS;
  const visibleAlerts = React.useMemo(
    () => filterDismissedProviderAlerts(alerts, dismissed),
    [alerts, dismissed],
  );

  const dismissAlert = React.useCallback((fingerprint: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(fingerprint);
      writeDismissedFingerprints(next);
      return next;
    });
  }, []);

  return {
    alerts: visibleAlerts,
    allAlerts: alerts,
    dismissAlert,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
