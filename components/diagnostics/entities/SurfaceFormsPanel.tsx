"use client";

/**
 * Surface forms tab — every entity_names row, filterable by status /
 * provider / search. The promoter's primary work surface; clicking a
 * row's "Promote" or "Retire" mutates immediately and re-fetches.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Search } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { entitiesAction, fetchSurfaceForms } from "./api";
import { EmptyHint, StatusPill, relativeTime } from "./atoms";
import type { EntityName } from "./types";

const PROVIDERS = [
  "all",
  "pinnacle",
  "ninewickets-exchange",
  "ninewickets-sportsbook",
  "betconstruct",
  "settle",
  "match-review",
  "harvester",
  "learner",
  "seed",
  "manual",
];

export function SurfaceFormsPanel({ onMutated }: { onMutated: () => void }) {
  const [statusFilter, setStatusFilter] = useState<
    "all" | "candidate" | "active" | "retired"
  >("candidate");
  const [provider, setProvider] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<EntityName[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(
        await fetchSurfaceForms({
          status: statusFilter === "all" ? undefined : statusFilter,
          provider: provider === "all" ? undefined : provider,
          search,
          limit: 1000,
        }),
      );
    } finally {
      setLoading(false);
    }
  }, [statusFilter, provider, search]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const action = useCallback(
    async (body: Record<string, unknown>, msg: string) => {
      const r = await entitiesAction(body);
      if (!r.success) {
        toast.error("Action failed", { description: r.error });
        return;
      }
      toast.success(msg);
      await refresh();
      onMutated();
    },
    [refresh, onMutated],
  );

  const columns = useMemo<ColumnDef<EntityName, unknown>[]>(
    () => [
      {
        accessorKey: "surfaceRaw",
        header: "Surface",
        cell: (c) => {
          const row = c.row.original;
          return (
            <div>
              <div className="text-zinc-200">{row.surfaceRaw}</div>
              <div className="text-[9px] text-zinc-600 font-mono">
                {row.surfaceNormalized}
              </div>
            </div>
          );
        },
        meta: { initialSize: 240 },
      },
      {
        accessorKey: "provider",
        header: "Provider",
        cell: (c) => (
          <span className="font-mono text-[10px] text-zinc-400">
            {String(c.getValue() ?? "")}
          </span>
        ),
        meta: { initialSize: 130 },
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: (c) => (
          <StatusPill status={c.getValue() as EntityName["status"]} />
        ),
        meta: { initialSize: 90, align: "center" },
      },
      {
        accessorKey: "weight",
        header: "Weight",
        cell: (c) => (c.getValue() as number).toFixed(1),
        meta: { initialSize: 70, align: "right" },
      },
      {
        id: "obs",
        header: "Pos / Neg",
        accessorFn: (r) => `${r.positiveObs}/${r.negativeObs}`,
        cell: (c) => {
          const r = c.row.original;
          return (
            <span className="tabular-nums">
              <span className="text-emerald-400">{r.positiveObs}</span>
              <span className="text-zinc-600 mx-1">/</span>
              <span className="text-rose-400">{r.negativeObs}</span>
            </span>
          );
        },
        meta: { initialSize: 100, align: "right" },
      },
      {
        accessorKey: "classifierScore",
        header: "Score",
        cell: (c) => {
          const v = c.getValue() as number | null;
          if (v == null) return "—";
          const tone =
            v >= 0.92
              ? "text-emerald-300"
              : v >= 0.5
                ? "text-amber-300"
                : "text-zinc-500";
          return (
            <span className={cn("tabular-nums", tone)}>{v.toFixed(3)}</span>
          );
        },
        meta: {
          initialSize: 80,
          align: "right",
          hint: "Tier-2 ML probability",
        },
      },
      {
        accessorKey: "lastSeenAt",
        header: "Last seen",
        cell: (c) => relativeTime(c.getValue() as string),
        meta: { initialSize: 100, align: "right" },
      },
      {
        id: "actions",
        header: "Actions",
        accessorFn: () => "",
        cell: (c) => {
          const n = c.row.original;
          return (
            <div className="flex items-center gap-2 justify-end">
              {n.status === "candidate" && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void action(
                      { action: "promote-name", entityNameId: n.id },
                      `Promoted "${n.surfaceRaw}"`,
                    );
                  }}
                  className="text-[10px] text-emerald-400 hover:text-emerald-300"
                >
                  Promote
                </button>
              )}
              {n.status !== "retired" && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void action(
                      { action: "retire-name", entityNameId: n.id },
                      `Retired "${n.surfaceRaw}"`,
                    );
                  }}
                  className="text-[10px] text-zinc-500 hover:text-rose-400"
                >
                  Retire
                </button>
              )}
            </div>
          );
        },
        meta: { initialSize: 130, align: "right", fixed: "right" },
      },
    ],
    [action],
  );

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/50">
        <div className="flex items-center bg-muted/40 rounded-md p-0.5">
          {(["candidate", "active", "retired", "all"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={cn(
                "px-2.5 py-1 text-[11px] rounded font-medium",
                statusFilter === s
                  ? "bg-zinc-700 text-zinc-100"
                  : "text-zinc-500",
              )}
            >
              {s}
            </button>
          ))}
        </div>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="h-7 text-[11px] bg-muted/40 border border-zinc-700/50 rounded px-2"
        >
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p === "all" ? "All providers" : p}
            </option>
          ))}
        </select>
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2 top-2 w-3.5 h-3.5 text-zinc-600" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search surface…"
            className="h-7 pl-7 text-xs bg-muted/40 border-zinc-700/50"
          />
        </div>
        <div className="text-[11px] text-zinc-500 ml-auto">
          {items.length} row{items.length === 1 ? "" : "s"}
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {items.length === 0 && !loading ? (
          <EmptyHint
            title="No surface forms"
            description="Try widening the filters or wait for the next sync."
          />
        ) : (
          <DataTable
            data={items}
            columns={columns}
            getRowId={(r) => r.id}
            enableSorting
            enableColumnResizing
            enableColumnOrdering
            enableVirtualization
            persistenceKey="surface-forms-table"
            density="compact"
            loading={loading}
          />
        )}
      </div>
    </div>
  );
}
