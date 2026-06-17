"use client";

import { type ReactNode } from "react";
import { format } from "date-fns";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Cpu,
  Database,
  Gauge,
  Radio,
  RadioReceiver,
  Search,
  Signal,
  Sparkles,
  ZapOff,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
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

type StatusTone = "online" | "offline" | "warning" | "loading";
type UsageTone = "good" | "watch" | "bad" | "muted";

const PROVIDER_META: Record<
  string,
  { label: string; icon: ReactNode; desc: string }
> = {
  vertex: {
    label: "Google Vertex",
    icon: <Search className="size-4" />,
    desc: "Enterprise search",
  },
  brave: {
    label: "Brave Search",
    icon: <Signal className="size-4" />,
    desc: "General web search",
  },
  tavily: {
    label: "Tavily",
    icon: <Database className="size-4" />,
    desc: "Grounded summaries",
  },
};

const ENGINE_META: Record<
  string,
  { label: string; icon: ReactNode; variants: string[] }
> = {
  deepseek: {
    label: "DeepSeek",
    icon: <DeepSeekIcon className="size-4" />,
    variants: ["Flash", "Pro"],
  },
  gemini: {
    label: "Gemini",
    icon: <Sparkles className="size-4" />,
    variants: ["Flash-Lite", "Flash", "Pro"],
  },
};

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
    return { value: "Service down", tone: "negative" as const };
  if (status.healthy) return { value: "Healthy", tone: "positive" as const };
  return { value: "Unhealthy", tone: "negative" as const };
}

function formatCompact(value: number): string {
  return Intl.NumberFormat("en", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 10_000 ? 1 : 0,
  }).format(value);
}

function getUsageTone(usagePct: number | null): UsageTone {
  if (usagePct === null) return "muted";
  if (usagePct >= 85) return "bad";
  if (usagePct >= 65) return "watch";
  return "good";
}

function StatusBadge({
  status,
  size = "sm",
}: {
  status: StatusTone;
  size?: "sm" | "lg";
}) {
  const config: Record<
    StatusTone,
    {
      label: string;
      icon: ReactNode;
      className: string;
      ping?: string;
    }
  > = {
    online: {
      label: "Online",
      icon: <Radio className="size-3" />,
      className:
        "border-emerald-500/25 bg-emerald-500/10 text-emerald-300 shadow-[0_0_12px_oklch(0.72_0.16_150/0.12)]",
      ping: "bg-emerald-400",
    },
    offline: {
      label: "Offline",
      icon: <ZapOff className="size-3" />,
      className: "border-red-500/20 bg-red-500/10 text-red-300",
    },
    warning: {
      label: "Watch",
      icon: <AlertCircle className="size-3" />,
      className:
        "border-amber-500/25 bg-amber-500/10 text-amber-300 shadow-[0_0_12px_oklch(0.78_0.15_80/0.10)]",
    },
    loading: {
      label: "Loading",
      icon: <Activity className="size-3 animate-pulse" />,
      className: "border-border/35 bg-muted/20 text-muted-foreground",
    },
  };

  const c = config[status];

  return (
    <Badge
      variant="outline"
      className={cn(
        "inline-flex rounded-md font-semibold tracking-normal backdrop-blur-sm",
        size === "lg"
          ? "h-7 gap-2 px-2.5 text-xs"
          : "h-5 gap-1.5 px-1.5 text-[11px]",
        c.className,
      )}
    >
      <span className="relative inline-flex size-3 items-center justify-center">
        {c.ping && (
          <span
            className={cn(
              "absolute inline-flex size-2 rounded-full opacity-70 motion-safe:animate-ping",
              c.ping,
            )}
          />
        )}
        <span className="relative">{c.icon}</span>
      </span>
      {c.label}
    </Badge>
  );
}

function MetricTile({
  label,
  value,
  detail,
  icon,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  detail?: string;
  icon: ReactNode;
  tone?: "neutral" | "good" | "watch" | "bad";
}) {
  const toneClass = {
    neutral: "text-cyan-200/80 bg-cyan-500/[0.06] border-cyan-400/10",
    good: "text-emerald-300 bg-emerald-500/[0.07] border-emerald-400/15",
    watch: "text-amber-300 bg-amber-500/[0.07] border-amber-400/15",
    bad: "text-red-300 bg-red-500/[0.07] border-red-400/15",
  }[tone];

  return (
    <div className="rounded-lg border border-border/25 bg-card/35 p-3 shadow-[0_10px_24px_oklch(0.08_0.02_250/0.18),inset_0_1px_0_rgba(255,255,255,0.03)] sm:p-4">
      <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md border",
            toneClass,
          )}
        >
          {icon}
        </span>
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-4 flex items-end justify-between gap-2 sm:gap-3">
        <div className="min-w-0 truncate font-mono text-xl font-semibold leading-none tracking-tight tabular-nums text-foreground/95 sm:text-2xl">
          {typeof value === "number" ? value.toLocaleString() : value}
        </div>
        {detail && (
          <div className="min-w-0 truncate pb-0.5 text-right text-[11px] font-medium text-muted-foreground/65">
            {detail}
          </div>
        )}
      </div>
    </div>
  );
}

function Panel({
  title,
  summary,
  icon,
  children,
  className,
}: {
  title: string;
  summary: string;
  icon: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "relative overflow-hidden rounded-lg border border-border/25 bg-card/35 shadow-[0_10px_24px_oklch(0.08_0.02_250/0.18),inset_0_1px_0_rgba(255,255,255,0.03)]",
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/30 to-transparent" />
      <header className="flex items-start justify-between gap-4 border-b border-border/20 px-4 py-3.5">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-cyan-400/15 bg-cyan-500/[0.07] text-cyan-200">
            {icon}
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-tight text-foreground/90">
              {title}
            </h2>
            <p className="mt-1 max-w-[48ch] text-xs leading-5 text-muted-foreground/70">
              {summary}
            </p>
          </div>
        </div>
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-[10rem] flex-col items-center justify-center rounded-md border border-dashed border-border/30 bg-background/20 px-4 py-8 text-center">
      <div className="flex size-10 items-center justify-center rounded-md border border-border/25 bg-muted/15 text-muted-foreground">
        {icon}
      </div>
      <div className="mt-3 text-sm font-semibold text-foreground/85">
        {title}
      </div>
      <p className="mt-1 max-w-[32ch] text-xs leading-5 text-muted-foreground/70">
        {description}
      </p>
    </div>
  );
}

function LoadingCard({ rows = 3 }: { rows?: number }) {
  return (
    <div className="rounded-md border border-border/25 bg-background/25 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Skeleton className="size-8 rounded-md" />
          <div className="space-y-2">
            <Skeleton className="h-3.5 w-28 rounded" />
            <Skeleton className="h-3 w-20 rounded" />
          </div>
        </div>
        <Skeleton className="h-5 w-8 rounded-full" />
      </div>
      <div className="mt-4 space-y-2">
        {Array.from({ length: rows }).map((_, index) => (
          <Skeleton key={index} className="h-2.5 w-full rounded" />
        ))}
      </div>
    </div>
  );
}

function UsageMeter({
  usagePct,
  disabled,
}: {
  usagePct: number | null;
  disabled?: boolean;
}) {
  const tone = getUsageTone(usagePct);
  const barClass = {
    good: "bg-emerald-400/80",
    watch: "bg-amber-400/80",
    bad: "bg-red-400/80",
    muted: "bg-cyan-300/35",
  }[tone];

  return (
    <div
      className="relative h-1.5 overflow-hidden rounded-full bg-muted/35"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={usagePct ?? 0}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width,background-color] duration-500",
          barClass,
          disabled && "opacity-40",
        )}
        style={{ width: `${usagePct ?? 0}%` }}
      />
    </div>
  );
}

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
    icon: <Search className="size-4" />,
    desc: "Search provider",
  };

  const isEnabled = provider.enabled !== false;
  const isHealthy = provider.healthy;
  const status: StatusTone = !isEnabled
    ? "offline"
    : isHealthy
      ? "online"
      : "warning";
  const usagePct =
    provider.quotaLimit != null && provider.quotaLimit > 0
      ? Math.min(100, (provider.requestsUsed / provider.quotaLimit) * 100)
      : null;
  const quotaLabel =
    usagePct !== null
      ? `${provider.requestsUsed.toLocaleString()} / ${provider.quotaLimit?.toLocaleString()}`
      : `${provider.requestsUsed.toLocaleString()} used`;

  return (
    <article
      className={cn(
        "group relative overflow-hidden rounded-md border bg-background/25 p-4 transition-[background-color,border-color,opacity,transform] duration-200 hover:-translate-y-0.5 hover:bg-background/35",
        isEnabled && isHealthy
          ? "border-border/30 hover:border-cyan-400/25"
          : "border-border/20 opacity-70",
      )}
    >
      <div
        className={cn(
          "absolute inset-y-3 left-0 w-0.5 rounded-r-full",
          status === "online" && "bg-emerald-400/80",
          status === "warning" && "bg-amber-400/80",
          status === "offline" && "bg-muted-foreground/25",
        )}
      />

      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-cyan-400/10 bg-cyan-500/[0.06] text-cyan-200">
            {meta.icon}
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold tracking-tight text-foreground/90">
              {meta.label}
            </h3>
            <p className="mt-0.5 truncate text-xs text-muted-foreground/65">
              {meta.desc}
            </p>
          </div>
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <div className={cn("relative shrink-0", busy && "animate-pulse")}>
              <Switch
                checked={isEnabled}
                onCheckedChange={(checked) => onToggle(provider.name, checked)}
                disabled={busy}
                className="data-[state=checked]:bg-cyan-500"
              />
              {busy && (
                <span className="absolute -right-1 -top-1 size-2">
                  <span className="absolute inline-flex size-full rounded-full bg-amber-400 opacity-75 motion-safe:animate-ping" />
                  <span className="relative inline-flex size-2 rounded-full bg-amber-400" />
                </span>
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent>
            {isEnabled ? `Disable ${meta.label}` : `Enable ${meta.label}`}
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="mt-4 space-y-2">
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="font-medium text-muted-foreground/70">Requests</span>
          <span className="font-mono tabular-nums text-muted-foreground/80">
            {quotaLabel}
          </span>
        </div>
        <UsageMeter usagePct={usagePct} disabled={!isEnabled} />
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <StatusBadge status={status} />
          {provider.lastError && !isEnabled && (
            <span className="truncate text-[11px] font-medium text-muted-foreground/55">
              {provider.lastError}
            </span>
          )}
        </div>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/55">
          {provider.lastUsedAt
            ? formatRelative(provider.lastUsedAt)
            : "never used"}
        </span>
      </div>
    </article>
  );
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
    icon: <Cpu className="size-4" />,
    variants: [],
  };

  const isManuallyDisabled = engine.manual_disabled === true;
  const isEnabled = !engine.disabled && !isManuallyDisabled;
  const isExhausted = engine.is_exhausted === true;
  const isRateLimited = engine.rate_limited === true;
  const isCreditsExhausted = engine.credits_exhausted === true;
  const autoDisabled = isRateLimited || isCreditsExhausted;
  const status: StatusTone = !isEnabled
    ? "offline"
    : autoDisabled || isExhausted
      ? "warning"
      : "online";
  const statusText = isRateLimited
    ? "Rate limited"
    : isCreditsExhausted
      ? "Credits exhausted"
      : isExhausted
        ? "Quota exhausted"
        : isEnabled
          ? "Ready"
          : "Paused";

  return (
    <article
      className={cn(
        "group relative overflow-hidden rounded-md border bg-background/25 p-4 transition-[background-color,border-color,opacity,transform] duration-200 hover:-translate-y-0.5 hover:bg-background/35",
        status === "online"
          ? "border-border/30 hover:border-cyan-400/25"
          : "border-border/20 opacity-75",
      )}
    >
      <div
        className={cn(
          "absolute inset-y-3 left-0 w-0.5 rounded-r-full",
          status === "online" && "bg-emerald-400/80",
          status === "warning" && "bg-amber-400/80",
          status === "offline" && "bg-muted-foreground/25",
        )}
      />

      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-cyan-400/10 bg-cyan-500/[0.06] text-cyan-200">
            {meta.icon}
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <h3 className="text-sm font-semibold tracking-tight text-foreground/90">
                {meta.label}
              </h3>
              {meta.variants.map((variant) => (
                <Badge
                  key={variant}
                  variant="outline"
                  className="h-4 rounded-[4px] border-border/25 bg-background/35 px-1.5 text-[10px] font-medium text-muted-foreground/70"
                >
                  {variant}
                </Badge>
              ))}
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground/65">
              {engine.model ?? "No model reported"}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {autoDisabled && (
            <Tooltip>
              <TooltipTrigger asChild>
                <AlertCircle className="size-4 text-amber-300 motion-safe:animate-pulse" />
              </TooltipTrigger>
              <TooltipContent>{statusText}</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className={cn("relative", busy && "animate-pulse")}>
                <Switch
                  checked={isEnabled && !autoDisabled}
                  onCheckedChange={(checked) => onToggle(engine.name, checked)}
                  disabled={busy}
                  className="data-[state=checked]:bg-cyan-500"
                />
                {busy && (
                  <span className="absolute -right-1 -top-1 size-2">
                    <span className="absolute inline-flex size-full rounded-full bg-amber-400 opacity-75 motion-safe:animate-ping" />
                    <span className="relative inline-flex size-2 rounded-full bg-amber-400" />
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

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
        <div>
          <div className="text-xs font-medium text-muted-foreground/70">
            Requests
          </div>
          <div className="mt-1 font-mono text-xl font-semibold leading-none tabular-nums text-foreground/90">
            {(engine.total_requests ?? 0).toLocaleString()}
          </div>
        </div>
        <StatusBadge status={status} />
      </div>

      {engine.rate_limit_detail && (
        <div className="mt-3 rounded-md border border-amber-500/15 bg-amber-500/[0.06] px-2.5 py-2 text-xs leading-5 text-amber-200/80">
          {engine.rate_limit_detail.slice(0, 140)}
        </div>
      )}
    </article>
  );
}

export function OverviewTab({
  stats,
  health,
  error,
  isRefreshing,
  lastLoadedAt,
  onToggleProvider,
  toggleBusy,
  llmStats,
  onToggleLlmEngine,
  llmToggleBusy,
}: OverviewTabProps) {
  const usage = llmStats?.usage as Record<string, unknown> | undefined;
  const providersMap = usage?.providers as
    | Record<string, Record<string, unknown>>
    | undefined;
  const activeEngines = providersMap
    ? Object.values(providersMap).filter(
        (provider) => !provider.disabled && !provider.manual_disabled,
      ).length
    : 0;
  const totalEngines = providersMap ? Object.keys(providersMap).length : 0;

  const modelStatus = deriveModelStatus(health, stats, lastLoadedAt);
  const modelUi = getModelUi(modelStatus);
  const serviceOnline = Boolean(
    health?.status === "ok" || health?.status === "degraded",
  );
  const serviceError = health?.service?.error ?? null;
  const totalSearches = stats?.totalSearches ?? 0;
  const providersHealthy =
    stats?.providers?.filter((provider) => provider.healthy).length ?? 0;
  const providersTotal = stats?.providers?.length ?? 0;
  const syncLabel = isRefreshing
    ? "refreshing..."
    : lastLoadedAt
      ? formatRelative(lastLoadedAt)
      : "not loaded";
  const syncDetail = lastLoadedAt
    ? format(new Date(lastLoadedAt), "MMM d, h:mm:ss a")
    : "Waiting for the first poll";
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
        total_requests:
          (info.total_requests as number | undefined) ??
          (info.monthlyUsage as number | undefined),
      });
    }
  }

  return (
    <TooltipProvider delayDuration={300}>
      <main className="min-h-full bg-background">
        <div className="flex flex-col gap-5 p-4 sm:p-5 lg:p-6">
          {(error || serviceError) && (
            <div className="flex items-start gap-3 rounded-md border border-red-500/20 bg-red-500/[0.06] px-4 py-3 shadow-[0_12px_28px_oklch(0.45_0.15_22/0.08)]">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-red-500/10 text-red-300">
                <AlertCircle className="size-4" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-red-200/90">
                  Engine status issue
                </div>
                <div className="mt-0.5 text-xs leading-5 text-red-200/75">
                  {error ?? `Service error: ${serviceError}`}
                </div>
              </div>
            </div>
          )}

          <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <MetricTile
              label="Engine"
              value={serviceOnline ? "Online" : stats ? "Offline" : "---"}
              detail={syncLabel}
              icon={<RadioReceiver className="size-3.5" />}
              tone={!stats ? "watch" : serviceOnline ? "good" : "bad"}
            />
            <MetricTile
              label="Search usage"
              value={formatCompact(totalSearches)}
              detail="monthly"
              icon={<Search className="size-3.5" />}
            />
            <MetricTile
              label="Search providers"
              value={
                providersTotal > 0
                  ? `${providersHealthy}/${providersTotal}`
                  : "---"
              }
              detail="healthy"
              icon={<Signal className="size-3.5" />}
              tone={
                providersTotal === 0
                  ? "watch"
                  : providersHealthy === providersTotal
                    ? "good"
                    : providersHealthy > 0
                      ? "watch"
                      : "bad"
              }
            />
            <MetricTile
              label="Model routers"
              value={
                totalEngines > 0
                  ? `${activeEngines}/${totalEngines}`
                  : modelUi.value
              }
              detail={modelStatus?.configured_model ?? syncDetail}
              icon={
                modelStatus?.healthy ? (
                  <CheckCircle2 className="size-3.5" />
                ) : (
                  <Gauge className="size-3.5" />
                )
              }
              tone={
                totalEngines === 0
                  ? modelStatus?.healthy
                    ? "good"
                    : "watch"
                  : activeEngines === totalEngines
                    ? "good"
                    : activeEngines > 0
                      ? "watch"
                      : "bad"
              }
            />
          </section>

          <section className="grid items-start gap-5 xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
            <Panel
              title="Search providers"
              summary="Provider quotas and manual routing controls for grounding calls."
              icon={<Search className="size-4" />}
            >
              <div className="grid gap-3">
                {stats ? (
                  stats.providers.length > 0 ? (
                    stats.providers.map((provider) => (
                      <ProviderCard
                        key={provider.name}
                        provider={provider}
                        onToggle={onToggleProvider}
                        busy={toggleBusy.has(provider.name)}
                      />
                    ))
                  ) : (
                    <EmptyState
                      icon={<Search className="size-5" />}
                      title="No search providers"
                      description="Provider configuration loaded, but no search routes are registered."
                    />
                  )
                ) : (
                  <>
                    <LoadingCard />
                    <LoadingCard rows={2} />
                    <LoadingCard rows={2} />
                  </>
                )}
              </div>
            </Panel>

            <Panel
              title="Model routers"
              summary="LLM families used by matching, settlement review, and betting analysis."
              icon={<Cpu className="size-4" />}
            >
              <div className="grid gap-3 lg:grid-cols-2">
                {stats ? (
                  llmEngines.length > 0 ? (
                    llmEngines.map((engine) => (
                      <LlmEngineCard
                        key={engine.name}
                        engine={engine}
                        onToggle={onToggleLlmEngine}
                        busy={llmToggleBusy.has(engine.name)}
                      />
                    ))
                  ) : (
                    <div className="lg:col-span-2">
                      <EmptyState
                        icon={<Cpu className="size-5" />}
                        title="No model routers"
                        description="The AI service did not report any LLM engine routes."
                      />
                    </div>
                  )
                ) : (
                  <>
                    <LoadingCard />
                    <LoadingCard />
                  </>
                )}
              </div>
            </Panel>
          </section>
        </div>
      </main>
    </TooltipProvider>
  );
}
