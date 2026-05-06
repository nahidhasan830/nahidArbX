"use client";

import { useState, useEffect, useCallback } from "react";
import { AppShell } from "@/components/nav/AppShell";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface ShadowDecision {
  id: string;
  betId: string;
  eventId: string;
  placedAt: string | null;
  kellyRaw: number | null;
  shadowKelly: number | null;
  mlKelly: number | null;
  mlMultiplier: number | null;
  outcome: string | null;
  settledAt: string | null;
  createdAt: string | null;
}

interface ShadowStats {
  total: number;
  resolved: number;
  unresolved: number;
  avgMlMultiplier: string;
  avgKellyRaw: string;
  wins: number;
  losses: number;
  voids: number;
  winRate: string;
}

const OUTCOME_COLORS: Record<string, string> = {
  win: "bg-emerald-500",
  lose: "bg-red-500",
  void: "bg-slate-500",
  half_win: "bg-emerald-400",
  half_lose: "bg-red-400",
  pending: "bg-amber-400",
};

const TIME_PRESETS = [
  { label: "Today", value: "today" },
  { label: "7D", value: "7d" },
  { label: "30D", value: "30d" },
  { label: "90D", value: "90d" },
  { label: "All", value: "all" },
];

function timeRange(preset: string): { from?: string; to?: string } {
  const now = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 16) + "Z";
  switch (preset) {
    case "today": {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return { from: fmt(start), to: fmt(now) };
    }
    case "7d":
      return { from: fmt(new Date(now.getTime() - 7 * 86_400_000)), to: fmt(now) };
    case "30d":
      return { from: fmt(new Date(now.getTime() - 30 * 86_400_000)), to: fmt(now) };
    case "90d":
      return { from: fmt(new Date(now.getTime() - 90 * 86_400_000)), to: fmt(now) };
    default:
      return {};
  }
}

export default function ShadowModePage() {
  const [timePreset, setTimePreset] = useState("30d");
  const [showResolved, setShowResolved] = useState<"all" | "true" | "false">("all");
  const [stats, setStats] = useState<ShadowStats | null>(null);
  const [decisions, setDecisions] = useState<ShadowDecision[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const range = timeRange(timePreset);
    const params = new URLSearchParams();
    if (range.from) params.set("from", range.from);
    if (range.to) params.set("to", range.to);
    if (showResolved !== "all") params.set("resolved", showResolved);
    params.set("limit", "100");
    params.set("aggregate", "false");

    try {
      const [statsRes, listRes] = await Promise.all([
        fetch(`/api/shadow?${params}&limit=1&aggregate=true`),
        fetch(`/api/shadow?${params}`),
      ]);
      if (statsRes.ok) setStats(await statsRes.json());
      if (listRes.ok) {
        const data = await listRes.json();
        setDecisions(data.rows ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [timePreset, showResolved]);

  useEffect(() => { void fetchData(); }, [fetchData]);

  return (
    <AppShell title="Shadow Mode">
      {/* Time range + filter bar */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <Select value={timePreset} onValueChange={setTimePreset}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIME_PRESETS.map((p) => (
              <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={showResolved}
          onValueChange={(v) => setShowResolved(v as typeof showResolved)}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All bets</SelectItem>
            <SelectItem value="true">Resolved only</SelectItem>
            <SelectItem value="false">Unresolved only</SelectItem>
          </SelectContent>
        </Select>
        <button
          onClick={() => void fetchData()}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Refresh
        </button>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="decisions">Decisions</TabsTrigger>
          <TabsTrigger value="breakdown">Breakdown</TabsTrigger>
        </TabsList>

        {/* ---- Overview ---- */}
        <TabsContent value="overview" className="mt-4">
          {loading ? (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24" />)}
            </div>
          ) : stats ? (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard
                  label="Total shadow bets"
                  value={stats.total.toLocaleString()}
                  sub={`${stats.resolved} resolved · ${stats.unresolved} pending`}
                />
                <StatCard
                  label="Win rate"
                  value={stats.winRate}
                  sub={`${stats.wins}W / ${stats.losses}L / ${stats.voids}V`}
                  highlight
                />
                <StatCard
                  label="Avg ML multiplier"
                  value={parseFloat(stats.avgMlMultiplier).toFixed(3)}
                  sub="ML Kelly / raw Kelly"
                />
                <StatCard
                  label="Avg raw Kelly"
                  value={parseFloat(stats.avgKellyRaw).toFixed(4)}
                  sub="Raw Kelly fraction used"
                />
              </div>

              {/* Kelly comparison chart — simple bar viz */}
              <Card className="mt-4">
                <CardHeader>
                  <CardTitle>Shadow Kelly vs ML Kelly</CardTitle>
                  <CardDescription>
                    Each dot represents a placed bet. X = raw Kelly, Y = ML-adjusted Kelly.
                    Dots above the diagonal line (Y=X) favor ML Kelly sizing.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <KellyScatter decisions={decisions} />
                </CardContent>
              </Card>
            </>
          ) : (
            <p className="text-muted-foreground text-sm">No shadow decisions found for this period.</p>
          )}
        </TabsContent>

        {/* ---- Decisions list ---- */}
        <TabsContent value="decisions" className="mt-4">
          {loading ? (
            <div className="space-y-2">
              {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-14" />)}
            </div>
          ) : decisions.length === 0 ? (
            <p className="text-muted-foreground text-sm">No decisions match this filter.</p>
          ) : (
            <div className="space-y-2">
              {decisions.map((d) => (
                <DecisionRow key={d.id} decision={d} />
              ))}
            </div>
          )}
        </TabsContent>

        {/* ---- Outcome breakdown ---- */}
        <TabsContent value="breakdown" className="mt-4">
          {loading ? (
            <Skeleton className="h-40" />
          ) : stats && stats.resolved > 0 ? (
            <OutcomeBreakdown stats={stats} decisions={decisions} />
          ) : (
            <p className="text-muted-foreground text-sm">No resolved bets for breakdown yet.</p>
          )}
        </TabsContent>
      </Tabs>
    </AppShell>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: string;
  sub: string;
  highlight?: boolean;
}) {
  return (
    <Card className={cn(highlight && "border-emerald-500/40")}>
      <CardContent className="pt-4">
        <p className="text-xs text-muted-foreground mb-1">{label}</p>
        <p className="text-2xl font-mono font-semibold">{value}</p>
        <p className="text-xs text-muted-foreground mt-1">{sub}</p>
      </CardContent>
    </Card>
  );
}

function DecisionRow({ decision }: { decision: ShadowDecision }) {
  const outcomeColor = decision.outcome ? OUTCOME_COLORS[decision.outcome] : OUTCOME_COLORS.pending;
  const mlMult = decision.mlMultiplier ?? 1;
  const mlDirection = mlMult > 1.05 ? "text-emerald-500" : mlMult < 0.95 ? "text-red-400" : "text-muted-foreground";

  return (
    <div className="flex items-center gap-3 rounded-md border bg-card px-3 py-2 text-xs">
      <div className={cn("w-1.5 rounded-full h-8", outcomeColor)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-[10px] text-muted-foreground truncate max-w-[120px]">
            {decision.betId}
          </span>
          <Badge
            variant={decision.outcome ? "default" : "outline"}
            className="text-[10px] px-1.5 py-0"
          >
            {decision.outcome ?? "pending"}
          </Badge>
        </div>
        <div className="text-muted-foreground mt-0.5">
          {decision.placedAt
            ? new Date(decision.placedAt).toLocaleDateString("en-GB", {
                day: "2-digit",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })
            : "—"}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="font-mono">
          <span className="text-muted-foreground">shadow </span>
          <span className="font-semibold">
            {decision.shadowKelly != null ? decision.shadowKelly.toFixed(4) : "—"}
          </span>
        </div>
        <div className="font-mono">
          <span className="text-muted-foreground">ml </span>
          <span className="font-semibold">
            {decision.mlKelly != null ? decision.mlKelly.toFixed(4) : "—"}
          </span>
        </div>
        <div className={cn("font-mono text-[10px]", mlDirection)}>
          ×{mlMult.toFixed(3)}
        </div>
      </div>
    </div>
  );
}

/** Simple CSS scatter-plot using absolute positioning inside a relative container. */
function KellyScatter({ decisions }: { decisions: ShadowDecision[] }) {
  const valid = decisions.filter(
    (d) =>
      d.kellyRaw != null &&
      d.mlKelly != null &&
      d.kellyRaw > 0 &&
      d.mlKelly > 0,
  );
  if (valid.length === 0)
    return <p className="text-muted-foreground text-sm py-8 text-center">No data points to plot.</p>;

  // Normalise to [0,1] for display
  const maxKelly = Math.max(...valid.map((d) => Math.max(d.kellyRaw!, d.mlKelly!)));

  return (
    <div className="relative h-52 bg-muted/20 rounded border overflow-hidden">
      {/* Diagonal line Y=X */}
      <div
        className="absolute border-t border-dashed border-muted-foreground/30 pointer-events-none"
        style={{
          top: "50%",
          left: 0,
          right: 0,
        }}
      />
      <div className="absolute inset-0 flex items-center justify-center opacity-20">
        <span className="text-xs text-muted-foreground/60 rotate-[-90] translate-x-[-50%]">
          ML Kelly
        </span>
      </div>
      {valid.map((d, i) => {
        const x = (d.kellyRaw! / maxKelly) * 100;
        const y = 100 - (d.mlKelly! / maxKelly) * 100;
        return (
          <div
            key={d.id}
            title={`bet=${d.betId} | raw=${d.kellyRaw?.toFixed(3)} | ml=${d.mlKelly?.toFixed(3)} | outcome=${d.outcome ?? "pending"}`}
            className={cn(
              "absolute w-2 h-2 rounded-full border border-white/40",
              d.outcome === "win"
                ? "bg-emerald-500"
                : d.outcome === "lose"
                  ? "bg-red-500"
                  : d.outcome === "void"
                    ? "bg-slate-500"
                    : "bg-amber-400",
            )}
            style={{
              left: `${x}%`,
              top: `${y}%`,
              transform: "translate(-50%, -50%)",
              opacity: 0.8,
            }}
          />
        );
      })}
      <div className="absolute bottom-1 left-1 text-[10px] text-muted-foreground">
        Raw Kelly →
      </div>
    </div>
  );
}

function OutcomeBreakdown({
  stats,
  decisions,
}: {
  stats: ShadowStats;
  decisions: ShadowDecision[];
}) {
  const resolved = decisions.filter((d) => d.outcome != null);
  const byOutcome = resolved.reduce<Record<string, { count: number; mlMultipliers: number[] }>>(
    (acc, d) => {
      const o = d.outcome!;
      if (!acc[o]) acc[o] = { count: 0, mlMultipliers: [] };
      acc[o].count++;
      if (d.mlMultiplier != null) acc[o].mlMultipliers.push(d.mlMultiplier);
      return acc;
    },
    {},
  );

  const outcomes = ["win", "lose", "void"] as const;
  return (
    <div className="space-y-3">
      {outcomes.map((o) => {
        const data = byOutcome[o] ?? { count: 0, mlMultipliers: [] };
        const pct = stats.resolved > 0 ? (data.count / stats.resolved) * 100 : 0;
        const avgMult =
          data.mlMultipliers.length > 0
            ? data.mlMultipliers.reduce((a, b) => a + b, 0) / data.mlMultipliers.length
            : null;

        return (
          <div key={o} className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="capitalize font-medium">{o.replace("_", " ")}</span>
              <span className="font-mono">
                {data.count} ({pct.toFixed(1)}%)
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={cn("h-full rounded-full transition-all", OUTCOME_COLORS[o])}
                style={{ width: `${pct}%` }}
              />
            </div>
            {avgMult != null && (
              <p className="text-[10px] text-muted-foreground font-mono">
                Avg ML multiplier: ×{avgMult.toFixed(3)}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
