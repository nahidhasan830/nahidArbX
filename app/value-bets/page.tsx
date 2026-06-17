"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useDebouncedValue } from "@/components/hooks/useDebouncedValue";
import { ValueBetSpreadsheet } from "@/components/spreadsheet/ValueBetSpreadsheet";
import { useBulkAnalysisPreferences } from "@/components/hooks/useBulkAnalysisPreferences";
import { useInfiniteEvents } from "@/components/hooks/useInfiniteEvents";
import {
  PROVIDER_IDS,
  PROVIDER_REGISTRY,
  type ProviderMetadata,
  type ProviderKey,
} from "@/lib/providers/registry";
import { useEventStream } from "@/components/hooks/useEventStream";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertCircle,
  Loader2,
  Zap,
  Radio,
  Wifi,
  WifiOff,
  Server,
  Database,
  Activity,
} from "lucide-react";
import { Button } from "@/components/ui/button";

import { useAuth, Feature } from "@/components/auth/AuthProvider";
import { useProviderRuntimeState } from "@/components/hooks/useProviderRuntimeState";
import {
  useEngineHealth,
  type ConnectionHealth,
  type EngineStatus,
} from "@/components/hooks/useEngineHealth";
import { AppShell } from "@/components/nav/AppShell";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type ProviderHealthEntry = {
  status?: string;
  error?: string | null;
};

type ProviderCircuitBreaker = {
  state: string;
  failures: number;
};

type ProviderRuntimeView = {
  id: ProviderKey;
  enabled: boolean;
  connected: boolean | null;
  activeEvents: number | null;
  pendingRequests: number | null;
  status: string;
  error: string | null;
  circuitBreaker: ProviderCircuitBreaker | null;
};

function providerMeta(id: ProviderKey): ProviderMetadata {
  return PROVIDER_REGISTRY[id] as ProviderMetadata;
}

function providerStatusEntry(
  connectionHealth: ConnectionHealth | null | undefined,
  id: ProviderKey,
): ProviderHealthEntry | undefined {
  return connectionHealth?.[id] as ProviderHealthEntry | undefined;
}

function legacyActiveEvents(
  engine: EngineStatus | undefined,
  id: ProviderKey,
): number | null {
  if (!engine) return null;
  if (id === "pinnacle") return engine.pinnacleWs?.subscribedEvents ?? null;
  if (id === "ninewickets-sportsbook") {
    return engine.pollingLoops?.ninewickets ?? null;
  }
  if (id === "velki-sportsbook") return engine.pollingLoops?.velki ?? null;
  if (id === "saba-sportsbook") {
    return engine.pollingLoops?.saba ?? engine.saba?.activeEvents ?? null;
  }
  return null;
}

function legacyConnected(
  engine: EngineStatus | undefined,
  connectionHealth: ConnectionHealth | null | undefined,
  id: ProviderKey,
  activeEvents: number | null,
): boolean | null {
  if (id === "pinnacle") return engine?.pinnacleWs?.connected ?? null;
  if (id === "betconstruct") {
    return connectionHealth?.betconstruct?.connected ?? null;
  }
  if (id === "saba-sportsbook") return engine?.saba?.connected ?? null;
  if (activeEvents !== null) return activeEvents > 0;
  return null;
}

function getProviderRuntimeView(
  id: ProviderKey,
  engine: EngineStatus | undefined,
  connectionHealth: ConnectionHealth | null | undefined,
  isRuntimeEnabled?: (id: ProviderKey) => boolean,
): ProviderRuntimeView {
  const runtime = engine?.providerRuntime?.[id];
  const statusEntry = providerStatusEntry(connectionHealth, id);
  const activeEvents = runtime?.activeEvents ?? legacyActiveEvents(engine, id);
  const connected =
    runtime?.connected ??
    legacyConnected(engine, connectionHealth, id, activeEvents);
  const circuitBreaker =
    runtime?.circuitBreaker ?? engine?.circuitBreakers?.[id] ?? null;
  const error =
    runtime?.error ??
    (statusEntry?.status === "error" ? (statusEntry.error ?? "Error") : null);

  return {
    id,
    enabled: runtime?.enabled ?? isRuntimeEnabled?.(id) ?? true,
    connected,
    activeEvents,
    pendingRequests: runtime?.pendingRequests ?? null,
    status: runtime?.status ?? statusEntry?.status ?? "unknown",
    error,
    circuitBreaker,
  };
}

function providerNetworkAction(id: ProviderKey): string {
  if (id.includes("ninewickets") || id.includes("velki")) {
    return "Check Bangladesh VPN/network — this provider requires Bangladesh IP";
  }
  return "Check provider credentials and network connectivity";
}

function providerStatusText(view: ProviderRuntimeView): string {
  const meta = providerMeta(view.id);
  const cbOpen = view.circuitBreaker?.state === "open";
  const activeEvents = view.activeEvents ?? 0;
  const source = meta.integration.dataSourceLabel ?? meta.displayName;
  const unit = activeEvents === 1 ? "event" : "events";

  if (cbOpen) {
    return `${meta.displayName} circuit breaker OPEN — ${view.error ?? "fetching blocked"}. Click Reset to retry.`;
  }
  if (view.error) return `${meta.displayName} error — ${view.error}`;

  if (meta.integration.kind === "websocket") {
    if (view.connected) {
      return activeEvents > 0
        ? `${source} connected — ${activeEvents} ${unit} subscribed`
        : `${source} connected`;
    }
    return `${source} connecting…`;
  }

  if (meta.integration.kind === "managed") {
    if (view.connected) return `${meta.displayName} session active`;
    return `${meta.displayName} session connecting…`;
  }

  if (activeEvents > 0) {
    return `${source} — ${activeEvents} active ${unit}`;
  }
  if (view.connected)
    return `${source} connected — waiting for matched fixtures`;
  return `${meta.displayName} waiting for matched fixtures…`;
}

function ProviderStatusChip({
  view,
  resetting,
  onReset,
}: {
  view: ProviderRuntimeView;
  resetting: boolean;
  onReset: (providerId: ProviderKey) => void;
}) {
  const meta = providerMeta(view.id);
  const cbOpen = view.circuitBreaker?.state === "open";
  const hasError = view.status === "error" || view.error !== null;
  const activeEvents = view.activeEvents ?? 0;
  const healthy =
    !cbOpen &&
    !hasError &&
    (view.connected === true || activeEvents > 0 || view.status === "ok");
  const waiting = !cbOpen && !hasError && !healthy;
  const isWebSocket = meta.integration.kind === "websocket";
  const statusColor = cbOpen || hasError ? "red" : healthy ? "green" : "amber";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1 px-1.5 py-0.5 rounded">
          {isWebSocket ? (
            healthy ? (
              <Wifi className="w-3 h-3 text-green-500" />
            ) : (
              <WifiOff
                className={cn(
                  "w-3 h-3",
                  statusColor === "red"
                    ? "text-red-500 animate-pulse"
                    : "text-amber-400 animate-pulse",
                )}
              />
            )
          ) : (
            <span
              className={cn(
                "w-1.5 h-1.5 rounded-full",
                statusColor === "green" && "bg-green-500",
                statusColor === "red" && "bg-red-500 animate-pulse",
                statusColor === "amber" && "bg-amber-400 animate-pulse",
              )}
            />
          )}
          <span
            className={cn(
              "text-[10px] tabular-nums min-w-[3ch]",
              cbOpen || hasError ? "text-red-400" : "text-muted-foreground",
            )}
          >
            {meta.shortName}
          </span>
          {cbOpen ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onReset(view.id);
              }}
              disabled={resetting}
              className="text-[9px] px-1 py-px rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors disabled:opacity-50"
            >
              {resetting ? "…" : "Reset"}
            </button>
          ) : activeEvents > 0 ? (
            <span className="text-[10px] text-muted-foreground tabular-nums">
              ({activeEvents})
            </span>
          ) : waiting && view.pendingRequests && view.pendingRequests > 0 ? (
            <span className="text-[10px] text-muted-foreground tabular-nums">
              ({view.pendingRequests})
            </span>
          ) : null}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">{providerStatusText(view)}</TooltipContent>
    </Tooltip>
  );
}

// ============================================
// Engine Status Bar — top-right header strip
// ============================================

function EngineStatusBar({ isSSEConnected }: { isSSEConnected: boolean }) {
  const { data: connectionHealth, refetch: refetchHealth } = useEngineHealth();
  const providerRuntime = useProviderRuntimeState();
  const engine = connectionHealth?.engine as EngineStatus | undefined;
  const [resetting, setResetting] = useState<ProviderKey | null>(null);

  // Don't evaluate provider-specific indicators while provider state is loading
  // — otherwise all providers appear "enabled" before the real state arrives.
  const providerStateReady = !providerRuntime.isLoading;

  // Reset a circuit breaker via POST /api/health
  const resetCb = useCallback(
    async (providerId: ProviderKey) => {
      setResetting(providerId);
      try {
        await fetch("/api/health", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "resetCircuitBreaker",
            provider: providerId,
          }),
        });
        // Refetch health so the UI updates immediately
        await refetchHealth();
      } catch {
        // silent — next 5s poll will pick it up
      } finally {
        setResetting(null);
      }
    },
    [refetchHealth],
  );

  const providerViews = providerStateReady
    ? PROVIDER_IDS.map((id) =>
        getProviderRuntimeView(
          id,
          engine,
          connectionHealth,
          providerRuntime.isEnabled,
        ),
      ).filter(
        (view) =>
          view.enabled &&
          providerMeta(view.id).integration.contributesToDataHealth !== false,
      )
    : [];

  // Reactive detector
  const detectorRunning = engine?.detector?.running ?? false;
  const detectorPasses = engine?.detector?.totalPasses ?? 0;
  const detectorAvgMs = engine?.detector?.avgPassDurationMs ?? 0;

  // Matched events
  const matchedCount = engine?.matchedCount ?? 0;
  const totalEvents = engine?.totalEvents ?? 0;
  const firstSyncDone = engine?.firstSyncComplete ?? false;
  // Show red if no matches after first sync (indicates data pipeline broken)
  const matchedDegraded =
    firstSyncDone && totalEvents > 0 && matchedCount === 0;

  // While engine data hasn't arrived yet, show minimal "starting" state
  if (!connectionHealth) {
    return (
      <Feature id="health-status">
        <div className="flex items-center gap-1">
          <div className="flex items-center gap-1 px-1.5 py-0.5 rounded">
            <Loader2 className="w-3 h-3 text-muted-foreground animate-spin" />
            <span className="text-[10px] text-muted-foreground">Starting…</span>
          </div>
        </div>
      </Feature>
    );
  }

  return (
    <Feature id="health-status">
      <div className="flex items-center gap-1">
        {/* SSE Live Stream */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded">
              <Radio
                className={cn(
                  "w-3 h-3",
                  isSSEConnected
                    ? "text-green-500"
                    : "text-red-500 animate-pulse",
                )}
              />
              <span className="text-[10px] text-muted-foreground">
                {isSSEConnected ? "Live" : "Polling"}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {isSSEConnected
              ? "Live stream connected — updates pushed in real-time"
              : "Live stream disconnected — falling back to periodic polling"}
          </TooltipContent>
        </Tooltip>

        <Separator />

        {providerViews.map((view) => (
          <ProviderStatusChip
            key={view.id}
            view={view}
            resetting={resetting === view.id}
            onReset={resetCb}
          />
        ))}

        <Separator />

        {/* Reactive Detector */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded">
              <Zap
                className={cn(
                  "w-3 h-3",
                  detectorRunning
                    ? "text-green-500"
                    : "text-muted-foreground/40",
                )}
              />
              <span className="text-[10px] text-muted-foreground">
                {detectorRunning ? "Active" : "Off"}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {detectorRunning
              ? `Value detection engine active — ${detectorPasses} scans completed, avg ${detectorAvgMs}ms each`
              : "Value detection engine not yet started — waiting for initial data"}
          </TooltipContent>
        </Tooltip>

        {/* Matched Events — show after first sync; red warning when 0 matched */}
        {firstSyncDone && (
          <>
            <Separator />
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-1 px-1.5 py-0.5 rounded">
                  <Database
                    className={cn(
                      "w-3 h-3",
                      matchedDegraded
                        ? "text-red-500 animate-pulse"
                        : matchedCount > 0
                          ? "text-green-500"
                          : "text-muted-foreground/40",
                    )}
                  />
                  <span
                    className={cn(
                      "text-[10px] tabular-nums",
                      matchedDegraded
                        ? "text-red-400"
                        : "text-muted-foreground",
                    )}
                  >
                    {matchedCount}/{totalEvents}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {matchedDegraded
                  ? `No matched events — ${totalEvents} events loaded, no cross-provider odds available. Check enabled soft-provider connections.`
                  : `${matchedCount} of ${totalEvents} events matched across multiple providers`}
              </TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    </Feature>
  );
}

function Separator() {
  return <div className="w-px h-4 bg-border shrink-0" />;
}

// ============================================
// Smart Boot Indicator — shows real backend state
// ============================================

function EngineBootStatus() {
  const { data: connectionHealth, isLoading: isHealthLoading } =
    useEngineHealth();
  const engine = connectionHealth?.engine as EngineStatus | undefined;
  const [elapsedSec, setElapsedSec] = useState(0);

  // Tick elapsed time every second during boot
  useEffect(() => {
    const interval = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const elapsed = elapsedSec > 0 ? `${elapsedSec}s` : "";

  // Determine boot stage from engine telemetry
  const providerViews = engine
    ? PROVIDER_IDS.map((id) =>
        getProviderRuntimeView(id, engine, connectionHealth),
      ).filter(
        (view) =>
          view.enabled &&
          providerMeta(view.id).integration.contributesToDataHealth !== false,
      )
    : [];
  const activeProviderViews = providerViews.filter(
    (view) =>
      view.connected === true ||
      (view.activeEvents ?? 0) > 0 ||
      view.status === "ok",
  );
  const hasActiveDataSource = activeProviderViews.length > 0;
  const detectorRunning = engine?.detector?.running ?? false;
  const totalPasses = engine?.detector?.totalPasses ?? 0;

  let stage: {
    icon: React.ReactNode;
    title: string;
    subtitle: string;
    detail?: string;
  };

  if (isHealthLoading || !connectionHealth) {
    stage = {
      icon: <Server className="w-6 h-6 text-muted-foreground animate-pulse" />,
      title: "Connecting to server",
      subtitle: "Establishing connection…",
    };
  } else if (!engine) {
    stage = {
      icon: <Server className="w-6 h-6 text-primary animate-pulse" />,
      title: "Server initializing",
      subtitle: "Starting sync services and data sources",
      detail: elapsed,
    };
  } else if (!hasActiveDataSource) {
    stage = {
      icon: <Database className="w-6 h-6 text-primary animate-pulse" />,
      title: "Fetching fixtures",
      subtitle:
        "Pulling events from all providers and matching across sportsbooks",
      detail: `This usually takes 1–2 minutes · ${elapsed}`,
    };
  } else if (!detectorRunning) {
    const sources = activeProviderViews.map((view) => {
      const activeEvents = view.activeEvents ?? 0;
      if (activeEvents > 0) {
        return `${providerMeta(view.id).shortName} (${activeEvents})`;
      }
      return providerMeta(view.id).shortName;
    });
    stage = {
      icon: <Activity className="w-6 h-6 text-amber-400 animate-pulse" />,
      title: "Starting reactive detector",
      subtitle:
        sources.length > 0
          ? `Connected: ${sources.join(", ")}`
          : "Data sources connecting…",
      detail: elapsed,
    };
  } else if (totalPasses === 0) {
    stage = {
      icon: <Zap className="w-6 h-6 text-amber-400 animate-pulse" />,
      title: "Engine ready — awaiting first odds",
      subtitle: "Detector running, processing incoming data",
      detail: elapsed,
    };
  } else {
    // totalPasses > 0 but events haven't arrived yet in the query
    stage = {
      icon: <Loader2 className="w-6 h-6 text-primary animate-spin" />,
      title: "Loading events",
      subtitle: `${totalPasses} detection passes completed`,
    };
  }

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-3 max-w-sm">
        <div className="mx-auto w-fit">{stage.icon}</div>
        <p className="text-sm font-medium text-foreground">{stage.title}</p>
        <p className="text-xs text-muted-foreground/80">{stage.subtitle}</p>
        {stage.detail && (
          <p className="text-[10px] text-muted-foreground/50 tabular-nums">
            {stage.detail}
          </p>
        )}

        {/* Mini subsystem dots during boot */}
        {connectionHealth && engine && (
          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            {providerViews.map((view) => {
              const activeEvents = view.activeEvents ?? 0;
              const ok =
                view.connected === true ||
                activeEvents > 0 ||
                view.status === "ok";
              const detail =
                activeEvents > 0
                  ? `${activeEvents} events`
                  : ok
                    ? "active"
                    : "waiting";
              return (
                <SubsystemDot
                  key={view.id}
                  label={providerMeta(view.id).shortName}
                  ok={ok}
                  detail={detail}
                />
              );
            })}
            <SubsystemDot
              label="Detector"
              ok={detectorRunning}
              detail={detectorRunning ? `${totalPasses} passes` : "starting"}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function SubsystemDot({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean;
  detail: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1">
          <span
            className={cn(
              "w-1.5 h-1.5 rounded-full",
              ok ? "bg-green-500" : "bg-amber-400 animate-pulse",
            )}
          />
          <span className="text-[9px] text-muted-foreground">{label}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label}: {detail}
      </TooltipContent>
    </Tooltip>
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
  } = useBulkAnalysisPreferences();

  const { isImpersonating } = useAuth();
  const [searchTerm, setSearchTerm] = useState("");

  const debouncedSearch = useDebouncedValue(searchTerm, 300);
  const serverSearch =
    debouncedSearch.trim().length >= 2 ? debouncedSearch.trim() : "";

  const infiniteQuery = useInfiniteEvents({
    search: serverSearch,
    pageSize: 50,
    valueFilters: {
      showOnlyValue,
      evRangeMin,
      evRangeMax,
      softOddsMin: softOddsRangeMin,
      softOddsMax: softOddsRangeMax,
      softProviders: Array.from(selectedSoftProviders),
    },
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
    },
  });

  const activeQuery = infiniteQuery;
  const events = activeQuery.events;
  const summary = activeQuery.summary;
  const isQueryLoading = activeQuery.isLoading;
  const queryError = activeQuery.error;

  // Engine health is polled independently (5s) via useEngineHealth inside
  // EngineStatusBar and EngineBootStatus — no longer coupled to event data.
  const { data: engineHealth } = useEngineHealth();
  const engineReady = (engineHealth?.engine as EngineStatus | undefined)
    ?.detector?.totalPasses
    ? (engineHealth?.engine as EngineStatus | undefined)!.detector.totalPasses >
      0
    : false;

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

  // Fallback polling when SSE is disconnected
  useEffect(() => {
    if (isSSEConnected) return;
    const pollInterval = 30000;
    const interval = setInterval(() => {
      activeQuery.refetch();
    }, pollInterval);
    return () => clearInterval(interval);
  }, [isSSEConnected, activeQuery]);

  const handleRefreshComplete = useCallback(() => {
    activeQuery.refetch();
  }, [activeQuery]);

  // Show boot indicator while query is loading AND engine hasn't completed
  // its first detection pass. After that, show the spreadsheet (possibly empty).
  const isBooting = isQueryLoading && events.length === 0 && !engineReady;

  // Engine is "warming" when the server hasn't finished its first data sync —
  // prevents misleading "no events match filters" during startup.
  const engineStatus = engineHealth?.engine as EngineStatus | undefined;
  const isEngineWarming = (() => {
    if (!engineStatus) return false;
    if (events.length > 0) return false;
    // First sync hasn't finished yet — still pulling fixtures
    if (!engineStatus.firstSyncComplete) return true;
    return false;
  })();

  // Degraded providers: circuit breaker open or provider status=error.
  // This tells the spreadsheet empty state WHY there's no data.
  const degradedProviders = useMemo(() => {
    if (!engineStatus || !engineHealth) return [];
    const result: {
      id: string;
      label: string;
      reason: string;
      action: string;
    }[] = [];
    for (const id of PROVIDER_IDS) {
      const view = getProviderRuntimeView(id, engineStatus, engineHealth);
      if (!view.enabled) continue;

      if (view.circuitBreaker?.state === "open") {
        result.push({
          id,
          label: providerMeta(id).displayName,
          reason: view.error ?? "Too many consecutive failures",
          action: providerNetworkAction(id),
        });
      } else if (view.status === "error" && view.error) {
        result.push({
          id,
          label: providerMeta(id).displayName,
          reason: view.error,
          action: "Check engine logs for details",
        });
      }
    }
    return result;
  }, [engineStatus, engineHealth]);

  const resetCircuitBreaker = useCallback(async (providerId: string) => {
    await fetch("/api/health", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "resetCircuitBreaker",
        provider: providerId,
      }),
    });
  }, []);

  const error = queryError
    ? queryError instanceof Error
      ? queryError.message
      : "Unknown error"
    : null;

  // Right-side header actions — engine status bar + event count
  const actions = (
    <>
      <EngineStatusBar isSSEConnected={isSSEConnected} />
      {isQueryLoading && !stats ? (
        <span className="text-[11px] text-muted-foreground tabular-nums min-w-[14ch] text-right flex items-center gap-1.5">
          <Skeleton className="h-3.5 w-8 rounded" />
          <span className="opacity-50">matched ·</span>
          <Skeleton className="h-3.5 w-6 rounded" />
          <span className="opacity-50">total</span>
        </span>
      ) : (
        <span className="text-[11px] text-muted-foreground tabular-nums min-w-[14ch] text-right">
          <span className="font-medium text-foreground">
            {stats?.matchedEvents ?? 0}
          </span>{" "}
          matched · {stats?.totalEvents ?? 0} total
        </span>
      )}
    </>
  );

  return (
    <AppShell title="Value Bets" actions={actions} edgeToEdge>
      <div
        className={`flex flex-col overflow-hidden ${isImpersonating ? "pt-10" : ""}`}
        style={{ height: "calc(100vh - 3rem)" }}
      >
        <main className="flex-1 p-2 min-h-0 flex flex-col overflow-auto">
          {error ? (
            <ErrorBanner error={error} onRetry={() => activeQuery.refetch()} />
          ) : isBooting ? (
            <EngineBootStatus />
          ) : (
            <ValueBetSpreadsheet
              events={events}
              isLoading={isQueryLoading && events.length === 0}
              isEngineWarming={isEngineWarming}
              degradedProviders={degradedProviders}
              onResetCircuitBreaker={resetCircuitBreaker}
              onRefreshComplete={handleRefreshComplete}
              hasNextPage={activeQuery.hasNextPage}
              isFetchingNextPage={activeQuery.isFetchingNextPage}
              onLoadMore={activeQuery.fetchNextPage}
              totalCount={activeQuery.totalCount}
              totalValueBetCount={summary?.totalValueBets}
              searchTerm={searchTerm}
              onSearchChange={setSearchTerm}
            />
          )}
        </main>
      </div>
    </AppShell>
  );
}
