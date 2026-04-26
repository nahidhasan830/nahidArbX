"use client";

/**
 * Entities tab — virtualized DataTable of every (non-retired) entity.
 *
 * Filter: kind (team/competition), search by canonical name.
 * Click → opens EntityDrawer side panel.
 * Sortable + resizable + persisted column state.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { fetchEntities } from "./api";
import { EntityDrawer } from "./EntityDrawer";
import { EmptyHint, relativeTime } from "./atoms";
import type { Entity } from "./types";

export function EntitiesPanel({ onMutated }: { onMutated: () => void }) {
  const [kind, setKind] = useState<"team" | "competition">("team");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<Entity[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await fetchEntities({ kind, search, limit: 1000 }));
    } finally {
      setLoading(false);
    }
  }, [kind, search]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const columns = useMemo<ColumnDef<Entity, unknown>[]>(
    () => [
      {
        accessorKey: "canonicalName",
        header: "Canonical name",
        meta: { initialSize: 240 },
      },
      {
        id: "id",
        accessorKey: "id",
        header: "ID",
        cell: (c) => (
          <span className="font-mono text-zinc-500 text-[10px]">
            {String(c.getValue() ?? "")}
          </span>
        ),
        meta: {
          initialSize: 320,
          hint: "Deterministic kind|country|gender|slug",
        },
      },
      {
        accessorKey: "country",
        header: "Country",
        cell: (c) => c.getValue() ?? "—",
        meta: { initialSize: 80, align: "center" },
      },
      {
        accessorKey: "gender",
        header: "G",
        cell: (c) => {
          const v = c.getValue() as string | null;
          if (!v) return "—";
          return v === "f" ? "♀" : "♂";
        },
        meta: { initialSize: 50, align: "center", hint: "Gender" },
      },
      {
        id: "variant",
        header: "Variant",
        accessorFn: (e) => (e.metadata?.variant as string | undefined) ?? "",
        cell: (c) => {
          const v = c.getValue() as string;
          return v ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 uppercase">
              {v}
            </span>
          ) : (
            <span className="text-zinc-600">senior</span>
          );
        },
        meta: { initialSize: 90, align: "center" },
      },
      {
        accessorKey: "createdAt",
        header: "Created",
        cell: (c) => relativeTime(c.getValue() as string),
        meta: { initialSize: 100, align: "right" },
      },
    ],
    [],
  );

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/50">
        <div className="flex items-center bg-muted/40 rounded-md p-0.5">
          <button
            onClick={() => setKind("team")}
            className={cn(
              "px-3 py-1 text-[11px] rounded font-medium",
              kind === "team" ? "bg-zinc-700 text-zinc-100" : "text-zinc-500",
            )}
          >
            Teams
          </button>
          <button
            onClick={() => setKind("competition")}
            className={cn(
              "px-3 py-1 text-[11px] rounded font-medium",
              kind === "competition"
                ? "bg-zinc-700 text-zinc-100"
                : "text-zinc-500",
            )}
          >
            Competitions
          </button>
        </div>
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2 top-2 w-3.5 h-3.5 text-zinc-600" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search canonical name…"
            className="h-7 pl-7 text-xs bg-muted/40 border-zinc-700/50"
          />
        </div>
        <div className="text-[11px] text-zinc-500 ml-auto">
          {items.length} {kind}
          {items.length === 1 ? "" : "s"}
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {items.length === 0 && !loading ? (
          <EmptyHint
            title="No entities yet"
            description="Run a sync to populate the entity store."
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
            persistenceKey="entities-table"
            density="compact"
            loading={loading}
            onRowClick={(r) => setSelectedId(r.id)}
            rowClassName={(r) =>
              r.id === selectedId ? "bg-zinc-800/50" : undefined
            }
          />
        )}
      </div>

      {selectedId && (
        <EntityDrawer
          id={selectedId}
          onClose={() => setSelectedId(null)}
          onMutated={() => {
            void refresh();
            onMutated();
          }}
        />
      )}
    </div>
  );
}
