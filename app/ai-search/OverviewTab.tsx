"use client";

import { type ReactNode } from "react";
import {
  Activity, AlertCircle, Cpu, Globe, Gauge, Power, Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip, TooltipContent, TooltipTrigger,
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
  llm_engine?: Record<string, unknown>;
  search_providers: { total: number; healthy: number };
}

export interface LlmStatsData {
  model: string;
  usage: Record<string, unknown>;
}

// ── Helpers ──────────────────────────────────────────────────────

type Tone = "positive" | "negative" | "warning" | "brand" | "neutral";

const TONE_VALUE: Record<Tone, string> = {
  positive: "text-emerald-400",
  negative: "text-red-400",
  warning: "text-amber-400",
  brand: "text-cyan-400",
  neutral: "text-foreground/90",
};

const TONE_RING: Record<Tone, string> = {
  positive: "before:bg-emerald-500/70 bg-emerald-500/5",
  negative: "before:bg-red-500/70 bg-red-500/5",
  warning: "before:bg-amber-400/70 bg-amber-500/5",
  brand: "before:bg-cyan-400/70 bg-cyan-500/5",
  neutral: "before:bg-muted-foreground/40",
};

const PROVIDER_META: Record<
  string,
  { label: string; color: string; tier: string; quota: string }
> = {
  brave: {
    label: "Brave Search",
    color: "from-orange-500 to-red-500",
    tier: "🥇 Primary",
    quota: "~1,000/mo",
  },
  tavily: {
    label: "Tavily",
    color: "from-violet-500 to-purple-500",
    tier: "🥇 Primary",
    quota: "1,000/mo",
  },
  serper: {
    label: "Serper.dev",
    color: "from-blue-500 to-cyan-500",
    tier: "🥈 Secondary",
    quota: "2,500 one-time",
  },
  duckduckgo: {
    label: "DuckDuckGo",
    color: "from-green-500 to-emerald-500",
    tier: "🥉 Fallback",
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
    // FallbackEngine shape: { active, providers: { name: { model, ... } } }
    // Single engine shape: { model, provider, ... }
    const activeProvider = (eng.active as string) ?? (eng.provider as string) ?? "unknown";
    const model = (eng.model as string)
      ?? (eng.providers && typeof eng.providers === "object"
        ? Object.values(eng.providers as Record<string, Record<string, unknown>>).find(p => p?.model)?.model as string
        : undefined)
      ?? stats?.llm_engine
      ?? "unknown";

    return {
      reachable: true,
      healthy: health.status === "ok",
      configured_model: model,
      engine: activeProvider,
      checked_at: lastLoadedAt ?? "",
      error: null,
    };
  }
  return null;
}

export function getModelUi(status: ModelStatus | null): { value: string; tone: Tone } {
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
  icon, label, value, sub, tone = "neutral", loading,
}: {
  icon?: ReactNode; label: string; value: string; sub?: string;
  tone?: Tone; loading?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative rounded-xl border border-border/60 bg-card/40 backdrop-blur-md shadow-[0_1px_3px_rgba(0,0,0,0.18)] px-4 pt-3.5 pb-3 cursor-default overflow-hidden transition-all",
        "before:absolute before:left-0 before:top-3 before:bottom-3 before:w-0.75 before:rounded-r-[3px]",
        "hover:border-border hover:bg-card/60 hover:-translate-y-px hover:shadow-[0_2px_6px_rgba(0,0,0,0.25)]",
        TONE_RING[tone],
      )}
    >
      <div className="flex items-center gap-1.5 text-[9.5px] font-semibold tracking-[0.07em] uppercase text-muted-foreground/70 mb-1.5">
        {icon && <span className="opacity-60">{icon}</span>}
        <span>{label}</span>
      </div>
      {loading ? (
        <div className="space-y-1.5 mt-1">
          <Skeleton className="h-5 w-24 rounded" />
          <Skeleton className="h-3 w-28 rounded" />
        </div>
      ) : (
        <>
          <div className={cn("text-[15px] font-bold leading-none tracking-[-0.02em] font-mono tabular-nums", TONE_VALUE[tone])}>
            {value}
          </div>
          {sub && (
            <div className="mt-1 text-[10px] text-muted-foreground/70 tracking-tight font-mono tabular-nums whitespace-nowrap overflow-hidden text-ellipsis">
              {sub}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Panel({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border/60 bg-card/40 backdrop-blur-md shadow-[0_1px_3px_rgba(0,0,0,0.18),0_8px_24px_-8px_rgba(0,0,0,0.25)] overflow-hidden">
      <header className="flex items-center gap-1.5 px-4 pt-3 pb-2 border-b border-border/40 text-[10px] font-bold tracking-[0.09em] uppercase text-foreground/85">
        {icon}
        {title}
      </header>
      {children}
    </section>
  );
}

function StatusTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: Tone }) {
  return (
    <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/70 font-semibold">{label}</div>
      <div className={cn("mt-1 text-sm font-semibold font-mono tabular-nums truncate", TONE_VALUE[tone])}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground/70 truncate">{sub}</div>}
    </div>
  );
}

function LimitGauge({ label, used, limit, unit }: { label: string; used: number | null; limit: number; unit: string }) {
  const remaining = used ?? limit;
  const pct = Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100));
  const barColor = pct > 80 ? "bg-red-500" : pct > 50 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px]">
        <span className="font-semibold text-muted-foreground/80 uppercase tracking-wider">{label}</span>
        <span className="font-mono tabular-nums text-foreground/70">
          {used != null ? `${remaining.toLocaleString()} left` : limit.toLocaleString()} <span className="text-muted-foreground/50">{unit}</span>
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-muted/40 overflow-hidden">
        <div className={cn("h-full rounded-full transition-all duration-700", barColor)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ProviderCard({
  provider: p, onToggle, busy,
}: {
  provider: ProviderStat; onToggle: (name: string, enabled: boolean) => void; busy: boolean;
}) {
  const meta = PROVIDER_META[p.name] ?? { label: p.name, color: "from-gray-500 to-gray-600", tier: "", quota: "" };
  const isOff = p.enabled === false;
  const isLive = p.enabled !== false && p.healthy;
  const isError = p.enabled !== false && !p.healthy;
  const usagePct = p.quota_limit != null && p.quota_limit > 0
    ? Math.min(100, (p.requests_used / p.quota_limit) * 100) : null;
  const barTone = usagePct === null ? "bg-muted-foreground/40" : usagePct > 80 ? "bg-red-500" : usagePct > 50 ? "bg-amber-500" : "bg-emerald-500";
  const statusDot = isOff ? "bg-muted-foreground/40" : isLive ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)] animate-pulse" : "bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.6)]";
  const statusBadge = isOff ? { text: "Off", cls: "bg-muted/30 text-muted-foreground/60 border-border/40" } : isLive ? { text: "Live", cls: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" } : { text: "Error", cls: "bg-red-500/10 text-red-400 border-red-500/30" };
  const quotaSourceBadge = p.quota_source === "live"
    ? { text: "Live", cls: "bg-cyan-500/10 text-cyan-400 border-cyan-500/30" }
    : p.quota_source === "local"
    ? { text: "Local", cls: "bg-amber-500/10 text-amber-400 border-amber-500/30" }
    : null;
  const usedTooltip = p.quota_source === "live"
    ? "Server-reported usage (authoritative)"
    : "Session counter (local tracking)";

  return (
    <div className={cn("relative rounded-xl border border-border/60 bg-card/40 backdrop-blur-md shadow-[0_1px_3px_rgba(0,0,0,0.18)] p-4 overflow-hidden transition-all hover:border-border hover:bg-card/60 hover:-translate-y-px hover:shadow-[0_2px_6px_rgba(0,0,0,0.25)]", isOff && "opacity-50")}>
      <div className={cn("absolute top-0 left-0 right-0 h-0.5 bg-linear-to-r", meta.color, (isOff || isError) && "opacity-30")} />
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className={cn("size-2 rounded-full shrink-0", statusDot)} />
          <span className="text-sm font-semibold text-foreground/90 truncate">{meta.label}</span>
          <Badge variant="outline" className={cn("text-[9px] font-semibold px-1.5 py-0", statusBadge.cls)}>{statusBadge.text}</Badge>
        </div>
        <div className="flex items-center gap-1.5">
          {quotaSourceBadge && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className={cn("text-[8px] font-semibold px-1 py-0", quotaSourceBadge.cls)}>{quotaSourceBadge.text}</Badge>
              </TooltipTrigger>
              <TooltipContent>{p.quota_source === "live" ? "Quota synced from provider API" : "Quota tracked locally (session only)"}</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <div><Switch checked={p.enabled !== false} onCheckedChange={(c) => onToggle(p.name, c)} disabled={busy} className="scale-90" /></div>
            </TooltipTrigger>
            <TooltipContent>{p.enabled !== false ? `Disable ${meta.label}` : `Enable ${meta.label}`}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="mb-2.5">
        <div className="flex items-baseline justify-between mb-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-[22px] font-bold font-mono tabular-nums text-foreground/90 tracking-tight cursor-default">{p.requests_used.toLocaleString()}</span>
            </TooltipTrigger>
            <TooltipContent>{usedTooltip}</TooltipContent>
          </Tooltip>
          <span className="text-[11px] font-mono tabular-nums text-muted-foreground/60">
            {p.quota_limit != null ? `/ ${p.quota_limit.toLocaleString()}` : "\u221e"}
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-muted/40 overflow-hidden">
          <div className={cn("h-full rounded-full transition-all duration-500", barTone)} style={{ width: usagePct != null ? `${usagePct}%` : "0%" }} />
        </div>
      </div>
      <div className="space-y-0.5 text-[10px] text-muted-foreground/60">
        <div className="flex justify-between">
          <span>Remaining</span>
          <span className="font-mono tabular-nums">{p.quota_remaining != null ? p.quota_remaining.toLocaleString() : "\u2014"}</span>
        </div>
        <div className="flex justify-between">
          <span>Last used</span>
          <span className="font-mono tabular-nums">{p.last_used_at ? formatRelative(p.last_used_at) : "never"}</span>
        </div>
        {p.last_error && (
          <div className="mt-1.5 px-2 py-1 rounded bg-red-500/10 text-red-400 text-[10px] line-clamp-1">{p.last_error}</div>
        )}
      </div>
    </div>
  );
}

// ── Main Overview Tab ────────────────────────────────────────────

export function OverviewTab({
  stats, health, groqLimits, error, isRefreshing, lastLoadedAt,
  onToggleProvider, toggleBusy,
}: {
  stats: StatsData | null;
  health: HealthData | null;
  groqLimits: LlmStatsData | null;
  error: string | null;
  isRefreshing: boolean;
  lastLoadedAt: string | null;
  onToggleProvider: (name: string, enabled: boolean) => void;
  toggleBusy: Set<string>;
}) {
  const modelStatus = deriveModelStatus(health, stats, lastLoadedAt);
  const modelUi = getModelUi(modelStatus);
  const serviceOnline = Boolean(health?.status === "ok" || health?.status === "degraded");
  const totalSearches = stats?.total_searches ?? 0;
  const providersHealthy = stats?.providers?.filter((p) => p.healthy).length ?? 0;
  const providersTotal = stats?.providers?.length ?? 0;
  const modelConfigured = modelStatus?.configured_model ?? stats?.llm_engine ?? "llama-3.3-70b-versatile";
  const serviceError = health?.service?.error ?? null;

  // LLM provider stats — extract from FallbackEngine or single-engine shape
  const usage = groqLimits?.usage;
  const activeProvider = (usage?.active as string) ?? null;
  const providers = (usage?.providers as Record<string, Record<string, unknown>> | undefined) ?? null;
  // For Groq-only (single engine), usage itself has known_limits
  const groqStats = providers?.groq ?? (usage?.known_limits ? usage as Record<string, unknown> : null);
  const knownLimits = groqStats?.known_limits as { rpm?: number; rpd?: number; tpm?: number; tpd?: number } | undefined;
  const liveHeaders = groqStats?.live_headers as { remaining_requests?: number; remaining_tokens?: number } | undefined;

  // Total LLM requests across all providers
  const totalLlmRequests = providers
    ? Object.values(providers).reduce((sum, p) => sum + ((p?.total_requests as number) ?? 0), 0)
    : (usage?.total_requests as number) ?? 0;

  return (
    <div className="flex flex-col gap-3">
      {/* Error banner */}
      {(error || serviceError) && (
        <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-destructive bg-destructive/10 border border-destructive/30">
          <AlertCircle className="size-3.5 shrink-0" />
          <span>{error ?? `Python AI search service offline: ${serviceError}`}</span>
        </div>
      )}

      {/* KPI Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiCard
          icon={<Activity className="size-3.5" />}
          label="Service"
          value={serviceOnline ? "Online" : "Offline"}
          sub={health ? `${health.search_providers.healthy}/${health.search_providers.total} providers` : undefined}
          tone={serviceOnline ? "positive" : "negative"}
          loading={!health && isRefreshing}
        />
        <KpiCard
          icon={<Power className="size-3.5" />}
          label="Model Live"
          value={modelUi.value}
          sub={modelConfigured}
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
          icon={<Zap className="size-3.5" />}
          label="Total Searches"
          value={totalSearches.toLocaleString()}
          sub={lastLoadedAt ? `checked ${formatRelative(lastLoadedAt)}` : "live poll"}
          tone="neutral"
          loading={!stats && isRefreshing}
        />
      </div>

      {/* Engine Status */}
      <Panel title="AI Engine Status" icon={<Cpu className="size-3" />}>
        <div className="p-4 space-y-3">
          {!modelStatus && isRefreshing ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {Array.from({ length: 3 }).map((_, i) => (<Skeleton key={i} className="h-16 rounded-lg" />))}
            </div>
          ) : modelStatus ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <StatusTile label="LLM Engine" value={modelStatus.engine ?? "groq"} tone={modelStatus.healthy ? "positive" : "negative"} sub={modelStatus.healthy ? "healthy" : "unhealthy"} />
                <StatusTile label="Model" value={modelStatus.configured_model} tone={modelStatus.healthy ? "positive" : "warning"} sub="cloud LLM — zero local memory" />
                <StatusTile label="Status" value={modelUi.value} tone={modelUi.tone} sub={modelStatus.checked_at ? formatRelative(modelStatus.checked_at) : "not checked"} />
              </div>
              {activeProvider && providers && Object.keys(providers).length > 1 && (
                <div className="flex items-center gap-3 text-[10px] text-muted-foreground/60">
                  <span>Active: <span className="font-semibold text-foreground/70">{activeProvider}</span></span>
                  <span>·</span>
                  {Object.entries(providers).map(([name, p]) => (
                    <span key={name} className="font-mono">
                      {name}: {(p?.total_requests as number) ?? 0} calls
                      {(p as Record<string, unknown>)?.credits_exhausted === true && (
                        <Badge variant="outline" className="ml-1 text-[8px] px-1 py-0 text-amber-400 border-amber-500/30">exhausted</Badge>
                      )}
                    </span>
                  ))}
                </div>
              )}
              {modelStatus.error && (
                <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30">
                  <AlertCircle className="size-3.5 shrink-0" /><span>{modelStatus.error}</span>
                </div>
              )}
            </>
          ) : (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              No AI engine status available. The Python service is likely offline.
            </div>
          )}
        </div>
      </Panel>

      {/* Groq Rate Limits — shown when Groq is in the chain */}
      {knownLimits && (
        <Panel title="Groq Free-Tier Limits" icon={<Gauge className="size-3" />}>
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <LimitGauge label="Requests / min" used={null} limit={knownLimits.rpm ?? 30} unit="RPM" />
              <LimitGauge label="Requests / day" used={liveHeaders?.remaining_requests ?? null} limit={knownLimits.rpd ?? 1000} unit="RPD" />
              <LimitGauge label="Tokens / min" used={liveHeaders?.remaining_tokens ?? null} limit={knownLimits.tpm ?? 12000} unit="TPM" />
              <LimitGauge label="Tokens / day" used={null} limit={knownLimits.tpd ?? 100000} unit="TPD" />
            </div>
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground/60">
              <span className="font-mono">Model: {groqLimits?.model}</span>
              <span>·</span>
              <span>LLM calls this session: <span className="font-mono font-semibold text-foreground/70">{totalLlmRequests}</span></span>
              {liveHeaders && Object.keys(liveHeaders).length > 0 && (
                <><span>·</span><Badge variant="outline" className="text-[9px] px-1.5 py-0">Live headers</Badge></>
              )}
            </div>
          </div>
        </Panel>
      )}

      {/* Provider Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {stats
          ? stats.providers.map((p) => (
              <ProviderCard key={p.name} provider={p} onToggle={onToggleProvider} busy={toggleBusy.has(p.name)} />
            ))
          : Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-xl border border-border/60 bg-card/40 p-4">
                <Skeleton className="h-4 w-24 mb-3" /><Skeleton className="h-8 w-full mb-2" /><Skeleton className="h-3 w-32" />
              </div>
            ))}
      </div>
    </div>
  );
}
