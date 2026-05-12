"use client";

import { type ReactNode } from "react";
import {
  Activity,
  AlertCircle,
  BrainCircuit,
  Cpu,
  Globe,
  SearchCheck,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────────

export interface ProviderStat {
  name: string;
  healthy: boolean;
  enabled: boolean;
  requests_used: number;
  quota_limit: number | null;
  quota_remaining: number | null;
  quota_source: "live" | "local" | "none";
  last_error: string | null;
  last_used_at: string | null;
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
  total_searches: number;
  llm_engine: string;
  llm_healthy: boolean;
}

export interface HealthData {
  status: string;
  service?: { healthy: boolean; url: string; error: string | null };
  llm_engine?: {
    active?: string;
    provider?: string;
    model?: string;
    healthy?: boolean;
    providers?: Record<string, Record<string, unknown>>;
  } & Record<string, unknown>;
  search_providers: { total: number; healthy: number };
}

// ── Helpers ──────────────────────────────────────────────────────

type Tone = "positive" | "negative" | "warning" | "brand" | "neutral";

const TONE_VALUE: Record<Tone, string> = {
  positive: "text-emerald-400",
  negative: "text-red-400",
  warning: "text-amber-400",
  brand: "text-blue-400",
  neutral: "text-foreground/80",
};

const TONE_DOT: Record<Tone, string> = {
  positive: "bg-emerald-400",
  negative: "bg-red-400",
  warning: "bg-amber-400",
  brand: "bg-blue-400",
  neutral: "bg-muted-foreground/40",
};

const PROVIDER_META: Record<
  string,
  { label: string; tier: string; quota: string }
> = {
  brave: {
    label: "Brave Search",
    tier: "Primary",
    quota: "~1,000/mo",
  },
  tavily: {
    label: "Tavily",
    tier: "Primary",
    quota: "1,000/mo",
  },
  serper: {
    label: "Serper.dev",
    tier: "Secondary",
    quota: "2,500 one-time",
  },
  duckduckgo: {
    label: "DuckDuckGo",
    tier: "Fallback",
    quota: "Unlimited",
  },
};

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
  return d.toLocaleDateString();
}

export function deriveModelStatus(
  health: HealthData | null,
  stats: StatsData | null,
  lastLoadedAt: string | null,
): ModelStatus | null {
  if (health?.llm_engine) {
    const eng = health.llm_engine;
    const activeProvider =
      (eng.active as string) ?? (eng.provider as string) ?? "unknown";
    const providerStats =
      eng.providers && typeof eng.providers === "object"
        ? (eng.providers as Record<string, Record<string, unknown>>)
        : null;
    const activeModel =
      providerStats?.[activeProvider]?.model as string | undefined;
    const model =
      activeModel ??
      eng.model ??
      (providerStats
        ? (Object.values(providerStats).find((p) => p?.model)?.model as string)
        : undefined) ??
      stats?.llm_engine ??
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

export function getModelUi(status: ModelStatus | null): {
  value: string;
  tone: Tone;
} {
  if (!status) return { value: "Unknown", tone: "warning" };
  if (!status.reachable) return { value: "Service Down", tone: "negative" };
  if (status.healthy) return { value: "Healthy", tone: "positive" };
  return { value: "Unhealthy", tone: "negative" };
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
    const nested = detailObj.detail;
    if (nested && typeof nested === "object") {
      const nestedObj = nested as Record<string, unknown>;
      if (typeof nestedObj.message === "string") return nestedObj.message;
    }
  }
  if (typeof obj.message === "string") return obj.message;
  if (typeof obj.error === "string") return obj.error;
  return fallback;
}

// ── Sub-components ───────────────────────────────────────────────

function KpiCard({
  icon,
  label,
  value,
  sub,
  tone = "neutral",
  loading,
}: {
  icon?: ReactNode;
  label: string;
  value: string;
  sub?: string;
  tone?: Tone;
  loading?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/60 px-4 py-3 transition-colors hover:bg-card/80">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.06em] uppercase text-muted-foreground/60 mb-2">
        {icon && <span className="opacity-50">{icon}</span>}
        <span>{label}</span>
      </div>
      {loading ? (
        <div className="space-y-1.5 mt-1">
          <Skeleton className="h-5 w-24 rounded" />
          <Skeleton className="h-3 w-28 rounded" />
        </div>
      ) : (
        <>
          <div
            className={cn(
              "text-[15px] font-bold leading-none tracking-tight font-mono tabular-nums",
              TONE_VALUE[tone],
            )}
          >
            {value}
          </div>
          {sub && (
            <div className="mt-1.5 text-[10px] text-muted-foreground/50 tracking-tight font-mono tabular-nums whitespace-nowrap overflow-hidden text-ellipsis">
              {sub}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Panel({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border/50 bg-card/60 overflow-hidden">
      <header className="flex items-center gap-1.5 px-4 py-2.5 border-b border-border/40 text-[10px] font-bold tracking-[0.08em] uppercase text-muted-foreground/60">
        {icon}
        {title}
      </header>
      {children}
    </section>
  );
}

function StatusTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone: Tone;
}) {
  return (
    <div className="rounded-md border border-border/40 bg-background/60 px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-[0.07em] text-muted-foreground/50 font-semibold">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-sm font-semibold font-mono tabular-nums truncate",
          TONE_VALUE[tone],
        )}
      >
        {value}
      </div>
      {sub && (
        <div className="mt-0.5 text-xs text-muted-foreground/50 truncate">
          {sub}
        </div>
      )}
    </div>
  );
}

function formatProviderError(error: string): string {
  if (/query is too long|maximum.*400|400 characters/i.test(error)) {
    return "Query exceeded provider length. New requests are capped at 400 chars.";
  }
  if (/422|unprocessable/i.test(error)) {
    return "Query contained invalid characters — auto-sanitized for future requests.";
  }
  return error;
}

function ProviderCard({
  provider: p,
  onToggle,
  busy,
}: {
  provider: ProviderStat;
  onToggle: (name: string, enabled: boolean) => void;
  busy: boolean;
}) {
  const meta = PROVIDER_META[p.name] ?? {
    label: p.name,
    tier: "",
    quota: "",
  };
  const isOff = p.enabled === false;
  const isLive = p.enabled !== false && p.healthy;
  const isError = p.enabled !== false && !p.healthy;
  const usagePct =
    p.quota_limit != null && p.quota_limit > 0
      ? Math.min(100, (p.requests_used / p.quota_limit) * 100)
      : null;
  const barTone =
    usagePct === null
      ? "bg-muted-foreground/30"
      : usagePct > 80
        ? "bg-red-400"
        : usagePct > 50
          ? "bg-amber-400"
          : "bg-emerald-400";
  const statusDot = isOff
    ? "bg-muted-foreground/30"
    : isLive
      ? "bg-emerald-400"
      : "bg-red-400";
  const statusBadge = isOff
    ? {
        text: "Off",
        cls: "bg-muted/30 text-muted-foreground/50 border-border/40",
      }
    : isLive
      ? {
          text: "Live",
          cls: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
        }
      : { text: "Error", cls: "bg-red-500/10 text-red-400 border-red-500/20" };
  const quotaSourceBadge =
    p.quota_source === "live"
      ? { text: "Live", cls: "bg-blue-500/10 text-blue-400 border-blue-500/20" }
      : p.quota_source === "local"
        ? {
            text: "Tracked",
            cls: "bg-amber-500/10 text-amber-400 border-amber-500/20",
          }
        : null;
  const usedTooltip =
    p.quota_source === "live"
      ? "Server-reported usage (authoritative)"
      : "Persistent local counter";

  return (
    <div
      className={cn(
        "rounded-lg border border-border/50 bg-card/60 p-4 transition-colors hover:bg-card/80",
        isOff && "opacity-45",
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className={cn("size-1.5 rounded-full shrink-0", statusDot)} />
          <span className="text-sm font-semibold text-foreground/85 truncate">
            {meta.label}
          </span>
          <Badge
            variant="outline"
            className={cn(
              "text-[9px] font-semibold px-1.5 py-0",
              statusBadge.cls,
            )}
          >
            {statusBadge.text}
          </Badge>
        </div>
        <div className="flex items-center gap-1.5">
          {quotaSourceBadge && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[8px] font-semibold px-1 py-0",
                    quotaSourceBadge.cls,
                  )}
                >
                  {quotaSourceBadge.text}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                {p.quota_source === "live"
                  ? "Quota synced from provider API"
                  : "Quota tracked locally across restarts"}
              </TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <Switch
                  checked={p.enabled !== false}
                  onCheckedChange={(c) => onToggle(p.name, c)}
                  disabled={busy}
                  className="scale-90"
                />
              </div>
            </TooltipTrigger>
            <TooltipContent>
              {p.enabled !== false
                ? `Disable ${meta.label}`
                : `Enable ${meta.label}`}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Usage */}
      <div className="mb-3">
        <div className="flex items-baseline justify-between mb-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-xl font-bold font-mono tabular-nums text-foreground/80 tracking-tight cursor-default">
                {p.requests_used.toLocaleString()}
              </span>
            </TooltipTrigger>
            <TooltipContent>{usedTooltip}</TooltipContent>
          </Tooltip>
          <span className="text-[11px] font-mono tabular-nums text-muted-foreground/40">
            {p.quota_limit != null
              ? `/ ${p.quota_limit.toLocaleString()}`
              : "\u221e"}
          </span>
        </div>
        <div className="h-1 rounded-full bg-muted/30 overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500",
              barTone,
            )}
            style={{ width: usagePct != null ? `${usagePct}%` : "0%" }}
          />
        </div>
      </div>

      {/* Footer stats */}
      <div className="space-y-0.5 text-[10px] text-muted-foreground/45">
        <div className="flex justify-between">
          <span>Remaining</span>
          <span className="font-mono tabular-nums">
            {p.quota_remaining != null
              ? p.quota_remaining.toLocaleString()
              : "\u2014"}
          </span>
        </div>
        <div className="flex justify-between">
          <span>Last used</span>
          <span className="font-mono tabular-nums">
            {p.last_used_at ? formatRelative(p.last_used_at) : "never"}
          </span>
        </div>
        {p.last_error && (
          <div className="mt-1.5 px-2 py-1 rounded bg-red-500/8 text-red-400/80 text-[10px] line-clamp-1">
            {formatProviderError(p.last_error)}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Overview Tab ────────────────────────────────────────────

export function OverviewTab({
  stats,
  health,
  error,
  isRefreshing,
  lastLoadedAt,
  onToggleProvider,
  toggleBusy,
}: {
  stats: StatsData | null;
  health: HealthData | null;
  error: string | null;
  isRefreshing: boolean;
  lastLoadedAt: string | null;
  onToggleProvider: (name: string, enabled: boolean) => void;
  toggleBusy: Set<string>;
}) {
  const modelStatus = deriveModelStatus(health, stats, lastLoadedAt);
  const modelUi = getModelUi(modelStatus);
  const serviceOnline = Boolean(
    health?.status === "ok" || health?.status === "degraded",
  );
  const totalSearches = stats?.total_searches ?? 0;
  const providersHealthy =
    stats?.providers?.filter((p) => p.healthy).length ?? 0;
  const providersTotal = stats?.providers?.length ?? 0;
  const serviceError = health?.service?.error ?? null;
  const activeEngine = modelStatus?.engine ?? "huggingface";
  const engineLabel =
    activeEngine === "huggingface"
      ? "HuggingFace Router"
      : activeEngine === "groq"
        ? "Groq Fallback"
        : activeEngine;

  return (
    <div className="flex flex-col gap-4">
      {/* Error banner */}
      {(error || serviceError) && (
        <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-destructive bg-destructive/8 border border-destructive/20">
          <AlertCircle className="size-3.5 shrink-0" />
          <span>
            {error ?? `Python AI search service offline: ${serviceError}`}
          </span>
        </div>
      )}

      {/* Hero summary — clean frosted glass instead of heavy gradients */}
      <div className="rounded-lg border border-border/50 bg-card/60 p-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/50">
              <ShieldCheck className="size-3.5" />
              Intelligence Stack
            </div>
            <h2 className="mt-2 text-lg font-semibold tracking-tight text-foreground/90">
              HuggingFace + search grounding is primary
            </h2>
            <p className="mt-1 text-sm text-muted-foreground/60">
              Web evidence first, LLM second, Groq only as fallback.
            </p>
          </div>
          <Badge
            variant="outline"
            className={cn(
              "w-fit border-border/50 bg-card/40 px-2.5 py-1 text-[10px] font-mono uppercase tracking-[0.12em]",
              modelStatus?.healthy
                ? "text-emerald-400"
                : "text-amber-400",
            )}
          >
            {engineLabel}
          </Badge>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiCard
          icon={<Activity className="size-3.5" />}
          label="Service"
          value={serviceOnline ? "Online" : "Offline"}
          sub={health ? "gateway reachable" : undefined}
          tone={serviceOnline ? "positive" : "negative"}
          loading={!health && isRefreshing}
        />
        <KpiCard
          icon={<BrainCircuit className="size-3.5" />}
          label="Primary Engine"
          value={engineLabel}
          sub={modelUi.value}
          tone={modelUi.tone}
          loading={!modelStatus && isRefreshing}
        />
        <KpiCard
          icon={<Globe className="size-3.5" />}
          label="Providers"
          value={`${providersHealthy}/${providersTotal}`}
          sub={`${providersHealthy} healthy`}
          tone={providersHealthy > 0 ? "brand" : "negative"}
          loading={!stats && isRefreshing}
        />
        <KpiCard
          icon={<SearchCheck className="size-3.5" />}
          label="Grounding Searches"
          value={totalSearches.toLocaleString()}
          sub={
            lastLoadedAt
              ? `checked ${formatRelative(lastLoadedAt)}`
              : "live poll"
          }
          tone="neutral"
          loading={!stats && isRefreshing}
        />
      </div>

      {/* Engine Status */}
      <Panel title="AI Engine Status" icon={<Cpu className="size-3" />}>
        <div className="p-4 space-y-3">
          {!modelStatus && isRefreshing ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16 rounded-lg" />
              ))}
            </div>
          ) : modelStatus ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <StatusTile
                  label="Route"
                  value={engineLabel}
                  tone={modelStatus.healthy ? "positive" : "negative"}
                  sub="search grounding first"
                />
                <StatusTile
                  label="Model"
                  value={modelStatus.configured_model}
                  tone={modelStatus.healthy ? "positive" : "warning"}
                  sub="cloud LLM"
                />
                <StatusTile
                  label="Status"
                  value={modelUi.value}
                  tone={modelUi.tone}
                  sub={
                    modelStatus.checked_at
                      ? formatRelative(modelStatus.checked_at)
                      : "not checked"
                  }
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="flex items-start gap-2.5 rounded-md border border-border/40 bg-background/60 px-3 py-2.5">
                  <SearchCheck className="size-3.5 mt-0.5 text-emerald-400/70 shrink-0" />
                  <div>
                    <div className="text-xs font-semibold text-foreground/75">
                      Search-grounded answers
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground/50">
                      Citations and provider failover before LLM synthesis.
                    </div>
                  </div>
                </div>
                <div className="flex items-start gap-2.5 rounded-md border border-border/40 bg-background/60 px-3 py-2.5">
                  <BrainCircuit className="size-3.5 mt-0.5 text-blue-400/70 shrink-0" />
                  <div>
                    <div className="text-xs font-semibold text-foreground/75">
                      HF primary route
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground/50">
                      Groq remains available, but quotas are not surfaced here.
                    </div>
                  </div>
                </div>
              </div>
              {modelStatus.error && (
                <div className="flex items-center gap-2 rounded-md px-3 py-2 text-xs text-amber-400/80 bg-amber-500/8 border border-amber-500/20">
                  <AlertCircle className="size-3.5 shrink-0" />
                  <span>{modelStatus.error}</span>
                </div>
              )}
            </>
          ) : (
            <div className="rounded-md border border-destructive/20 bg-destructive/8 px-3 py-2 text-xs text-destructive/80">
              No AI engine status available. The Python service is likely
              offline.
            </div>
          )}
        </div>
      </Panel>

      {/* Provider Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {stats
          ? stats.providers.map((p) => (
              <ProviderCard
                key={p.name}
                provider={p}
                onToggle={onToggleProvider}
                busy={toggleBusy.has(p.name)}
              />
            ))
          : Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="rounded-lg border border-border/50 bg-card/60 p-4"
              >
                <Skeleton className="h-4 w-24 mb-3" />
                <Skeleton className="h-8 w-full mb-2" />
                <Skeleton className="h-3 w-32" />
              </div>
            ))}
      </div>
    </div>
  );
}
