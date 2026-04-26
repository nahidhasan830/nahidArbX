"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useDebouncedValue } from "@/components/hooks/useDebouncedValue";
import { ValueBetSpreadsheet } from "@/components/spreadsheet/ValueBetSpreadsheet";
import { useBulkAnalysisPreferences } from "@/components/hooks/useBulkAnalysisPreferences";
import { useInfiniteEvents } from "@/components/hooks/useInfiniteEvents";
import {
  PROVIDER_IDS,
  getProviderDisplayName,
  getProviderShortName,
} from "@/lib/providers/registry";
import { useEventStream } from "@/components/hooks/useEventStream";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { AlertCircle, Loader2, RefreshCw, Radio } from "lucide-react";
import { Toaster } from "sonner";
import { useAuth, Feature } from "@/components/auth/AuthProvider";
import { useProviderRuntimeState } from "@/components/hooks/useProviderRuntimeState";
import { AppShell } from "@/components/nav/AppShell";

// ============================================
// Types
// ============================================

interface PhaseProgress {
  current: number;
  total: number;
  subPhase?: string;
}

interface SyncStatus {
  isSyncing: boolean;
  isSchedulerActive: boolean;
  currentPhase: string | null;
  phaseProgress: PhaseProgress | null;
  lastSyncStart: string | null;
  lastSyncEnd: string | null;
}

interface ConnectionHealth {
  betconstruct: {
    connected: boolean;
    consecutiveTimeouts: number;
    isReconnecting: boolean;
    pendingRequests: number;
  };
  pinnacle?: {
    hasToken: boolean;
    tokenTTL: number | null;
    expiresIn: string | null;
  };
  scores?: {
    pinnacleWs: { connected: boolean };
    bcPoller: { active: boolean; eventCount: number };
  };
  [providerId: string]: unknown;
}

// ============================================
// Small header helpers (no chrome — rendered inline in AppShell actions)
// ============================================

function HealthDot({
  label,
  isHealthy,
  tooltip,
}: {
  label: string;
  isHealthy: boolean;
  tooltip: string;
}) {
  return (
    <div className="flex items-center gap-1 px-1 py-0.5" title={tooltip}>
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          isHealthy ? "bg-green-500" : "bg-red-500 animate-pulse"
        }`}
      />
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </div>
  );
}

function HealthStrip({
  connectionHealth,
  isSSEConnected,
}: {
  connectionHealth: ConnectionHealth | null | undefined;
  isSSEConnected: boolean;
}) {
  const providerRuntime = useProviderRuntimeState();
  const show = (id: string) =>
    providerRuntime.isLoading
      ? true
      : providerRuntime.isEnabled(
          id as Parameters<typeof providerRuntime.isEnabled>[0],
        );

  const isProviderHealthy = (id: string): boolean => {
    if (!connectionHealth) return false;
    if (id === "pinnacle") return connectionHealth.pinnacle?.hasToken ?? false;
    if (id === "betconstruct")
      return connectionHealth.betconstruct?.connected ?? false;
    const generic = connectionHealth[id] as
      | { status?: string }
      | null
      | undefined;
    return generic?.status === "ok";
  };

  return (
    <Feature id="health-status">
      <div className="flex items-center gap-0.5">
        <div
          className="flex items-center gap-1 px-1 py-0.5"
          title={
            isSSEConnected
              ? "Live stream connected"
              : "Live stream disconnected — falling back to polling"
          }
        >
          <Radio
            className={`w-3 h-3 ${isSSEConnected ? "text-green-500" : "text-red-500 animate-pulse"}`}
          />
          <span className="text-[10px] text-muted-foreground">Live</span>
        </div>
        {PROVIDER_IDS.map((id) => {
          if (!show(id)) return null;
          const healthy = isProviderHealthy(id);
          const name = getProviderDisplayName(id);
          return (
            <HealthDot
              key={id}
              label={getProviderShortName(id)}
              isHealthy={healthy}
              tooltip={healthy ? `${name} OK` : `${name} error`}
            />
          );
        })}
      </div>
    </Feature>
  );
}

function formatTime(iso: string | null) {
  if (!iso) return "Never";
  const date = new Date(iso);
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ============================================
// Sync Status Display (shown during initial sync)
// ============================================

function SyncStatusDisplay({ syncStatus }: { syncStatus: SyncStatus | null }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!syncStatus?.lastSyncStart) return;
    const start = new Date(syncStatus.lastSyncStart).getTime();
    const updateElapsed = () =>
      setElapsed(Math.floor((Date.now() - start) / 1000));
    updateElapsed();
    const timer = setInterval(updateElapsed, 1000);
    return () => clearInterval(timer);
  }, [syncStatus?.lastSyncStart]);

  const phaseLabels: Record<string, string> = {
    fixtures: "Fetching events from providers",
    matching: "Matching events across providers",
    markets: "Fetching odds",
    idle: "Waiting for sync...",
  };

  if (!syncStatus) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-4">
          <Loader2 className="w-12 h-12 text-primary animate-spin mx-auto" />
          <p className="text-lg font-medium text-muted-foreground">
            Connecting to server...
          </p>
        </div>
      </div>
    );
  }

  const phase = syncStatus.currentPhase ?? "idle";
  const progress = syncStatus.phaseProgress;
  const subPhase = progress?.subPhase;

  // Resolve via registry — picks up new providers automatically
  // (e.g. velki-sportsbook → "Velki Sportsbook") with no edit here.
  const formatProvider = (name: string) => getProviderDisplayName(name);

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-4">
        <Loader2 className="w-12 h-12 text-primary animate-spin mx-auto" />

        <p className="text-lg font-medium text-muted-foreground">
          {phaseLabels[phase] ?? "Loading..."}
        </p>

        {phase === "markets" && subPhase && (
          <p className="text-sm text-primary font-medium">
            {formatProvider(subPhase)}
          </p>
        )}

        {phase === "markets" && progress && progress.total > 0 && (
          <div className="w-64 mx-auto space-y-2">
            <Progress value={(progress.current / progress.total) * 100} />
            <p className="text-xs text-muted-foreground">
              {progress.current} / {progress.total} events
            </p>
          </div>
        )}

        {elapsed > 0 && (
          <p className="text-xs text-muted-foreground/70">{elapsed}s elapsed</p>
        )}
      </div>
    </div>
  );
}

// ============================================
// Error Banner
// ============================================

function ErrorBanner({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}) {
  return (
    <Alert variant="destructive" className="mx-auto max-w-md">
      <AlertCircle className="h-4 w-4" />
      <AlertDescription className="flex items-center justify-between">
        <span>{error}</span>
        <Button variant="destructive" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}

// ============================================
// Main Page Component
// ============================================

export default function AdminPage() {
  const {
    showOnlyValue,
    evRangeMin,
    evRangeMax,
    softOddsRangeMin,
    softOddsRangeMax,
    selectedSoftProviders,
    selectedProviders,
    timeFilter,
    selectedMarketTypes,
    minProviderCount,
  } = useBulkAnalysisPreferences();

  const { isImpersonating } = useAuth();
  const [searchTerm, setSearchTerm] = useState("");

  const debouncedSearch = useDebouncedValue(searchTerm, 300);
  const serverSearch =
    debouncedSearch.trim().length >= 2 ? debouncedSearch.trim() : "";

  const infiniteQuery = useInfiniteEvents({
    search: serverSearch,
    pageSize: 50,
    valueFilters: showOnlyValue
      ? {
          showOnlyValue: true,
          evRangeMin,
          evRangeMax,
          softOddsMin: softOddsRangeMin,
          softOddsMax: softOddsRangeMax,
          softProviders: Array.from(selectedSoftProviders),
        }
      : undefined,
    displayFilters: {
      providers:
        selectedProviders.size < PROVIDER_IDS.length
          ? Array.from(selectedProviders)
          : undefined,
      timeFilter,
      marketTypes:
        selectedMarketTypes.size > 0
          ? Array.from(selectedMarketTypes)
          : undefined,
      minProviderCount,
    },
  });

  const activeQuery = infiniteQuery;
  const events = activeQuery.events;
  const syncStatus = activeQuery.syncStatus;
  const connectionHealth = activeQuery.connectionHealth;
  const summary = activeQuery.summary;
  const isQueryLoading = activeQuery.isLoading;
  const queryError = activeQuery.error;

  const stats = summary
    ? {
        totalEvents: summary.totalEvents,
        matchedEvents: summary.matchedEvents,
      }
    : null;

  const { isConnected: isSSEConnected } = useEventStream({
    onSyncComplete: useCallback(() => {
      activeQuery.refetch();
    }, [activeQuery]),
    onFixturesComplete: useCallback(() => {
      activeQuery.invalidateEvents();
    }, [activeQuery]),
  });

  useEffect(() => {
    if (isSSEConnected) return;
    const pollInterval = (syncStatus?.isSyncing ?? false) ? 3000 : 30000;
    const interval = setInterval(() => {
      activeQuery.refetch();
    }, pollInterval);
    return () => clearInterval(interval);
  }, [isSSEConnected, syncStatus?.isSyncing, activeQuery]);

  const syncAbortRef = useRef<AbortController | null>(null);

  const handleSyncNow = async () => {
    if (syncAbortRef.current) {
      syncAbortRef.current.abort();
    }
    const controller = new AbortController();
    syncAbortRef.current = controller;
    try {
      await fetch("/api/value-bets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "syncNow" }),
        signal: controller.signal,
      });
      activeQuery.refetch();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      console.error("Failed to trigger sync:", err);
    }
  };

  const handleRefreshComplete = useCallback(() => {
    activeQuery.refetch();
  }, [activeQuery]);

  const isSyncing = syncStatus?.isSyncing ?? false;
  const isLoading = isQueryLoading && events.length === 0;
  const error = queryError
    ? queryError instanceof Error
      ? queryError.message
      : "Unknown error"
    : null;

  // Sync-in-progress badge rendered next to the page title.
  const titleBadge = isSyncing ? (
    <Badge variant="secondary" className="gap-1.5 ml-2">
      <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
      {syncStatus?.currentPhase || "Syncing"}
    </Badge>
  ) : null;

  // Right-side header actions — health dots, stats, last sync, sync button,
  // profile menu. Everything that used to live in the secondary AdminHeader.
  const actions = (
    <>
      <HealthStrip
        connectionHealth={connectionHealth}
        isSSEConnected={isSSEConnected}
      />
      <span className="text-[11px] text-muted-foreground tabular-nums">
        <span className="font-medium text-foreground">
          {stats?.matchedEvents ?? 0}
        </span>{" "}
        matched · {stats?.totalEvents ?? 0} total
      </span>
      <span className="text-[11px] text-muted-foreground">
        Last: {formatTime(syncStatus?.lastSyncEnd ?? null)}
      </span>
      <Feature id="sync-all">
        <LoadingButton
          onClick={handleSyncNow}
          disabled={isLoading}
          loading={isSyncing}
          icon={RefreshCw}
          size="sm"
          variant="outline"
          className="h-8 px-2 gap-1.5 text-[11px]"
          title={isSyncing ? "Syncing…" : "Sync now"}
        >
          <span className="hidden sm:inline">
            {isSyncing ? "Syncing…" : "Sync Now"}
          </span>
        </LoadingButton>
      </Feature>
    </>
  );

  return (
    <AppShell
      title="Value Bets"
      titleBadge={titleBadge}
      actions={actions}
      edgeToEdge
    >
      <div
        className={`flex flex-col overflow-hidden ${isImpersonating ? "pt-10" : ""}`}
        style={{ height: "calc(100vh - 3rem)" }}
      >
        <main className="flex-1 p-2 min-h-0 flex flex-col overflow-auto">
          {error ? (
            <ErrorBanner error={error} onRetry={() => activeQuery.refetch()} />
          ) : isLoading ? (
            <SyncStatusDisplay syncStatus={syncStatus} />
          ) : (
            <ValueBetSpreadsheet
              events={events}
              isLoading={isLoading}
              isSyncing={isSyncing}
              onRefreshComplete={handleRefreshComplete}
              hasNextPage={activeQuery.hasNextPage}
              isFetchingNextPage={activeQuery.isFetchingNextPage}
              onLoadMore={activeQuery.fetchNextPage}
              totalCount={activeQuery.totalCount}
              searchTerm={searchTerm}
              onSearchChange={setSearchTerm}
            />
          )}
        </main>
      </div>
      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{
          classNames: {
            toast: "!bg-neutral-900 !text-white !border-neutral-700",
            title: "!text-white",
            description: "!text-white/80",
          },
        }}
      />
    </AppShell>
  );
}
