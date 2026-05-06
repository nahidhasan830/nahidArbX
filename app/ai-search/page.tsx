"use client";

/**
 * AI Search dashboard — tabbed layout with Overview (monitoring) and
 * Playground (interactive testing).
 *
 * Polls /api/ai-search/stats, /api/ai-search/healthz, and
 * /api/ai-search/llm-stats every 3 s.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { FlaskConical, LayoutDashboard, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import { TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { AppShell } from "@/components/nav/AppShell";
import {
  OverviewTab,
  deriveModelStatus,
  formatApiError,
  type StatsData,
  type HealthData,
  type LlmStatsData,
} from "./OverviewTab";
import { PlaygroundTab } from "./PlaygroundTab";

// ── Constants ────────────────────────────────────────────────────

const POLL_MS = 3_000;

interface ModelsData {
  models?: { name: string; size: number; modified_at: string }[];
  model?: string;
  engine?: string;
  default?: string;
  configured_model?: string;
}

// ── Page ─────────────────────────────────────────────────────────

export default function AiSearchDashboard() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [llmStats, setLlmStats] = useState<LlmStatsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);
  // True until the first load() resolves — prevents false "offline" flash
  const [initialLoad, setInitialLoad] = useState(true);

  // Models
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");

  // Provider toggle busy set
  const [toggleBusy, setToggleBusy] = useState<Set<string>>(() => new Set());

  const loadRef = useRef(false);

  const readJson = async <T,>(url: string): Promise<T> => {
    const res = await fetch(url, { cache: "no-store" });
    const body = await res
      .json()
      .catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) throw new Error(formatApiError(body, `HTTP ${res.status}`));
    return body as T;
  };

  const load = useCallback(async () => {
    if (loadRef.current) return;
    loadRef.current = true;
    setIsRefreshing(true);
    setError(null);

    try {
      const [statsResult, healthResult, limitsResult] = await Promise.allSettled([
        readJson<StatsData>("/api/ai-search/stats"),
        readJson<HealthData>("/api/ai-search/healthz"),
        readJson<LlmStatsData>("/api/ai-search/llm-stats"),
      ]);

      const messages: string[] = [];
      if (statsResult.status === "fulfilled") setStats(statsResult.value);
      else { setStats(null); messages.push(`stats: ${statsResult.reason}`); }

      if (healthResult.status === "fulfilled") setHealth(healthResult.value);
      else { setHealth(null); messages.push(`health: ${healthResult.reason}`); }

      if (limitsResult.status === "fulfilled") setLlmStats(limitsResult.value);
      else setLlmStats(null);

      if (messages.length) setError(messages.join(" · "));
      setLastLoadedAt(new Date().toISOString());
    } finally {
      setIsRefreshing(false);
      setInitialLoad(false);
      loadRef.current = false;
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // Fetch available models once
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/ai-search/models", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as ModelsData;
        // Handle both array-of-models and single-model responses
        if (data.models && Array.isArray(data.models)) {
          const names = data.models.map((m) => m.name).filter(Boolean);
          setAvailableModels(names);
          if (!selectedModel) setSelectedModel(data.configured_model || data.default || names[0] || "");
        } else if (data.model) {
          // Groq single-model response
          setAvailableModels([data.model]);
          if (!selectedModel) setSelectedModel(data.model);
        }
      } catch { /* non-fatal */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggleProvider = useCallback(
    async (providerName: string, enabled: boolean) => {
      setStats((prev) =>
        prev ? { ...prev, providers: prev.providers.map((p) => p.name === providerName ? { ...p, enabled } : p) } : prev,
      );
      setToggleBusy((prev) => new Set(prev).add(providerName));
      try {
        const res = await fetch(`/api/ai-search/providers/${providerName}/toggle`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        void load();
      } catch {
        setStats((prev) =>
          prev ? { ...prev, providers: prev.providers.map((p) => p.name === providerName ? { ...p, enabled: !enabled } : p) } : prev,
        );
      } finally {
        setToggleBusy((prev) => { const next = new Set(prev); next.delete(providerName); return next; });
      }
    },
    [load],
  );

  const modelStatus = deriveModelStatus(health, stats, lastLoadedAt);
  const serviceOnline = Boolean(health?.status === "ok" || health?.status === "degraded");
  const hfAvailable = Boolean((stats as Record<string, unknown> | null)?.hf_available);

  // During initial load, show a neutral loading badge instead of false "offline"
  const serviceBadge = initialLoad
    ? { label: "loading…", online: false, loading: true }
    : { label: serviceOnline ? "service online" : "service offline", online: serviceOnline, loading: false };

  return (
    <TooltipProvider delayDuration={200}>
      <AppShell
        title="AI Search"
        titleBadge={
          <Badge
            variant="secondary"
            className={cn(
              "ml-2 text-[10px] font-mono tabular-nums tracking-tight",
              serviceBadge.loading
                ? "bg-muted/30 text-muted-foreground border-border/40 animate-pulse"
                : serviceBadge.online
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                  : "bg-red-500/10 text-red-400 border-red-500/30",
            )}
          >
            {serviceBadge.label}
          </Badge>
        }
        actions={
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button variant="ghost" size="icon" className="size-7" onClick={load} disabled={isRefreshing}>
                  <RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>Refresh live AI search status</TooltipContent>
          </Tooltip>
        }
        tabs={[
          { value: "overview", label: "Overview", icon: LayoutDashboard },
          { value: "playground", label: "Playground", icon: FlaskConical },
        ]}
        edgeToEdge
      >
        <div className="flex flex-col flex-1 min-h-0 overflow-y-auto p-3 bg-background">
          <TabsContent value="overview" className="mt-0 outline-none flex-1 min-h-0">
            <OverviewTab
              stats={stats}
              health={health}
              groqLimits={llmStats}
              error={error}
              isRefreshing={isRefreshing}
              lastLoadedAt={lastLoadedAt}
              onToggleProvider={handleToggleProvider}
              toggleBusy={toggleBusy}
            />
          </TabsContent>

          <TabsContent value="playground" className="mt-0 outline-none flex-1 min-h-0">
            <PlaygroundTab
              serviceOnline={serviceOnline}
              availableModels={availableModels}
              defaultModel={selectedModel}
              hfAvailable={hfAvailable}
            />
          </TabsContent>
        </div>
      </AppShell>
    </TooltipProvider>
  );
}
