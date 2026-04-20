"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { AliasManager } from "./AliasManager";
import { MatchReviewPanel } from "./MatchReviewPanel";
import { CleanupPanel } from "@/components/monitoring/CleanupPanel";

interface AliasEntry {
  source: string;
  canonical: string;
  addedAt: string;
  addedBy?: string;
  autoLearned: boolean;
  occurrences: number;
}

type SubView = "review" | "aliases" | "cleanup";

export function DiagnosticsTab() {
  const [subView, setSubView] = useState<SubView>("review");
  const [isLoading, setIsLoading] = useState(true);
  const [teamAliases, setTeamAliases] = useState<AliasEntry[]>([]);
  const [competitionAliases, setCompetitionAliases] = useState<AliasEntry[]>(
    [],
  );

  const fetchAliases = useCallback(async () => {
    setIsLoading(true);
    try {
      const aliasRes = await fetch("/api/diagnostics?view=aliases");
      if (aliasRes.ok) {
        const aliasData = await aliasRes.json();
        setTeamAliases(aliasData.teamAliases || []);
        setCompetitionAliases(aliasData.competitionAliases || []);
      }
    } catch (error) {
      console.error("Failed to fetch aliases:", error);
      toast.error("Couldn't load aliases", {
        description: "Check your connection and try again",
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (subView === "aliases") fetchAliases();
  }, [fetchAliases, subView]);

  const aliasAction = useCallback(
    async (action: string, payload: Record<string, unknown>) => {
      try {
        const res = await fetch("/api/diagnostics", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...payload }),
        });
        const data = await res.json();
        if (res.ok && data.success) {
          toast.success("Alias updated", {
            description: data.message || undefined,
          });
          await fetchAliases();
        } else {
          toast.error("Couldn't update alias", {
            description: data.error || "Unknown error",
          });
        }
      } catch {
        toast.error("Couldn't update alias", {
          description: "Network error — please try again",
        });
      }
    },
    [fetchAliases],
  );

  const tabButton = (id: SubView, label: string, count?: number) => (
    <button
      onClick={() => setSubView(id)}
      className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
        subView === id
          ? "bg-zinc-800 text-zinc-100"
          : "text-zinc-500 hover:text-zinc-300"
      }`}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span className="ml-1.5 text-[10px] text-zinc-400">({count})</span>
      )}
    </button>
  );

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex items-center gap-1 px-3 py-2 border-b border-zinc-800/50">
        {tabButton("review", "Match Review")}
        {tabButton("aliases", "Aliases")}
        {tabButton("cleanup", "Cleanup")}
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {subView === "review" && <MatchReviewPanel />}
        {subView === "aliases" && (
          <div className="h-full p-2">
            <AliasManager
              teamAliases={teamAliases}
              competitionAliases={competitionAliases}
              onAddTeamAlias={(s, c) =>
                aliasAction("add-team-alias", { source: s, canonical: c })
              }
              onAddCompetitionAlias={(s, c) =>
                aliasAction("add-competition-alias", {
                  source: s,
                  canonical: c,
                })
              }
              onRemoveTeamAlias={(s) =>
                aliasAction("remove-team-alias", { source: s })
              }
              onRemoveCompetitionAlias={(s) =>
                aliasAction("remove-competition-alias", { source: s })
              }
              onRefresh={fetchAliases}
              isLoading={isLoading}
            />
          </div>
        )}
        {subView === "cleanup" && (
          <div className="h-full p-2">
            <CleanupPanel />
          </div>
        )}
      </div>
    </div>
  );
}

export default DiagnosticsTab;
