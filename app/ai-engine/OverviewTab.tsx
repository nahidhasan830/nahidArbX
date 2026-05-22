"use client";

import { type ReactNode } from "react";
import { format } from "date-fns";
import {
  Activity,
  AlertCircle,
  Brain,
  Cpu,
  Database,
  Radio,
  RadioReceiver,
  Search,
  Signal,
  Sparkles,
  ZapOff,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { DeepSeekIcon } from "@/components/icons/DeepSeekIcon";

// ── Types ─────────────────────────────────────────────────────────

export interface ProviderStat {
  name: string;
  healthy: boolean;
  enabled: boolean;
  requestsUsed: number;
  quotaLimit: number | null;
  quotaRemaining: number | null;
  quotaSource: "live" | "local" | "none";
  lastError: string | null;
  lastUsedAt: string | null;
}

export interface ModelStatus {
  reachable: boolean;
  healthy: boolean;
  configured_model: string;
  engine: string;
  checked_at: string;
  error: string | null;
}

export interface StatsData {
  providers: ProviderStat[];
  totalSearches: number;
  llmEngine: string;
  llmHealthy: boolean;
}

export interface HealthData {
  status: string;
  service?: { healthy: boolean; url: string; error: string | null };
  llmEngine?: {
    active?: string;
    provider?: string;
    model?: string;
    healthy?: boolean;
    providers?: Record<string, Record<string, unknown>>;
  } & Record<string, unknown>;
  searchProviders: { total: number; healthy: number };
}

// ── Provider Meta ────────────────────────────────────────────────
// Priority order: Vertex AI Search (primary), Brave, Tavily

const PROVIDER_META: Record<
  string,
  { label: string; icon: ReactNode; color: string; desc: string }
> = {
  brave: {
    label: "Brave Search",
    icon: <Search className="w-4 h-4" />,
    color: "text-orange-400",
    desc: "API search (~1k/mo)",
  },
  tavily: {
    label: "Tavily",
    icon: <Database className="w-4 h-4" />,
    color: "text-violet-400",
    desc: "AI-grounded search",
  },
  vertex: {
    label: "Google Vertex",
    icon: <Search className="w-4 h-4" />,
    color: "text-blue-400",
    desc: "Cloud enterprise search",
  },
};

// ── Helper Functions ────────────────────────────────────────

export function formatRelative(iso: string): string {
  if (!iso) return "never";
  const d = new Date(iso);
  const time = d.getTime();
  if (Number.isNaN(time)) return "never";
  const now = Date.now();
  const secs = Math.floor((now - time) / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return format(d, "MMM d, yyyy");
}

export function deriveModelStatus(
  health: HealthData | null,
  stats: StatsData | null,
  lastLoadedAt: string | null,
): ModelStatus | null {
  if (health?.llmEngine) {
    const eng = health.llmEngine;
    const activeProvider =
      (eng.active as string) ?? (eng.provider as string) ?? "unknown";
    const providerStats = eng.providers as Record<
      string,
      Record<string, unknown>
    > | null;
    const activeModel = providerStats?.[activeProvider]?.model as
      | string
      | undefined;
    const model =
      activeModel ??
      eng.model ??
      (providerStats
        ? (Object.values(providerStats).find((p) => p?.model)?.model as string)
        : undefined) ??
      stats?.llmEngine ??
      "unknown";

    return {
      reachable: true,
      healthy:
        typeof eng.healthy === "boolean" ? eng.healthy : health.status === "ok",
      configured_model: model,
      engine: activeProvider,
      checked_at: lastLoadedAt ?? "",
      error: null,
    };
  }
  return null;
}

export function getModelUi(status: ModelStatus | null) {
  if (!status) return { value: "Unknown", tone: "warning" as const };
  if (!status.reachable)
    return { value: "Service Down", tone: "negative" as const };
  if (status.healthy) return { value: "Healthy", tone: "positive" as const };
  return { value: "Unhealthy", tone: "negative" as const };
}

export function formatApiError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const obj = payload as Record<string, unknown>;
  const detail = obj.detail;
  if (typeof detail === "string") {
    return typeof obj.error === "string" ? `${obj.error}: ${detail}` : detail;
  }
  if (detail && typeof detail === "object") {
    const detailObj = detail as Record<string, unknown>;
    if (typeof detailObj.message === "string") return detailObj.message;
  }
  if (typeof obj.message === "string") return obj.message;
  if (typeof obj.error === "string") return obj.error;
  return fallback;
}

// ── Status Badge Component ─────────────────────────────────────────

function StatusBadge({
  status,
  size = "sm",
}: {
  status: "online" | "offline" | "warning" | "loading";
  size?: "sm" | "lg";
}) {
  const config = {
    online: {
      bg: "bg-emerald-500/15",
      text: "text-emerald-300",
      border: "border-emerald-500/25",
      icon: <Radio className="w-3 h-3" />,
      glow: "shadow-[0_0_10px_rgba(16,185,129,0.25)]",
    },
    offline: {
      bg: "bg-red-500/10",
      text: "text-red-400",
      border: "border-red-500/20",
      icon: <ZapOff className="w-3 h-3" />,
      glow: "",
    },
    warning: {
      bg: "bg-amber-500/12",
      text: "text-amber-300",
      border: "border-amber-500/20",
      icon: <AlertCircle className="w-3 h-3" />,
      glow: "shadow-[0_0_10px_rgba(245,158,11,0.2)]",
    },
    loading: {
      bg: "bg-muted/20",
      text: "text-muted-foreground",
      border: "border-border/30",
      icon: <Activity className="w-3 h-3 animate-pulse" />,
      glow: "",
    },
  };

  const c = config[status];

  return (
    <Badge
      variant="outline"
      className={cn(
        "font-medium tracking-wider backdrop-blur-sm transition-all duration-500",
        size === "sm" ? "text-[10px] px-2 py-0" : "text-xs px-3 py-1",
        c.bg,
        c.text,
        c.border,
        c.glow,
      )}
    >
      <span
        className={cn(status === "online" && "relative flex size-2 mr-1.5")}
      >
        <span
          className={cn(
            "absolute inline-flex size-full rounded-full opacity-75",
            status === "online" && "animate-ping bg-emerald-400",
          )}
        />
        {c.icon}
      </span>
      <span className={cn(size === "sm" ? "text-[10px]" : "text-xs")}>
        {status.toUpperCase()}
      </span>
    </Badge>
  );
}

// ── Stat Card Component ──────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  icon,
  trend,
  accent,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: ReactNode;
  trend?: "up" | "down" | "neutral";
  accent?: "blue" | "green" | "amber" | "violet";
}) {
  const accentColors = {
    blue: "from-blue-500/5 to-blue-500/[0.02] border-blue-500/15",
    green: "from-emerald-500/5 to-emerald-500/[0.02] border-emerald-500/15",
    amber: "from-amber-500/5 to-amber-500/[0.02] border-amber-500/15",
    violet: "from-violet-500/5 to-violet-500/[0.02] border-violet-500/15",
  };

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-2xl border bg-gradient-to-br backdrop-blur-md transition-all duration-300 hover:scale-[1.02] hover:shadow-lg",
        accent ? accentColors[accent] : "border-border/40 bg-card/40",
      )}
    >
      {/* Subtle radial gradient on hover */}
      <div className="absolute inset-0 bg-[radial-gradient(600px_circle_at_50%_0%,rgba(59,130,246,0.06),transparent)] opacity-0 group-hover:opacity-100 transition-opacity duration-500" />

      {/* Background icon decoration */}
      <div className="absolute -right-6 -top-6 w-28 h-28 opacity-[0.03] group-hover:opacity-[0.06] transition-opacity duration-500">
        {icon}
      </div>

      <div className="relative p-5">
        <div className="flex items-center gap-2.5 mb-3">
          <span className="text-muted-foreground/50 group-hover:text-muted-foreground/70 transition-colors">
            {icon}
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground/40">
            {label}
          </span>
        </div>

        <div className="flex items-baseline gap-2">
          <span className="text-[28px] font-bold font-mono tabular-nums tracking-tight text-foreground/90">
            {typeof value === "number" ? value.toLocaleString() : value}
          </span>
          {trend && (
            <span
              className={cn(
                "text-xs font-semibold",
                trend === "up" && "text-emerald-400",
                trend === "down" && "text-red-400",
                trend === "neutral" && "text-muted-foreground/40",
              )}
            >
              {trend === "up" ? "↑" : trend === "down" ? "↓" : "→"}
            </span>
          )}
        </div>

        {sub && (
          <div className="mt-2 text-[11px] text-muted-foreground/40 font-medium tracking-wide">
            {sub}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Provider Card ───────────────────────────────────────────

function ProviderCard({
  provider,
  onToggle,
  busy,
}: {
  provider: ProviderStat;
  onToggle: (name: string, enabled: boolean) => void;
  busy: boolean;
}) {
  const meta = PROVIDER_META[provider.name] ?? {
    label: provider.name,
    icon: <Search className="w-4 h-4" />,
    color: "text-muted-foreground",
  };

  const isEnabled = provider.enabled !== false;
  const isHealthy = provider.healthy;
  const isOffline = !isEnabled || !isHealthy;

  const usagePct =
    provider.quotaLimit != null && provider.quotaLimit > 0
      ? Math.min(100, (provider.requestsUsed / provider.quotaLimit) * 100)
      : null;

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-2xl border transition-all duration-500",
        isOffline
          ? "bg-card/20 border-border/20 opacity-60"
          : "bg-card/40 border-border/50 hover:border-border/70 hover:bg-card/50 backdrop-blur-sm",
      )}
    >
      {/* Status glow accent line */}
      <div
        className={cn(
          "absolute left-0 top-0 bottom-0 w-[3px] transition-all duration-500",
          isEnabled && isHealthy
            ? "bg-gradient-to-b from-emerald-400 to-emerald-600 shadow-[0_0_12px_rgba(16,185,129,0.4)]"
            : !isEnabled
              ? "bg-muted-foreground/20"
              : "bg-gradient-to-b from-red-400 to-red-600 shadow-[0_0_12px_rgba(239,68,68,0.3)]",
        )}
      />

      {/* Health ring on hover */}
      {isEnabled && isHealthy && (
        <div className="absolute -right-4 -top-4 size-16 rounded-full border border-emerald-500/10 bg-emerald-500/5 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
      )}

      <div className="pl-5 pr-4 py-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex size-9 items-center justify-center rounded-xl bg-background/60 backdrop-blur-sm transition-shadow duration-500",
                isEnabled &&
                  isHealthy &&
                  "shadow-[0_0_15px_rgba(16,185,129,0.15)]",
                meta.color,
              )}
            >
              {meta.icon}
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tight">
                {meta.label}
              </div>
              <div className="text-[10px] text-muted-foreground/40 font-medium tracking-wide uppercase">
                {meta.desc}
              </div>
            </div>
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <div className={cn("relative", busy && "animate-pulse")}>
                <Switch
                  checked={isEnabled}
                  onCheckedChange={(c) => onToggle(provider.name, c)}
                  disabled={busy}
                  className={cn(busy && "opacity-50")}
                />
                {busy && (
                  <span className="absolute -top-1 -right-1 w-2 h-2">
                    <span className="absolute inline-flex w-full h-full rounded-full bg-amber-400 animate-ping opacity-75" />
                    <span className="relative inline-flex w-2 h-2 rounded-full bg-amber-400" />
                  </span>
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent>
              {isEnabled ? `Disable ${meta.label}` : `Enable ${meta.label}`}
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Usage bar */}
        <div className="mb-3">
          <div className="flex justify-between text-[10px] mb-1.5">
            <span className="text-muted-foreground/50 font-medium tracking-wide uppercase">
              Requests
            </span>
            <span className="font-mono tabular-nums text-muted-foreground/70">
              {provider.requestsUsed.toLocaleString()}
              {usagePct !== null ? (
                <>
                  <span className="text-muted-foreground/30 mx-1">/</span>
                  {provider.quotaLimit?.toLocaleString() ?? "∞"}
                </>
              ) : (
                " used"
              )}
            </span>
          </div>
          {usagePct !== null ? (
            <div className="relative h-2 rounded-full bg-muted/30 overflow-hidden">
              <div
                className={cn(
                  "absolute inset-y-0 left-0 rounded-full transition-all duration-700",
                  usagePct > 80
                    ? "bg-gradient-to-r from-red-500 to-red-400 shadow-[0_0_8px_rgba(239,68,68,0.4)]"
                    : usagePct > 50
                      ? "bg-gradient-to-r from-amber-500 to-amber-400 shadow-[0_0_8px_rgba(245,158,11,0.3)]"
                      : "bg-gradient-to-r from-emerald-500 to-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.3)]",
                )}
                style={{ width: `${usagePct}%` }}
              />
            </div>
          ) : (
            <div className="h-2 rounded-full bg-muted/30 overflow-hidden">
              <div className="h-full w-0 rounded-full bg-gradient-to-r from-emerald-500/40 to-emerald-400/20" />
            </div>
          )}
        </div>

        {/* Footer stats */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 min-w-0">
            <StatusBadge
              status={!isEnabled ? "offline" : isHealthy ? "online" : "warning"}
            />
            {provider.lastError && !isEnabled && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 font-medium text-muted-foreground/50 border-border/20 bg-background/20 truncate max-w-[80px]"
              >
                {provider.lastError}
              </Badge>
            )}
          </div>
          <span className="text-[10px] text-muted-foreground/30 font-mono tabular-nums shrink-0">
            {provider.lastUsedAt
              ? formatRelative(provider.lastUsedAt)
              : "never used"}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Engine Meta ────────────────────────────────────────────────

const ENGINE_META: Record<
  string,
  { label: string; icon: ReactNode; color: string; variants: string[] }
> = {
  deepseek: {
    label: "DeepSeek",
    icon: <DeepSeekIcon className="w-4 h-4" />,
    color: "text-[#4D6BFE]",
    variants: ["Flash", "Pro"],
  },
  gemini: {
    label: "Gemini",
    icon: <Sparkles className="w-4 h-4" />,
    color: "text-blue-400",
    variants: ["Flash-Lite", "Flash", "Pro"],
  },
};

// ── LLM Engine Card ───────────────────────────────────────────

interface LlmEngineInfo {
  name: string;
  model?: string;
  is_exhausted?: boolean;
  disabled?: boolean;
  manual_disabled?: boolean;
  disabled_reason?: string;
  rate_limited?: boolean;
  credits_exhausted?: boolean;
  rate_limit_detail?: string;
  total_requests?: number;
}

function LlmEngineCard({
  engine,
  onToggle,
  busy,
}: {
  engine: LlmEngineInfo;
  onToggle: (name: string, enabled: boolean) => void;
  busy: boolean;
}) {
  const meta = ENGINE_META[engine.name] ?? {
    label: engine.name,
    icon: <Cpu className="w-4 h-4" />,
    color: "text-muted-foreground",
    variants: [],
  };

  const isManuallyDisabled = engine.manual_disabled === true;
  const isEnabled = !engine.disabled && !isManuallyDisabled;
  const isExhausted = engine.is_exhausted;
  const isRateLimited = engine.rate_limited;
  const isCreditsExhausted = engine.credits_exhausted;
  const autoDisabled = isRateLimited || isCreditsExhausted;

  const getAccentColor = () => {
    if (!isEnabled) return "border-muted-foreground/20";
    if (autoDisabled || isExhausted) return "border-amber-500/30";
    if (engine.name === "deepseek") return "border-[#4D6BFE]/30";
    if (engine.name === "gemini") return "border-blue-400/30";
    return "border-border/50";
  };

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-2xl border transition-all duration-500",
        isExhausted || !isEnabled
          ? "bg-card/20 border-border/20 opacity-60"
          : "bg-card/40 border-border/50 hover:border-border/70 hover:bg-card/50 backdrop-blur-sm",
        getAccentColor(),
      )}
    >
      {/* Status glow line */}
      <div
        className={cn(
          "absolute left-0 top-0 bottom-0 w-[3px] transition-all duration-500",
          !isEnabled
            ? "bg-muted-foreground/20"
            : autoDisabled || isExhausted
              ? "bg-gradient-to-b from-amber-400 to-amber-600 shadow-[0_0_12px_rgba(245,158,11,0.3)]"
              : engine.name === "deepseek"
                ? "bg-gradient-to-b from-[#4D6BFE] to-[#7B93FF] shadow-[0_0_12px_rgba(77,107,254,0.4)]"
                : "bg-gradient-to-b from-blue-400 to-blue-600 shadow-[0_0_12px_rgba(96,165,250,0.3)]",
        )}
      />

      <div className="pl-5 pr-4 py-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex size-9 items-center justify-center rounded-xl bg-background/60 backdrop-blur-sm transition-shadow duration-500",
                isEnabled &&
                  !autoDisabled &&
                  !isExhausted &&
                  engine.name === "deepseek" &&
                  "shadow-[0_0_15px_rgba(77,107,254,0.15)]",
                isEnabled &&
                  !autoDisabled &&
                  !isExhausted &&
                  engine.name === "gemini" &&
                  "shadow-[0_0_15px_rgba(96,165,250,0.15)]",
                meta.color,
              )}
            >
              {meta.icon}
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tight flex items-center gap-2">
                {meta.label}
                <div className="flex items-center gap-1">
                  {meta.variants.map((v) => (
                    <Badge
                      key={v}
                      variant="outline"
                      className="text-[10px] px-1.5 py-0 font-medium border-border/30 bg-background/40 backdrop-blur-sm"
                    >
                      {v}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {autoDisabled && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <AlertCircle className="w-4 h-4 text-amber-400 animate-pulse" />
                </TooltipTrigger>
                <TooltipContent>
                  {isRateLimited
                    ? "Rate limited (429)"
                    : "Credits exhausted (402)"}
                </TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <div className={cn("relative", busy && "animate-pulse")}>
                  <Switch
                    checked={isEnabled && !autoDisabled}
                    onCheckedChange={(c) => onToggle(engine.name, c)}
                    disabled={busy}
                    className={cn(busy && "opacity-50")}
                  />
                  {busy && (
                    <span className="absolute -top-1 -right-1 w-2 h-2">
                      <span className="absolute inline-flex w-full h-full rounded-full bg-amber-400 animate-ping opacity-75" />
                      <span className="relative inline-flex w-2 h-2 rounded-full bg-amber-400" />
                    </span>
                  )}
                </div>
              </TooltipTrigger>
              <TooltipContent>
                {isEnabled ? `Disable ${meta.label}` : `Enable ${meta.label}`}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Stats */}
        <div className="space-y-2 text-[11px]">
          <div className="flex justify-between">
            <span className="text-muted-foreground/50 font-medium tracking-wide uppercase">
              Requests
            </span>
            <span className="font-mono tabular-nums text-muted-foreground/70">
              {engine.total_requests?.toLocaleString() ?? "0"}
            </span>
          </div>
        </div>

        {/* Status */}
        <div className="mt-3">
          <StatusBadge
            status={
              !isEnabled
                ? "offline"
                : autoDisabled
                  ? "warning"
                  : isExhausted
                    ? "warning"
                    : "online"
            }
          />
        </div>

        {/* Rate limit detail */}
        {engine.rate_limit_detail && (
          <div className="mt-2 text-[10px] text-amber-400/70 bg-amber-500/5 backdrop-blur-sm rounded-lg px-2.5 py-1.5 border border-amber-500/10">
            {engine.rate_limit_detail.slice(0, 100)}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Overview Tab ────────────────────────────────────────────

interface OverviewTabProps {
  stats: StatsData | null;
  health: HealthData | null;
  error: string | null;
  isRefreshing: boolean;
  lastLoadedAt: string | null;
  onToggleProvider: (name: string, enabled: boolean) => void;
  toggleBusy: Set<string>;
  llmStats: Record<string, unknown> | null;
  onToggleLlmEngine: (name: string, enabled: boolean) => void;
  llmToggleBusy: Set<string>;
}

export function OverviewTab({
  stats,
  health,
  error,
  isRefreshing: _isRefreshing,
  lastLoadedAt,
  onToggleProvider,
  toggleBusy,
  llmStats,
  onToggleLlmEngine,
  llmToggleBusy,
}: OverviewTabProps) {
  // Count active engines from llmStats
  const usage = llmStats?.usage as Record<string, unknown> | undefined;
  const providersMap = usage?.providers as
    | Record<string, Record<string, unknown>>
    | undefined;
  const activeEngines = providersMap
    ? Object.values(providersMap).filter(
        (p) => !p.disabled && !p.manual_disabled,
      ).length
    : 0;
  const totalEngines = providersMap ? Object.keys(providersMap).length : 0;

  const modelStatus = deriveModelStatus(health, stats, lastLoadedAt);
  const modelUi = getModelUi(modelStatus);
  const serviceOnline = Boolean(
    health?.status === "ok" || health?.status === "degraded",
  );

  const totalSearches = stats?.totalSearches ?? 0;
  const providersHealthy =
    stats?.providers?.filter((p) => p.healthy).length ?? 0;
  const providersTotal = stats?.providers?.length ?? 0;
  const serviceError = health?.service?.error ?? null;

  // Parse LLM engine status
  const llmEngines: LlmEngineInfo[] = [];
  if (providersMap) {
    for (const [name, info] of Object.entries(providersMap)) {
      llmEngines.push({
        name,
        model: info.model as string | undefined,
        is_exhausted: info.is_exhausted as boolean | undefined,
        disabled: info.disabled as boolean | undefined,
        manual_disabled: info.manual_disabled as boolean | undefined,
        disabled_reason: info.disabled_reason as string | undefined,
        rate_limited: info.rate_limited as boolean | undefined,
        credits_exhausted: info.credits_exhausted as boolean | undefined,
        rate_limit_detail: info.rate_limit_detail as string | undefined,
        total_requests: info.total_requests as number | undefined,
      });
    }
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col gap-6 p-6">
        {/* Error banner */}
        {(error || serviceError) && (
          <div className="flex items-center gap-3 rounded-2xl px-4 py-3 text-sm bg-red-500/5 backdrop-blur-sm border border-red-500/15 shadow-[0_0_20px_rgba(239,68,68,0.05)]">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-red-500/10">
              <AlertCircle className="w-4 h-4 text-red-400" />
            </div>
            <span className="text-red-400/80 text-xs font-medium">
              {error ?? `Service error: ${serviceError}`}
            </span>
          </div>
        )}

        {/* Stats Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {stats ? (
            <>
              <StatCard
                label="Total Searches"
                value={totalSearches}
                sub="all time"
                icon={<Search className="w-5 h-5" />}
                trend="up"
                accent="blue"
              />
              <StatCard
                label="Providers"
                value={`${providersHealthy}/${providersTotal}`}
                sub="healthy"
                icon={<Signal className="w-5 h-5" />}
                trend={providersHealthy === providersTotal ? "up" : "neutral"}
                accent="green"
              />
              <StatCard
                label="LLM Engines"
                value={
                  totalEngines > 0
                    ? `${activeEngines}/${totalEngines}`
                    : (modelStatus?.engine ?? "---")
                }
                sub={totalEngines > 0 ? "active" : modelUi.value.toLowerCase()}
                icon={<Brain className="w-5 h-5" />}
                trend={
                  activeEngines === totalEngines && totalEngines > 0
                    ? "up"
                    : modelStatus?.healthy
                      ? "up"
                      : "down"
                }
                accent="violet"
              />
              <StatCard
                label="Status"
                value={serviceOnline ? "Online" : "Offline"}
                sub={
                  lastLoadedAt ? formatRelative(lastLoadedAt) : "connecting..."
                }
                icon={<RadioReceiver className="w-5 h-5" />}
                trend={serviceOnline ? "up" : "down"}
                accent={serviceOnline ? "green" : "amber"}
              />
            </>
          ) : (
            Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="rounded-2xl bg-card/20 border border-border/30 p-5 space-y-3 backdrop-blur-sm"
              >
                <div className="flex items-center gap-2">
                  <Skeleton className="size-5 rounded-lg" />
                  <Skeleton className="h-3 w-16 rounded" />
                </div>
                <Skeleton className="h-8 w-20 rounded" />
                <Skeleton className="h-3 w-14 rounded" />
              </div>
            ))
          )}
        </div>

        {/* LLM Engine Controls */}
        <Card className="overflow-hidden border-border/30 bg-card/30 backdrop-blur-md rounded-2xl">
          <CardHeader className="pb-3 border-b border-border/20">
            <CardTitle className="text-sm font-semibold tracking-tight flex items-center gap-2">
              <div className="flex size-7 items-center justify-center rounded-lg bg-violet-500/10">
                <Cpu className="w-3.5 h-3.5 text-violet-400" />
              </div>
              LLM Engine Controls
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {stats && llmEngines.length > 0 ? (
                llmEngines.map((eng) => (
                  <LlmEngineCard
                    key={eng.name}
                    engine={eng}
                    onToggle={onToggleLlmEngine}
                    busy={llmToggleBusy.has(eng.name)}
                  />
                ))
              ) : stats && llmEngines.length === 0 ? (
                <div className="col-span-full text-sm text-muted-foreground/40 py-10 text-center font-medium">
                  No LLM engines configured. The AI service may be offline.
                </div>
              ) : (
                Array.from({ length: 2 }).map((_, i) => (
                  <div
                    key={`skeleton-llm-${i}`}
                    className="rounded-2xl bg-card/20 border border-border/30 p-4 space-y-3 backdrop-blur-sm"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Skeleton className="size-9 rounded-xl" />
                        <Skeleton className="h-4 w-20 rounded" />
                      </div>
                      <Skeleton className="h-5 w-9 rounded-full" />
                    </div>
                    <Skeleton className="h-2 w-full rounded-full" />
                    <Skeleton className="h-4 w-16 rounded-full" />
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        {/* Search Providers */}
        <Card className="overflow-hidden border-border/30 bg-card/30 backdrop-blur-md rounded-2xl">
          <CardHeader className="pb-3 border-b border-border/20">
            <CardTitle className="text-sm font-semibold tracking-tight flex items-center gap-2">
              <div className="flex size-7 items-center justify-center rounded-lg bg-orange-500/10">
                <Search className="w-3.5 h-3.5 text-orange-400" />
              </div>
              Search Providers
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {stats && stats.providers?.length
                ? stats.providers.map((p) => (
                    <ProviderCard
                      key={p.name}
                      provider={p}
                      onToggle={onToggleProvider}
                      busy={toggleBusy.has(p.name)}
                    />
                  ))
                : Array.from({ length: 3 }).map((_, i) => (
                    <div
                      key={`skeleton-provider-${i}`}
                      className="rounded-2xl bg-card/20 border border-border/30 p-4 space-y-3 backdrop-blur-sm"
                    >
                      <div className="flex items-center gap-3">
                        <Skeleton className="size-9 rounded-xl" />
                        <div className="space-y-1.5">
                          <Skeleton className="h-4 w-24 rounded" />
                          <Skeleton className="h-3 w-16 rounded" />
                        </div>
                      </div>
                      <Skeleton className="h-2 w-full rounded-full" />
                      <div className="flex items-center justify-between">
                        <Skeleton className="h-5 w-16 rounded-full" />
                        <Skeleton className="h-3 w-12 rounded" />
                      </div>
                    </div>
                  ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </TooltipProvider>
  );
}
