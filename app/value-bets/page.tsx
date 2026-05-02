"use client";

import { useState, useEffect, useCallback } from "react";
import { useDebouncedValue } from "@/components/hooks/useDebouncedValue";
import { ValueBetSpreadsheet } from "@/components/spreadsheet/ValueBetSpreadsheet";
import { useBulkAnalysisPreferences } from "@/components/hooks/useBulkAnalysisPreferences";
import { useInfiniteEvents } from "@/components/hooks/useInfiniteEvents";
import { PROVIDER_IDS } from "@/lib/providers/registry";
import { useEventStream } from "@/components/hooks/useEventStream";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, Loader2, Zap, Radio, Wifi, WifiOff, Server, Database, Activity } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Toaster } from "sonner";
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

// ============================================
// Engine Status Bar — top-right header strip
// ============================================

function EngineStatusBar({
  isSSEConnected,
}: {
  isSSEConnected: boolean;
}) {
  const { data: connectionHealth } = useEngineHealth();
  const providerRuntime = useProviderRuntimeState();
  const engine = connectionHealth?.engine as EngineStatus | undefined;

  // Pinnacle WS status
  const pinnacleEnabled = providerRuntime.isLoading || providerRuntime.isEnabled("pinnacle");
  const wsConnected = engine?.pinnacleWs?.connected ?? false;
  const wsEvents = engine?.pinnacleWs?.subscribedEvents ?? 0;

  // 9W/Velki polling loop counts
  const nwEnabled = providerRuntime.isLoading || providerRuntime.isEnabled("ninewickets-sportsbook");
  const velkiEnabled = providerRuntime.isLoading || providerRuntime.isEnabled("velki-sportsbook");
  const nwLoops = engine?.pollingLoops?.ninewickets ?? 0;
  const velkiLoops = engine?.pollingLoops?.velki ?? 0;

  // BetConstruct session health
  const bcEnabled = providerRuntime.isLoading || providerRuntime.isEnabled("betconstruct");
  const bcConnected = connectionHealth?.betconstruct?.connected ?? false;

  // Reactive detector
  const detectorRunning = engine?.detector?.running ?? false;
  const detectorPasses = engine?.detector?.totalPasses ?? 0;
  const detectorAvgMs = engine?.detector?.avgPassDurationMs ?? 0;

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
                  isSSEConnected ? "text-green-500" : "text-red-500 animate-pulse"
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

        {/* Pinnacle WebSocket */}
        {pinnacleEnabled && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1 px-1.5 py-0.5 rounded">
                {wsConnected ? (
                  <Wifi className="w-3 h-3 text-green-500" />
                ) : (
                  <WifiOff className="w-3 h-3 text-amber-400 animate-pulse" />
                )}
                <span className="text-[10px] text-muted-foreground tabular-nums min-w-[3ch]">PIN</span>
                {wsConnected && <span className="text-[10px] text-muted-foreground tabular-nums">({wsEvents})</span>}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {wsConnected
                ? `Pinnacle WebSocket connected — ${wsEvents} events subscribed`
                : "Pinnacle WebSocket connecting…"}
            </TooltipContent>
          </Tooltip>
        )}

        {/* BetConstruct */}
        {bcEnabled && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1 px-1.5 py-0.5 rounded">
                <span
                  className={cn(
                    "w-1.5 h-1.5 rounded-full",
                    bcConnected ? "bg-green-500" : "bg-amber-400 animate-pulse"
                  )}
                />
                <span className="text-[10px] text-muted-foreground">BC</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {bcConnected
                ? "BetConstruct session active"
                : "BetConstruct session connecting…"}
            </TooltipContent>
          </Tooltip>
        )}

        {/* 9W Polling */}
        {nwEnabled && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1 px-1.5 py-0.5 rounded">
                <span
                  className={cn(
                    "w-1.5 h-1.5 rounded-full",
                    nwLoops > 0 ? "bg-green-500" : "bg-amber-400 animate-pulse"
                  )}
                />
                <span className="text-[10px] text-muted-foreground tabular-nums min-w-[3ch]">9W</span>
                {nwLoops > 0 && <span className="text-[10px] text-muted-foreground tabular-nums">({nwLoops})</span>}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {nwLoops > 0
                ? `NineWickets polling — ${nwLoops} active loops (1.5s interval)`
                : "NineWickets waiting for matched fixtures…"}
            </TooltipContent>
          </Tooltip>
        )}

        {/* Velki Polling */}
        {velkiEnabled && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1 px-1.5 py-0.5 rounded">
                <span
                  className={cn(
                    "w-1.5 h-1.5 rounded-full",
                    velkiLoops > 0 ? "bg-green-500" : "bg-amber-400 animate-pulse"
                  )}
                />
                <span className="text-[10px] text-muted-foreground tabular-nums min-w-[3ch]">VK</span>
                {velkiLoops > 0 && <span className="text-[10px] text-muted-foreground tabular-nums">({velkiLoops})</span>}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {velkiLoops > 0
                ? `Velki polling — ${velkiLoops} active loops (1.5s interval)`
                : "Velki waiting for matched fixtures…"}
            </TooltipContent>
          </Tooltip>
        )}

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
                    : "text-muted-foreground/40"
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
  const { data: connectionHealth, isLoading: isHealthLoading } = useEngineHealth();
  const engine = connectionHealth?.engine as EngineStatus | undefined;
  const [elapsedSec, setElapsedSec] = useState(0);

  // Tick elapsed time every second during boot
  useEffect(() => {
    const interval = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const elapsed = elapsedSec > 0 ? `${elapsedSec}s` : "";

  // Determine boot stage from engine telemetry
  const wsConnected = engine?.pinnacleWs?.connected ?? false;
  const wsEvents = engine?.pinnacleWs?.subscribedEvents ?? 0;
  const nwLoops = engine?.pollingLoops?.ninewickets ?? 0;
  const velkiLoops = engine?.pollingLoops?.velki ?? 0;
  const detectorRunning = engine?.detector?.running ?? false;
  const totalPasses = engine?.detector?.totalPasses ?? 0;

  let stage: { icon: React.ReactNode; title: string; subtitle: string; detail?: string };

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
  } else if (!wsConnected && wsEvents === 0 && nwLoops === 0 && velkiLoops === 0) {
    stage = {
      icon: <Database className="w-6 h-6 text-primary animate-pulse" />,
      title: "Fetching fixtures",
      subtitle: "Pulling events from all providers and matching across sportsbooks",
      detail: `This usually takes 1–2 minutes · ${elapsed}`,
    };
  } else if (!detectorRunning) {
    const sources: string[] = [];
    if (wsConnected) sources.push(`WS (${wsEvents} events)`);
    if (nwLoops > 0) sources.push(`9W (${nwLoops} loops)`);
    if (velkiLoops > 0) sources.push(`VK (${velkiLoops} loops)`);
    stage = {
      icon: <Activity className="w-6 h-6 text-amber-400 animate-pulse" />,
      title: "Starting reactive detector",
      subtitle: sources.length > 0
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
          <p className="text-[10px] text-muted-foreground/50 tabular-nums">{stage.detail}</p>
        )}

        {/* Mini subsystem dots during boot */}
        {connectionHealth && engine && (
          <div className="flex items-center justify-center gap-3 pt-2">
            <SubsystemDot
              label="WS"
              ok={wsConnected}
              detail={wsConnected ? `${wsEvents} events` : "connecting"}
            />
            <SubsystemDot
              label="BC"
              ok={connectionHealth.betconstruct?.connected ?? false}
              detail={connectionHealth.betconstruct?.connected ? "active" : "connecting"}
            />
            <SubsystemDot
              label="9W"
              ok={nwLoops > 0}
              detail={nwLoops > 0 ? `${nwLoops} loops` : "waiting"}
            />
            <SubsystemDot
              label="VK"
              ok={velkiLoops > 0}
              detail={velkiLoops > 0 ? `${velkiLoops} loops` : "waiting"}
            />
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
              ok ? "bg-green-500" : "bg-amber-400 animate-pulse"
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
  const engineReady = (engineHealth?.engine as EngineStatus | undefined)?.detector?.totalPasses
    ? (engineHealth?.engine as EngineStatus | undefined)!.detector.totalPasses > 0
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
    // At least one enabled source hasn't come online
    const wsUp = engineStatus.pinnacleWs?.connected;
    const nwUp = (engineStatus.pollingLoops?.ninewickets ?? 0) > 0;
    const vkUp = (engineStatus.pollingLoops?.velki ?? 0) > 0;
    return !wsUp || !nwUp || !vkUp;
  })();

  const error = queryError
    ? queryError instanceof Error
      ? queryError.message
      : "Unknown error"
    : null;

  // Right-side header actions — engine status bar + event count
  const actions = (
    <>
      <EngineStatusBar isSSEConnected={isSSEConnected} />
      <span className="text-[11px] text-muted-foreground tabular-nums min-w-[14ch] text-right">
        <span className="font-medium text-foreground">
          {stats?.matchedEvents ?? 0}
        </span>{" "}
        matched · {stats?.totalEvents ?? 0} total
      </span>
    </>
  );

  return (
    <AppShell
      title="Value Bets"
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
          ) : isBooting ? (
            <EngineBootStatus />
          ) : (
            <ValueBetSpreadsheet
              events={events}
              isLoading={isQueryLoading && events.length === 0}
              isEngineWarming={isEngineWarming}
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
