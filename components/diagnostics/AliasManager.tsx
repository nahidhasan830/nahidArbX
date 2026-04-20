"use client";

import { useState, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Plus,
  Trash2,
  ArrowRight,
  Bot,
  User,
  RefreshCw,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  DiagnosticsTable,
  TableCellMono,
  TableCellBadge,
  TableCellCount,
  type Column,
} from "./DiagnosticsTable";

// ============================================
// Types
// ============================================

interface AliasEntry {
  source: string;
  canonical: string;
  addedAt: string;
  addedBy?: string;
  autoLearned: boolean;
  occurrences: number;
}

interface AliasManagerProps {
  teamAliases: AliasEntry[];
  competitionAliases: AliasEntry[];
  onAddTeamAlias: (source: string, canonical: string) => Promise<void>;
  onAddCompetitionAlias: (source: string, canonical: string) => Promise<void>;
  onRemoveTeamAlias: (source: string) => Promise<void>;
  onRemoveCompetitionAlias: (source: string) => Promise<void>;
  onRefresh?: () => Promise<void>;
  isLoading?: boolean;
}

// ============================================
// Component
// ============================================

export function AliasManager({
  teamAliases,
  competitionAliases,
  onAddTeamAlias,
  onAddCompetitionAlias,
  onRemoveTeamAlias,
  onRemoveCompetitionAlias,
  onRefresh,
  isLoading,
}: AliasManagerProps) {
  const [activeTab, setActiveTab] = useState<"team" | "competition">("team");
  const [newSource, setNewSource] = useState("");
  const [newCanonical, setNewCanonical] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [removingSource, setRemovingSource] = useState<string | null>(null);
  const [filterOrigin, setFilterOrigin] = useState<"all" | "auto" | "manual">(
    "all",
  );

  const handleRefresh = useCallback(async () => {
    if (!onRefresh) return;
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  }, [onRefresh]);

  // Helper to deduplicate vice-versa entries (e.g., A→B and B→A)
  const deduplicateAliases = useCallback((aliases: AliasEntry[]) => {
    const seen = new Set<string>();
    const result: AliasEntry[] = [];

    for (const alias of aliases) {
      const key1 = `${alias.source.toLowerCase()}::${alias.canonical.toLowerCase()}`;
      const key2 = `${alias.canonical.toLowerCase()}::${alias.source.toLowerCase()}`;

      // Skip if we've already seen the reverse
      if (seen.has(key2)) continue;

      seen.add(key1);
      result.push(alias);
    }

    return result;
  }, []);

  // Deduplicated counts for tabs
  const deduplicatedTeamCount = useMemo(
    () => deduplicateAliases(teamAliases).length,
    [teamAliases, deduplicateAliases],
  );
  const deduplicatedCompetitionCount = useMemo(
    () => deduplicateAliases(competitionAliases).length,
    [competitionAliases, deduplicateAliases],
  );

  const rawAliases = activeTab === "team" ? teamAliases : competitionAliases;
  const deduplicatedAliases = useMemo(
    () => deduplicateAliases(rawAliases),
    [rawAliases, deduplicateAliases],
  );

  // Pre-filter by origin before passing to table
  const originFilteredAliases = useMemo(() => {
    if (filterOrigin === "all") return deduplicatedAliases;
    if (filterOrigin === "auto")
      return deduplicatedAliases.filter((a) => a.autoLearned);
    return deduplicatedAliases.filter((a) => !a.autoLearned);
  }, [deduplicatedAliases, filterOrigin]);

  const handleAdd = useCallback(async () => {
    if (!newSource.trim() || !newCanonical.trim()) return;
    setIsAdding(true);
    try {
      if (activeTab === "team") {
        await onAddTeamAlias(newSource.trim(), newCanonical.trim());
      } else {
        await onAddCompetitionAlias(newSource.trim(), newCanonical.trim());
      }
      setNewSource("");
      setNewCanonical("");
    } finally {
      setIsAdding(false);
    }
  }, [
    activeTab,
    newSource,
    newCanonical,
    onAddTeamAlias,
    onAddCompetitionAlias,
  ]);

  const handleRemove = useCallback(
    async (source: string) => {
      setRemovingSource(source);
      try {
        if (activeTab === "team") {
          await onRemoveTeamAlias(source);
        } else {
          await onRemoveCompetitionAlias(source);
        }
      } finally {
        setRemovingSource(null);
      }
    },
    [activeTab, onRemoveTeamAlias, onRemoveCompetitionAlias],
  );

  const autoCount = deduplicatedAliases.filter((a) => a.autoLearned).length;
  const manualCount = deduplicatedAliases.filter((a) => !a.autoLearned).length;

  // Define columns for the table
  const columns: Column<AliasEntry>[] = useMemo(
    () => [
      {
        id: "source",
        header: "Source",
        width: "flex-1",
        render: (alias) => (
          <TableCellMono className="text-zinc-400">
            {alias.source}
          </TableCellMono>
        ),
      },
      {
        id: "arrow",
        header: "",
        width: "w-5",
        align: "center",
        render: () => <ArrowRight className="w-4 h-4 text-zinc-600" />,
      },
      {
        id: "canonical",
        header: "Canonical",
        width: "flex-1",
        render: (alias) => (
          <TableCellMono className="text-zinc-200 font-medium">
            {alias.canonical}
          </TableCellMono>
        ),
      },
      {
        id: "origin",
        header: "Origin",
        width: "w-16",
        align: "center",
        render: (alias) => (
          <TableCellBadge variant={alias.autoLearned ? "auto" : "manual"}>
            {alias.autoLearned ? (
              <Bot className="w-3.5 h-3.5" />
            ) : (
              <User className="w-3.5 h-3.5" />
            )}
            {alias.autoLearned ? "Auto" : "Manual"}
          </TableCellBadge>
        ),
      },
      {
        id: "uses",
        header: "Uses",
        width: "w-12",
        align: "center",
        render: (alias) => <TableCellCount>{alias.occurrences}</TableCellCount>,
      },
      {
        id: "actions",
        header: "",
        width: "w-8",
        align: "center",
        render: (alias) => (
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleRemove(alias.source);
            }}
            disabled={removingSource === alias.source}
            className="p-1.5 rounded hover:bg-red-500/10 text-zinc-600 hover:text-red-500 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        ),
      },
    ],
    [handleRemove, removingSource],
  );

  // Filter actions for header
  const filterActions = (
    <>
      <div className="flex items-center gap-4 text-xs text-zinc-500">
        <span className="flex items-center gap-1.5">
          <Bot className="w-4 h-4" /> {autoCount}
        </span>
        <span className="flex items-center gap-1.5">
          <User className="w-4 h-4" /> {manualCount}
        </span>
      </div>
      <div className="flex items-center bg-zinc-800/50 rounded-md p-0.5">
        <button
          onClick={() => setFilterOrigin("all")}
          className={cn(
            "px-2.5 py-1 text-xs font-medium rounded",
            filterOrigin === "all"
              ? "bg-zinc-700 text-zinc-200"
              : "text-zinc-500",
          )}
        >
          All
        </button>
        <button
          onClick={() => setFilterOrigin("auto")}
          className={cn(
            "px-2 py-1 rounded",
            filterOrigin === "auto"
              ? "bg-zinc-700 text-zinc-200"
              : "text-zinc-500",
          )}
        >
          <Bot className="w-4 h-4" />
        </button>
        <button
          onClick={() => setFilterOrigin("manual")}
          className={cn(
            "px-2 py-1 rounded",
            filterOrigin === "manual"
              ? "bg-zinc-700 text-zinc-200"
              : "text-zinc-500",
          )}
        >
          <User className="w-4 h-4" />
        </button>
      </div>
    </>
  );

  return (
    <div className="h-full flex flex-col bg-zinc-900/30 rounded-lg border border-zinc-800 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/50">
        <div>
          <h2 className="text-base font-semibold text-zinc-100">
            Learned Aliases
          </h2>
          <p className="text-sm text-zinc-500">
            Mappings that improve event matching
          </p>
        </div>
        <div className="flex items-center gap-1">
          {onRefresh && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRefresh}
              disabled={isRefreshing || isLoading}
              className="h-8 w-8 p-0 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
            >
              <RefreshCw
                className={cn("w-4 h-4", isRefreshing && "animate-spin")}
              />
            </Button>
          )}
        </div>
      </div>

      {/* Type Toggle */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-zinc-800/50">
        <button
          onClick={() => setActiveTab("team")}
          className={cn(
            "px-3 py-1.5 text-sm font-medium rounded-md transition-colors",
            activeTab === "team"
              ? "bg-zinc-800 text-zinc-100"
              : "text-zinc-500 hover:text-zinc-300",
          )}
        >
          Teams ({deduplicatedTeamCount})
        </button>
        <button
          onClick={() => setActiveTab("competition")}
          className={cn(
            "px-3 py-1.5 text-sm font-medium rounded-md transition-colors",
            activeTab === "competition"
              ? "bg-zinc-800 text-zinc-100"
              : "text-zinc-500 hover:text-zinc-300",
          )}
        >
          Competitions ({deduplicatedCompetitionCount})
        </button>
      </div>

      {/* Add Form */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800/50">
        <Input
          placeholder="Variant (e.g., PSV)"
          value={newSource}
          onChange={(e) => setNewSource(e.target.value)}
          className="h-8 text-sm flex-1 bg-zinc-800/50 border-zinc-700/50 focus:border-violet-500/50"
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <ArrowRight className="w-4 h-4 text-zinc-600 shrink-0" />
        <Input
          placeholder="Canonical (e.g., PSV Eindhoven)"
          value={newCanonical}
          onChange={(e) => setNewCanonical(e.target.value)}
          className="h-8 text-sm flex-1 bg-zinc-800/50 border-zinc-700/50 focus:border-violet-500/50"
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <Button
          onClick={handleAdd}
          disabled={!newSource.trim() || !newCanonical.trim() || isAdding}
          size="sm"
          className="h-8 text-sm bg-violet-600 hover:bg-violet-700 text-white shrink-0"
        >
          <Plus className="w-4 h-4 mr-1.5" />
          Add
        </Button>
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0">
        <DiagnosticsTable
          data={originFilteredAliases}
          columns={columns}
          keyExtractor={(alias) => alias.source}
          searchable
          searchPlaceholder="Search aliases..."
          searchFilter={(alias, query) =>
            alias.source.toLowerCase().includes(query) ||
            alias.canonical.toLowerCase().includes(query)
          }
          headerActions={filterActions}
          emptyIcon={<Search className="w-10 h-10 opacity-30" />}
          emptyTitle={
            deduplicatedAliases.length === 0 ? "No aliases yet" : "No matches"
          }
          emptyDescription={
            deduplicatedAliases.length === 0
              ? "Confirm near-matches or add manually"
              : undefined
          }
          isLoading={isLoading}
        />
      </div>
    </div>
  );
}

export default AliasManager;
