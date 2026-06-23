"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RadioReceiver, RefreshCw } from "lucide-react";
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
import { OverviewTab, type StatsData, type HealthData } from "./OverviewTab";
import { useAiProviders } from "./useAiProviders";


const POLL_MS = 3_000;


export default function AiSearchDashboard() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);
  const [initialLoad, setInitialLoad] = useState(true);

  const {
    providers,
    searchProviders,
    llmProviders,
    isLoading,
    refresh,
    toggleProvider,
    isToggling,
    error: providerError,
  } = useAiProviders({ pollMs: POLL_MS });

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
    setIsRefreshing(true);
    try {
      await Promise.all([refresh(), loadHealth()]);
    } finally {
      setLastLoadedAt(new Date().toISOString());
      setInitialLoad(false);
      setIsRefreshing(false);
    }
  }, [refresh, loadHealth]);

  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    void load();
  }, [load]);

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

  const [toggleBusySet, llmToggleBusySet] = (() => {
    const search = new Set<string>();
    const llm = new Set<string>();
    for (const p of providers) {
      const uiName = p.name.startsWith("deepseek")
        ? "deepseek"
        : p.name.startsWith("gemini")
          ? "gemini"
          : p.name;
      if (isToggling(uiName)) {
        if (p.engineType === "search") search.add(uiName);
        else llm.add(uiName);
      }
    }
    return [search, llm];
  })();

  const hasLoadedProviderState = !isLoading || searchProviders.length > 0;
  const statsData: StatsData | null = hasLoadedProviderState
    ? {
        providers: searchProviders.map((p) => ({
          name: p.name,
          healthy: p.enabled,
          enabled: p.enabled,
          requestsUsed: p.monthlyUsageCount,
          quotaLimit: p.monthlyLimit,
          quotaRemaining: p.monthlyRemaining,
          quotaSource:
            p.monthlyLimit !== null ? ("live" as const) : ("none" as const),
          lastError: p.disabledReason,
          lastUsedAt: null,
        })),
        totalSearches: searchProviders.reduce(
          (sum, p) => sum + p.monthlyUsageCount,
          0,
        ),
        llmEngine: "deepseek-v4-flash",
        llmHealthy: true,
      }
    : null;

  const llmStats =
    llmProviders.length > 0
      ? {
          usage: {
            active_engine: llmProviders.some((p) => p.enabled)
              ? "deepseek"
              : "none",
            providers: Object.fromEntries(
              ["deepseek", "gemini"].flatMap((family) => {
                const familyProviders = llmProviders.filter((p) =>
                  family === "deepseek"
                    ? p.name.startsWith("deepseek")
                    : p.name.startsWith("gemini"),
                );
                const representative =
                  familyProviders.find((p) => p.name === `${family}-lite`) ??
                  familyProviders[0];
                if (!representative) return [];
                return [
                  [
                    family,
                    {
                      model: representative.modelId,
                      healthy: representative.enabled,
                      disabled: !representative.enabled,
                      monthlyUsage: representative.monthlyUsageCount,
                      monthlyLimit: representative.monthlyLimit,
                    },
                  ],
                ];
              }),
            ),
          },
        }
      : null;

  const serviceOnline =
    health?.status === "ok" || health?.status === "degraded";

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
              "h-6 gap-1.5 rounded-md border px-2 text-[11px] font-semibold tracking-normal backdrop-blur-sm transition-all duration-300",
              serviceBadge.loading
                ? "border-border/35 bg-muted/20 text-muted-foreground animate-pulse"
                : serviceBadge.online
                  ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
                  : "border-red-500/20 bg-red-500/10 text-red-300",
            )}
          >
            <span className="relative flex size-3 items-center justify-center">
              {serviceBadge.online && (
                <span className="absolute inline-flex size-2 rounded-full bg-emerald-400 opacity-70 motion-safe:animate-ping" />
              )}
              <RadioReceiver
                className={cn(
                  "size-3",
                  serviceBadge.loading && "animate-pulse",
                  serviceBadge.online ? "text-emerald-300" : "text-red-300",
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
            error={providerError}
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
