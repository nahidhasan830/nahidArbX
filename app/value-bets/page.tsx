"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useDebouncedValue } from "@/components/hooks/useDebouncedValue";
import { BulkResultsSpreadsheet } from "@/components/spreadsheet/BulkResultsSpreadsheet";
import { useBulkAnalysisPreferences } from "@/components/hooks/useBulkAnalysisPreferences";
import { useInfiniteEvents } from "@/components/hooks/useInfiniteEvents";
import { PROVIDER_IDS } from "@/lib/providers/registry";
import { useEventStream } from "@/components/hooks/useEventStream";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import {
  AlertCircle,
  Loader2,
  RefreshCw,
  Activity,
  Radio,
  Brain,
  LineChart,
} from "lucide-react";
import { Toaster } from "sonner";
import { ProfileMenu } from "@/components/auth/ProfileMenu";
import { UserManagementModal } from "@/components/auth/UserManagementModal";
import { useAuth, Feature } from "@/components/auth/AuthProvider";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { DiagnosticsTab } from "@/components/diagnostics";
import { useProviderRuntimeState } from "@/components/hooks/useProviderRuntimeState";
import { cn } from "@/lib/utils";
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
  "ninewickets-exchange"?: {
    status: string;
    lastFetch: string | null;
    error: string | null;
  };
  "ninewickets-sportsbook"?: {
    status: string;
    lastFetch: string | null;
    error: string | null;
  };
  // Score providers (separate from odds)
  scores?: {
    pinnacleWs: {
      connected: boolean;
    };
    bcPoller: {
      active: boolean;
      eventCount: number;
    };
  };
}

// ============================================
// Admin Header Component
// ============================================

interface AdminHeaderProps {
  syncStatus: SyncStatus | null;
  connectionHealth?: ConnectionHealth | null;
  onSyncNow: () => void;
  isLoading: boolean;
  isSyncing: boolean;
  isSSEConnected: boolean;
  stats: {
    totalEvents: number;
    matchedEvents: number;
  } | null;
  onOpenUserManagement: () => void;
  activeView: "events" | "diagnostics";
  onSetView: (view: "events" | "diagnostics") => void;
}

// Simple health dot with tooltip
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
    <div
      className="flex items-center gap-1 px-1.5 py-0.5 rounded"
      title={tooltip}
    >
      <span
        className={`w-2 h-2 rounded-full ${
          isHealthy ? "bg-green-500" : "bg-red-500 animate-pulse"
        }`}
      />
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </div>
  );
}

function AdminHeader({
  syncStatus,
  connectionHealth,
  onSyncNow,
  isLoading,
  isSyncing,
  isSSEConnected,
  stats,
  onOpenUserManagement,
  activeView,
  onSetView,
}: AdminHeaderProps) {
  const formatTime = (iso: string | null) => {
    if (!iso) return "Never";
    const date = new Date(iso);
    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  // Simple health checks (healthy = true/false)
  const pinnacleOk = connectionHealth?.pinnacle?.hasToken ?? false;
  const bcOk = connectionHealth?.betconstruct?.connected ?? false;
  const nwExOk = connectionHealth?.["ninewickets-exchange"]?.status === "ok";
  const nwSbOk = connectionHealth?.["ninewickets-sportsbook"]?.status === "ok";

  // Hide health dots for runtime-disabled providers — no point reporting
  // connection state for a provider the user has switched off.
  const providerRuntime = useProviderRuntimeState();
  const show = (id: string) =>
    providerRuntime.isLoading
      ? true
      : providerRuntime.isEnabled(
          id as Parameters<typeof providerRuntime.isEnabled>[0],
        );

  return (
    <header className="bg-card border-b border-border px-4 py-2">
      <div className="flex items-center">
        {/* Left: Logo + Sync Status - fixed width to prevent shifts */}
        <div className="flex items-center gap-3 min-w-[220px]">
          <BrandLogo size="md" />
          {/* Always render badge, use opacity to hide - prevents layout shift */}
          <Badge
            variant="secondary"
            className={`gap-1.5 transition-opacity ${
              syncStatus?.isSyncing
                ? "opacity-100"
                : "opacity-0 pointer-events-none"
            }`}
          >
            <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
            {syncStatus?.currentPhase || "Idle"}
          </Badge>
        </div>

        {/* Center: Health Status - flex-1 to absorb any shifts */}
        <div className="flex-1 flex items-center justify-center gap-1">
          <Feature id="health-status">
            <div
              className="flex items-center gap-1 px-1.5 py-0.5 rounded"
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
            {show("pinnacle") && (
              <HealthDot
                label="PIN"
                isHealthy={pinnacleOk}
                tooltip={
                  pinnacleOk ? "Pinnacle token active" : "No Pinnacle token"
                }
              />
            )}
            {show("betconstruct") && (
              <HealthDot
                label="BC"
                isHealthy={bcOk}
                tooltip={
                  bcOk ? "BetConstruct connected" : "BetConstruct disconnected"
                }
              />
            )}
            {show("ninewickets-exchange") && (
              <HealthDot
                label="9W-Ex"
                isHealthy={nwExOk}
                tooltip={
                  nwExOk ? "9Wickets Exchange OK" : "9Wickets Exchange error"
                }
              />
            )}
            {show("ninewickets-sportsbook") && (
              <HealthDot
                label="9W-SB"
                isHealthy={nwSbOk}
                tooltip={
                  nwSbOk
                    ? "9Wickets Sportsbook OK"
                    : "9Wickets Sportsbook error"
                }
              />
            )}
          </Feature>
        </div>

        {/* Right: Stats + Controls - fixed width */}
        <div className="flex items-center gap-4 min-w-[280px] justify-end">
          {/* Events count - fixed width with tabular-nums */}
          <div className="text-xs text-muted-foreground tabular-nums min-w-[120px] text-right">
            <span className="font-medium text-foreground">
              {stats?.matchedEvents ?? 0}
            </span>
            <span> matched</span>
            <span className="mx-1">·</span>
            <span>{stats?.totalEvents ?? 0}</span>
            <span> total</span>
          </div>

          {/* Last sync time */}
          <span className="text-xs text-muted-foreground min-w-[100px]">
            Last: {formatTime(syncStatus?.lastSyncEnd ?? null)}
          </span>

          {/* Sync button - requires sync-all permission */}
          <Feature id="sync-all">
            <LoadingButton
              onClick={onSyncNow}
              disabled={isLoading}
              loading={isSyncing}
              icon={RefreshCw}
              size="sm"
            >
              {isSyncing ? "Syncing..." : "Sync Now"}
            </LoadingButton>
          </Feature>

          {/* Review toggle — switches between the events spreadsheet and
              the Match Review / AI diagnostics pane. Matches the Sync Now
              pill's height/padding so both primary header actions have the
              same hit area, and flips to a filled violet state while Review
              is open so the current mode is visible at a glance. */}
          <Feature id="diagnostics">
            <Button
              variant={activeView === "diagnostics" ? "default" : "outline"}
              size="sm"
              onClick={() =>
                onSetView(
                  activeView === "diagnostics" ? "events" : "diagnostics",
                )
              }
              title={
                activeView === "diagnostics"
                  ? "Back to Events"
                  : "Open Match Review — AI-assisted match diagnostics"
              }
              className={cn(
                "gap-1.5",
                activeView === "diagnostics" &&
                  "bg-violet-600 hover:bg-violet-500 text-white border-transparent",
              )}
            >
              <Brain className="w-4 h-4" />
              Review
            </Button>
          </Feature>
          <Button
            variant="outline"
            size="sm"
            asChild
            title="Open Backtest dashboard"
            className="gap-1.5"
          >
            <a href="/backtest">
              <LineChart className="w-4 h-4" />
              Backtest
            </a>
          </Button>
          {/* Profile Menu */}
          <ProfileMenu onOpenUserManagement={onOpenUserManagement} />
        </div>
      </div>
    </header>
  );
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

  const formatProvider = (name: string) => {
    const map: Record<string, string> = {
      pinnacle: "Pinnacle",
      "ninewickets-exchange": "9Wickets Exchange",
      "ninewickets-sportsbook": "9Wickets Sportsbook",
      betconstruct: "BetConstruct",
    };
    return map[name] ?? name;
  };

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
  // Get preferences - value filters + display filters for server-side filtering
  const {
    showOnlyValue,
    evRangeMin,
    evRangeMax,
    softOddsRangeMin,
    softOddsRangeMax,
    selectedSoftProviders,
    // Display filters (moved to server-side)
    selectedProviders,
    timeFilter,
    selectedMarketTypes,
    minProviderCount,
  } = useBulkAnalysisPreferences();

  // Auth
  const { isAuthenticated, isLoading: authLoading } = useAuth();

  // User management modal state
  const [showUserManagement, setShowUserManagement] = useState(false);

  // View toggle: 'events' or 'diagnostics'
  const [activeView, setActiveView] = useState<"events" | "diagnostics">(
    "events",
  );

  // Local search state - owned here so it can be passed to both API and spreadsheet
  const [searchTerm, setSearchTerm] = useState("");

  // Debounce search for server-side API calls (300ms delay)
  const debouncedSearch = useDebouncedValue(searchTerm, 300);

  // Only send to server if search is at least 2 chars (short searches use client-side)
  const serverSearch =
    debouncedSearch.trim().length >= 2 ? debouncedSearch.trim() : "";

  // Use infinite events hook with server-side filtering
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
      // Only send providers if not all are selected (optimization)
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
  const loadedCount = activeQuery.loadedCount;
  const totalCount = activeQuery.totalCount;

  // Build stats from summary
  const stats: AdminHeaderProps["stats"] | null = summary
    ? {
        totalEvents: summary.totalEvents,
        matchedEvents: summary.matchedEvents,
      }
    : null;

  // ============================================
  // SSE-driven updates (replaces polling)
  // ============================================

  // SSE: real-time push from server when data changes
  const { isConnected: isSSEConnected } = useEventStream({
    onSyncComplete: useCallback(() => {
      // Odds sync finished — refetch to get latest value bets
      activeQuery.refetch();
    }, [activeQuery]),
    onFixturesComplete: useCallback(() => {
      // Events list changed — invalidate cache and refetch
      activeQuery.invalidateEvents();
    }, [activeQuery]),
  });

  // Fallback polling: only when SSE is disconnected
  // SSE handles the happy path; polling is the safety net
  useEffect(() => {
    if (isSSEConnected) return; // SSE is handling updates

    const pollInterval = (syncStatus?.isSyncing ?? false) ? 3000 : 30000;
    const interval = setInterval(() => {
      activeQuery.refetch();
    }, pollInterval);

    return () => clearInterval(interval);
  }, [isSSEConnected, syncStatus?.isSyncing, activeQuery]);

  const syncAbortRef = useRef<AbortController | null>(null);

  const handleSyncNow = async () => {
    // Abort any in-flight sync request to prevent duplicates
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
      // Ignore abort errors
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      console.error("Failed to trigger sync:", err);
    }
  };

  // Handle refresh complete from spreadsheet
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

  const { isImpersonating } = useAuth();

  return (
    <AppShell title="Value Bets" edgeToEdge>
      <div
        className={`flex flex-col overflow-hidden ${isImpersonating ? "pt-10" : ""}`}
        style={{ height: "calc(100vh - 3rem)" }}
      >
        <AdminHeader
          syncStatus={syncStatus}
          connectionHealth={connectionHealth}
          onSyncNow={handleSyncNow}
          isLoading={isLoading}
          isSyncing={isSyncing}
          isSSEConnected={isSSEConnected}
          stats={stats}
          onOpenUserManagement={() => setShowUserManagement(true)}
          activeView={activeView}
          onSetView={setActiveView}
        />
        <main className="flex-1 p-2 min-h-0 flex flex-col overflow-auto">
          {activeView === "diagnostics" ? (
            <div className="flex-1 min-h-0">
              <DiagnosticsTab />
            </div>
          ) : error ? (
            <ErrorBanner error={error} onRetry={() => activeQuery.refetch()} />
          ) : isLoading ? (
            <SyncStatusDisplay syncStatus={syncStatus} />
          ) : (
            <BulkResultsSpreadsheet
              events={events}
              isLoading={isLoading}
              isSyncing={isSyncing}
              onRefreshComplete={handleRefreshComplete}
              // Infinite scroll props - both hooks now return consistent shape
              hasNextPage={activeQuery.hasNextPage}
              isFetchingNextPage={activeQuery.isFetchingNextPage}
              onLoadMore={activeQuery.fetchNextPage}
              totalCount={activeQuery.totalCount}
              // Server-side search - controlled from admin page
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
          // Force a readable white-on-dark contrast. The default dark
          // theme tinted success/info/error toasts with coloured text
          // that was hard to read on the placement-panel's success ping.
          classNames: {
            toast: "!bg-neutral-900 !text-white !border-neutral-700",
            title: "!text-white",
            description: "!text-white/80",
          },
        }}
      />

      {/* User Management Modal (admin only) */}
      <UserManagementModal
        isOpen={showUserManagement}
        onClose={() => setShowUserManagement(false)}
      />
    </AppShell>
  );
}
