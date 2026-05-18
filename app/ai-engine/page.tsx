"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  RadioReceiver,
  RefreshCw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { AppShell } from "@/components/nav/AppShell";
import {
  OverviewTab,
  formatApiError,
  type StatsData,
  type HealthData,
} from "./OverviewTab";
import { useAiProviders, type AiProvider } from "./useAiProviders";

// ── Constants ────────────────────────────────────────────────────────────

const POLL_MS = 3_000;

// ── Page ────────────────────────────────────────────────────────

export default function AiSearchDashboard() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);
  const [initialLoad, setInitialLoad] = useState(true);

  // Use unified provider hook
  const {
    providers,
    searchProviders,
    llmProviders,
    isLoading,
    refresh,
    toggleProvider,
    isToggling,
  } = useAiProviders({ pollMs: POLL_MS });

  // Health check (separate since different endpoint)
  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/ai-engine/healthz", { cache: "no-store" });
      const data = await res.json().catch(() => ({ status: "offline" }));
      setHealth(data);
    } catch {
      setHealth(null);
    }
  }, []);

  const load = useCallback(async () => {
    setError(null);
    setIsRefreshing(true);
    try {
      await Promise.all([refresh(), loadHealth()]);
    } finally {
      setLastLoadedAt(new Date().toISOString());
      setInitialLoad(false);
      setIsRefreshing(false);
    }
  }, [refresh, loadHealth]);

  // Initial load — fire once after mount, then let polling via useAiProviders handle refreshes
  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    void load();
  }, [load]);

  // Combined toggle handler - just call the hook, it handles everything including refresh
  const handleToggleProvider = useCallback(
    async (providerName: string, enabled: boolean) => {
      await toggleProvider(providerName, enabled);
    },
    [toggleProvider],
  );

  const handleToggleLlmEngine = useCallback(
    async (engineName: string, enabled: boolean) => {
      await toggleProvider(engineName, enabled);
    },
    [toggleProvider],
  );

  // Derive toggle busy sets from the hook's internal state
  const [toggleBusySet, llmToggleBusySet] = (() => {
    const search = new Set<string>();
    const llm = new Set<string>();
    for (const p of providers) {
      // toggleBusy stores UI names ("deepseek"/"gemini"), not DB names ("deepseek-flash")
      const uiName = p.name.startsWith("deepseek") ? "deepseek" :
                     p.name.startsWith("gemini") ? "gemini" : p.name;
      if (isToggling(uiName)) {
        if (p.engineType === "search") search.add(uiName);
        else llm.add(uiName);
      }
    }
    return [search, llm];
  })();

  // Convert hook data to StatsData format for OverviewTab
  const statsData: StatsData | null = searchProviders.length > 0
    ? {
        providers: searchProviders.map(p => ({
          name: p.name,
          healthy: p.enabled,
          enabled: p.enabled,
          requestsUsed: p.monthlyUsageCount,
          quotaLimit: p.monthlyLimit,
          quotaRemaining: p.monthlyRemaining,
          quotaSource: p.monthlyLimit !== null ? "live" as const : "none" as const,
          lastError: p.disabledReason,
          lastUsedAt: null,
        })),
        totalSearches: searchProviders.reduce((sum, p) => sum + p.monthlyUsageCount, 0),
        llmEngine: "deepseek-v4-flash",
        llmHealthy: true,
      }
    : null;

  const llmStats = llmProviders.length > 0
    ? {
        usage: {
          active_engine: llmProviders.some(p => p.enabled) ? "deepseek" : "none",
          providers: Object.fromEntries(
            ["deepseek", "gemini"].flatMap(family => {
              const familyProviders = llmProviders.filter(p =>
                family === "deepseek" ? p.name.startsWith("deepseek") : p.name.startsWith("gemini")
              );
              // Use the -lite variant as the representative (matches toggle mapping in useAiProviders)
              const representative = familyProviders.find(p => p.name === `${family}-lite`) ?? familyProviders[0];
              if (!representative) return [];
              return [[family, {
                model: representative.modelId,
                healthy: representative.enabled,
                disabled: !representative.enabled,
                monthlyUsage: representative.monthlyUsageCount,
                monthlyLimit: representative.monthlyLimit,
              }]];
            })
          ),
        }
      }
    : null;

  const serviceOnline = health?.status === "ok" || health?.status === "degraded";

  const serviceBadge = initialLoad
    ? { label: "loading...", online: false, loading: true }
    : {
        label: serviceOnline ? "online" : "offline",
        online: serviceOnline,
        loading: false,
      };

  return (
    <TooltipProvider delayDuration={200}>
      <AppShell
        title="AI Engine"
        titleBadge={
          <Badge
            variant="secondary"
            className={cn(
              "text-[10px] font-medium tracking-wider px-2.5 py-0.5 backdrop-blur-sm transition-all duration-500",
              serviceBadge.loading
                ? "bg-muted/20 text-muted-foreground border-border/30 animate-pulse"
                : serviceBadge.online
                  ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/25 shadow-[0_0_10px_rgba(16,185,129,0.15)]"
                  : "bg-red-500/10 text-red-400 border-red-500/20",
            )}
          >
            <span className="relative flex size-2 mr-1.5">
              {serviceBadge.online && (
                <span className="absolute inline-flex size-full rounded-full opacity-75 animate-ping bg-emerald-400" />
              )}
              <RadioReceiver
                className={cn(
                  "w-2.5 h-2.5",
                  serviceBadge.loading && "animate-pulse",
                  serviceBadge.online ? "text-emerald-400" : "text-red-400",
                )}
              />
            </span>
            {serviceBadge.label}
          </Badge>
        }
        actions={
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={load}
                disabled={isRefreshing}
              >
                <RefreshCw
                  className={cn("w-3.5 h-3.5", isRefreshing && "animate-spin")}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh live AI search status</TooltipContent>
          </Tooltip>
        }
        edgeToEdge
      >
        <div className="flex flex-col flex-1 min-h-0 overflow-y-auto bg-background/30 backdrop-blur-sm">
          <OverviewTab
            stats={statsData}
            health={health}
            error={error}
            isRefreshing={isRefreshing}
            lastLoadedAt={lastLoadedAt}
            onToggleProvider={handleToggleProvider}
            toggleBusy={toggleBusySet}
            llmStats={llmStats}
            onToggleLlmEngine={handleToggleLlmEngine}
            llmToggleBusy={llmToggleBusySet}
          />
        </div>
      </AppShell>
    </TooltipProvider>
  );
}