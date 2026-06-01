"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Database, MemoryStick, AlertTriangle, CircleAlert } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DataTable } from "@/components/ui/data-table";
import { cn } from "@/lib/utils";
import type {
  MemoryDiagnostic as MemoryDiagnosticData,
  MemoryDiagnosticStore,
} from "@/app/api/logs/memory/route";
import { SectionHeader } from "./MemoryPrimitives";

type ValueTone = "neutral" | "good" | "warn" | "bad";

function valueToneClass(tone: ValueTone): string {
  switch (tone) {
    case "good":
      return "text-emerald-700 dark:text-emerald-300";
    case "warn":
      return "text-amber-700 dark:text-amber-300";
    case "bad":
      return "text-rose-700 dark:text-rose-300";
    default:
      return "text-foreground/80";
  }
}

const STORE_LABELS: Record<string, string> = {
  oddsHistory: "Odds History",
  atomsOdds: "Atoms Odds",
  scores: "Scores",
  multiSourceScores: "Multi-Source Scores",
  marketLimits: "Market Limits",
  matchCache: "Match Cache",
  aiDecisionCache: "AI Decision Cache",
  sessionDiagnostics: "Session Diagnostics",
  valueBets: "Value Bets",
  events: "Events",
  deltaSnapshot: "Delta Snapshot",
};

type IssueCode = "NO_CLEANUP" | "NO_EVICTION" | "UNBOUNDED";

const ISSUE_MAP: Record<string, IssueCode> = {
  "NO CLEANUP - grows forever": "NO_CLEANUP",
  "NO EVICTION - grow only": "NO_EVICTION",
  "UNBOUNDED growth": "UNBOUNDED",
};

const RISK_TONE: Record<
  IssueCode,
  { badge: string; label: string; tone: ValueTone }
> = {
  NO_CLEANUP: {
    badge:
      "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    label: "HIGH RISK",
    tone: "bad",
  },
  NO_EVICTION: {
    badge:
      "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    label: "MEDIUM RISK",
    tone: "warn",
  },
  UNBOUNDED: {
    badge:
      "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    label: "HIGH RISK",
    tone: "bad",
  },
};

const OK_BADGE =
  "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";

function riskFor(issue?: string): {
  badge: string;
  label: string;
  tone: ValueTone;
} {
  if (!issue) return { badge: OK_BADGE, label: "OK", tone: "good" };
  const code = ISSUE_MAP[issue] ?? "NO_CLEANUP";
  return RISK_TONE[code];
}

function formatStoreDetails(
  key: string,
  store: MemoryDiagnosticStore,
): string {
  switch (key) {
    case "oddsHistory":
      return `${(store.trackedAtoms ?? 0).toLocaleString()} atoms, ${(store.totalTicks ?? 0).toLocaleString()} ticks`;
    case "atomsOdds":
      return `${store.events ?? 0} events, ${store.families ?? 0} families, ${store.atoms ?? 0} atoms, ${(store.oddsRecords ?? 0).toLocaleString()} records`;
    case "scores":
      return `${store.live ?? 0} live, ${store.corners ?? 0} corners`;
    case "multiSourceScores":
      return `${(store.entries ?? 0).toLocaleString()} entries`;
    case "marketLimits":
      return `${(store.entries ?? 0).toLocaleString()} entries`;
    case "matchCache": {
      const skip = (store.bucketSkipRate ?? 0) * 100;
      return `${store.cachedEvents ?? 0} events cached, skip ${skip.toFixed(0)}%`;
    }
    case "aiDecisionCache":
      return `${(store.total ?? 0).toLocaleString()} decisions`;
    case "sessionDiagnostics":
      return `${store.providers ?? 0} providers, ${(store.totalSteps ?? 0).toLocaleString()} steps`;
    case "valueBets":
      return `${(store.count ?? 0).toLocaleString()} active`;
    case "events":
      return `${(store.count ?? 0).toLocaleString()} normalized`;
    case "deltaSnapshot":
      return store.hasSnapshot
        ? `${store.snapshotValueBets ?? 0} bets duplicated`
        : "No snapshot";
    default:
      return "-";
  }
}

function formatMB(mb: number | undefined, digits = 2): string {
  if (mb === undefined) return "-";
  return `${mb.toFixed(digits)} MB`;
}

function Bar({ value, total, tone }: { value: number; total: number; tone: ValueTone }) {
  const pct =
    total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0;
  const barClass =
    tone === "good"
      ? "bg-emerald-500"
      : tone === "warn"
        ? "bg-amber-500"
        : tone === "bad"
          ? "bg-rose-500"
          : "bg-cyan-500";
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-sm bg-muted"
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn("h-full rounded-sm transition-all", barClass)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

type StoreRow = {
  key: string;
  label: string;
  details: string;
  estimatedMB: number | undefined;
  risk: { badge: string; label: string; tone: ValueTone };
  issue: string | undefined;
};

const HEAP_HINT =
  "V8 managed heap. Used / Total in MB. Total is the resident heap the engine has reserved from the OS.";

const RSS_HINT =
  "Resident set size: total memory the engine process holds from the OS, including native buffers and the V8 heap.";

const EXTERNAL_HINT =
  "Memory used by C++ objects bound to JavaScript objects via V8. Buffer-backed caches show up here.";

const ACCOUNTED_HINT =
  "Sum of per-store estimates that report estimatedMB. Currently 1 of 11 stores reports a memory estimate.";

const UNACCOUNTED_HINT =
  "Heap used minus the stores that report a per-store estimate. Covers V8 overhead, native buffers, and stores without per-store accounting.";

const HIGH_RISK_HINT =
  "Stores flagged by the engine for unbounded growth or missing cleanup. Investigate before the next deploy.";

const MEASURED_HINT =
  "Number of stores that report a per-store estimatedMB. The rest contribute to unaccounted memory via V8 and native allocations.";

export function useMemoryDiagnostic(refreshIntervalMs = 10_000) {
  return useQuery<MemoryDiagnosticData>({
    queryKey: ["memory-diagnostic"],
    queryFn: async () => {
      const res = await fetch("/api/logs/memory", { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    refetchInterval: refreshIntervalMs,
    staleTime: refreshIntervalMs,
    retry: 1,
  });
}

export function MemoryDiagnosticContent({
  data,
}: {
  data: MemoryDiagnosticData;
}) {
  const { process: proc, stores } = data;

  const sortedRows = useMemo<StoreRow[]>(() => {
    return Object.entries(stores)
      .map<StoreRow>(([key, store]) => ({
        key,
        label: STORE_LABELS[key] ?? key,
        details: formatStoreDetails(key, store),
        estimatedMB: store.estimatedMB,
        risk: riskFor(store.issue),
        issue: store.issue,
      }))
      .sort(
        (a, b) =>
          (b.estimatedMB ?? -1) - (a.estimatedMB ?? -1) ||
          a.label.localeCompare(b.label),
      );
  }, [stores]);

  const totals = useMemo(() => {
    const totalEstimated = Object.values(stores).reduce(
      (sum, s) => sum + (s.estimatedMB ?? 0),
      0,
    );
    const measured = Object.values(stores).filter(
      (s) => s.estimatedMB !== undefined,
    ).length;
    const high = Object.values(stores).filter(
      (s) => s.issue && ISSUE_MAP[s.issue] === "NO_CLEANUP",
    ).length;
    const medium = Object.values(stores).filter(
      (s) => s.issue && ISSUE_MAP[s.issue] === "NO_EVICTION",
    ).length;
    return {
      totalEstimated,
      measured,
      storeCount: Object.keys(stores).length,
      high,
      medium,
    };
  }, [stores]);

  const unaccountedMB = proc.heapUsedMB - totals.totalEstimated;
  const heapPct =
    proc.heapTotalMB > 0
      ? (proc.heapUsedMB / proc.heapTotalMB) * 100
      : 0;

  const heapTone: ValueTone =
    heapPct >= 90 ? "bad" : heapPct >= 75 ? "warn" : "good";

  const columns = useMemo<ColumnDef<StoreRow, unknown>[]>(
    () => [
      {
        id: "store",
        header: "Store",
        accessorKey: "label",
        cell: ({ row }) => (
          <span className="font-medium text-foreground/90">
            {row.original.label}
          </span>
        ),
        meta: {
          align: "left",
          initialSize: 200,
          hint: "In-process store that holds runtime state. Click to sort.",
        },
      },
      {
        id: "details",
        header: "Details",
        accessorKey: "details",
        cell: ({ row }) => (
          <span className="text-[11px] text-muted-foreground">
            {row.original.details}
          </span>
        ),
        meta: {
          align: "left",
          initialSize: 340,
          hint: "Quick read of the store's working-set size: counts, rates, and key dimensions.",
        },
      },
      {
        id: "est",
        header: "Est. MB",
        accessorKey: "estimatedMB",
        cell: ({ row }) =>
          row.original.estimatedMB === undefined ? (
            <span className="text-muted-foreground/60">-</span>
          ) : (
            <span className="font-mono text-xs font-semibold tabular-nums">
              {formatMB(row.original.estimatedMB)}
            </span>
          ),
        sortingFn: (a, b, columnId) => {
          const av = a.getValue<number | undefined>(columnId);
          const bv = b.getValue<number | undefined>(columnId);
          return (av ?? -1) - (bv ?? -1);
        },
        meta: {
          align: "right",
          initialSize: 110,
          hint: "Per-store memory estimate in MB. A dash means the store does not report one.",
        },
      },
      {
        id: "risk",
        header: "Risk",
        accessorFn: (row) => row.risk.label,
        cell: ({ row }) => (
          <Badge
            variant="outline"
            className={cn(
              "h-5 rounded-md px-1.5 text-[11px] font-semibold",
              row.original.risk.badge,
            )}
          >
            {row.original.risk.label}
          </Badge>
        ),
        meta: {
          align: "left",
          initialSize: 130,
          hint: "Engine flag. HIGH RISK covers NO CLEANUP and UNBOUNDED issues. MEDIUM RISK covers NO EVICTION.",
        },
      },
      {
        id: "issue",
        header: "Issue",
        accessorKey: "issue",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.issue ? (
            <div className="flex items-center gap-1.5 truncate text-rose-700 dark:text-rose-300">
              <CircleAlert className="size-3 shrink-0" />
              <span className="truncate text-[11px]">
                {row.original.issue}
              </span>
            </div>
          ) : (
            <span className="text-muted-foreground/60">-</span>
          ),
        meta: {
          align: "left",
          initialSize: 260,
          hint: "Server-emitted issue string. Hover the risk badge for the full risk rule.",
        },
      },
    ],
    [],
  );

  return (
    <div className="grid w-full gap-3">
      <section className="rounded-md border border-border bg-card p-3 shadow-sm">
        <SectionHeader
          icon={MemoryStick}
          title="Process memory"
          description="Live memory footprint of the engine process, polled from Node.js runtime metrics."
        />
        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          <ProcessTile
            label="Heap used"
            value={`${formatMB(proc.heapUsedMB, 1)}`}
            sub={`${heapPct.toFixed(0)}% of ${formatMB(proc.heapTotalMB, 0)}`}
            tone={heapTone}
            hint={HEAP_HINT}
            footer={<Bar value={proc.heapUsedMB} total={proc.heapTotalMB} tone={heapTone} />}
          />
          <ProcessTile
            label="Heap total"
            value={formatMB(proc.heapTotalMB, 0)}
            sub="V8 reserved"
            hint="V8 reserved heap. Grows in chunks as the engine allocates; not a hard cap."
          />
          <ProcessTile
            label="RSS"
            value={formatMB(proc.rssMB, 0)}
            sub="resident set"
            hint={RSS_HINT}
          />
          <ProcessTile
            label="External"
            value={formatMB(proc.externalMB, 0)}
            sub="native buffers"
            hint={EXTERNAL_HINT}
          />
        </div>
      </section>

      <section className="rounded-md border border-border bg-card p-3 shadow-sm">
        <SectionHeader
          icon={Database}
          title="Stores accounting"
          description="How much of the heap is owned by stores that report a memory estimate, and which still need attention."
        />
        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          <AccountTile
            label="Accounted"
            value={formatMB(totals.totalEstimated, 1)}
            sub="sum of per-store estimates"
            tone="good"
            hint={ACCOUNTED_HINT}
            footer={
              <Bar
                value={totals.totalEstimated}
                total={proc.heapUsedMB}
                tone="good"
              />
            }
          />
          <AccountTile
            label="Unaccounted"
            value={`${unaccountedMB >= 0 ? "" : "-"}${formatMB(Math.abs(unaccountedMB), 1)}`}
            sub={`${totals.measured}/${totals.storeCount} stores report`}
            tone={unaccountedMB > proc.heapUsedMB * 0.5 ? "warn" : "neutral"}
            hint={UNACCOUNTED_HINT}
            footer={
              <Bar
                value={Math.max(0, unaccountedMB)}
                total={proc.heapUsedMB}
                tone={unaccountedMB > proc.heapUsedMB * 0.5 ? "warn" : "neutral"}
              />
            }
          />
          <AccountTile
            label="High risk"
            value={String(totals.high)}
            sub={`${totals.medium} medium`}
            tone={totals.high > 0 ? "bad" : "good"}
            hint={HIGH_RISK_HINT}
          />
          <AccountTile
            label="Measured stores"
            value={`${totals.measured}/${totals.storeCount}`}
            sub="with per-store estimate"
            tone={totals.measured === totals.storeCount ? "good" : "warn"}
            hint={MEASURED_HINT}
          />
        </div>
      </section>

      <section className="rounded-md border border-border bg-card shadow-sm">
        <div className="flex items-start gap-2.5 p-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
            <AlertTriangle className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Store breakdown</h2>
            <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
              Per-store working set, risk tier, and any issue the engine has
              flagged. Sort columns by clicking the header.
            </p>
          </div>
        </div>
        <div className="border-t border-border">
          <DataTable<StoreRow>
            data={sortedRows}
            columns={columns}
            getRowId={(row) => row.key}
            enableSorting
            enableColumnResizing
            density="compact"
            rowHeight={34}
            className="border-0"
            renderEmpty={() => (
              <div className="flex flex-col items-center gap-1.5 py-10 text-muted-foreground">
                <span className="text-sm font-medium">No stores reported</span>
                <span className="text-[11px] opacity-70">
                  The engine did not return any store diagnostics on this poll.
                </span>
              </div>
            )}
          />
        </div>
      </section>
    </div>
  );
}

function ProcessTile({
  label,
  value,
  sub,
  tone = "neutral",
  hint,
  footer,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: ValueTone;
  hint: string;
  footer?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <Hint label={label} hint={hint} />
      </div>
      <p
        className={cn(
          "mt-1 font-mono text-2xl font-semibold tabular-nums",
          valueToneClass(tone),
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>
      {footer ? <div className="mt-2">{footer}</div> : null}
    </div>
  );
}

function AccountTile({
  label,
  value,
  sub,
  tone = "neutral",
  hint,
  footer,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: ValueTone;
  hint: string;
  footer?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <Hint label={label} hint={hint} />
      </div>
      <p
        className={cn(
          "mt-1 font-mono text-2xl font-semibold tabular-nums",
          valueToneClass(tone),
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>
      {footer ? <div className="mt-2">{footer}</div> : null}
    </div>
  );
}

function Hint({ label, hint }: { label: string; hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${label} explanation`}
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span className="font-mono text-[10px] font-semibold">?</span>
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={6}
        className="max-w-[280px] text-sm leading-snug"
      >
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}
