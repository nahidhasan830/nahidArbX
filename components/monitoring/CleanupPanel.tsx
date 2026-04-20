"use client";

import React, { useState, useCallback, useEffect } from "react";
import {
  Trash2,
  RefreshCw,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  HardDrive,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ============================================
// Types
// ============================================

interface CleanupTarget {
  id: string;
  name: string;
  description: string;
  size: string;
  sizeBytes: number;
  count?: number;
  recommended: boolean;
  severity: "high" | "medium" | "low";
}

interface CleanupResult {
  id: string;
  success: boolean;
  freed?: string;
  error?: string;
}

// ============================================
// Component
// ============================================

export function CleanupPanel() {
  const [targets, setTargets] = useState<CleanupTarget[]>([]);
  const [totalSize, setTotalSize] = useState("");
  const [recommendedCount, setRecommendedCount] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [isCleaning, setIsCleaning] = useState(false);
  const [results, setResults] = useState<CleanupResult[] | null>(null);

  const fetchTargets = useCallback(async () => {
    try {
      const res = await fetch("/api/system/cleanup");
      if (!res.ok) return;
      const data = await res.json();
      setTargets(data.targets || []);
      setTotalSize(data.summary?.totalSize || "0 B");
      setRecommendedCount(data.summary?.recommendedCleanups || 0);

      // Auto-select recommended targets
      const recommended = new Set<string>(
        (data.targets || [])
          .filter((t: CleanupTarget) => t.recommended)
          .map((t: CleanupTarget) => t.id),
      );
      setSelected(recommended);
    } catch {
      // silent
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTargets();
  }, [fetchTargets]);

  const handleCleanup = async () => {
    if (selected.size === 0) {
      toast.error("Nothing to clean", {
        description: "Select at least one target",
      });
      return;
    }

    setIsCleaning(true);
    setResults(null);

    try {
      const res = await fetch("/api/system/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets: Array.from(selected) }),
      });
      const data = await res.json();

      if (data.success) {
        setResults(data.results);
        const successCount = data.results.filter(
          (r: CleanupResult) => r.success,
        ).length;
        const failCount = data.results.length - successCount;
        toast.success(
          `Cleaned ${successCount} target${successCount === 1 ? "" : "s"}`,
          {
            description:
              failCount > 0
                ? `${failCount} failed — see results below`
                : "See results below for details",
          },
        );
        // Refresh targets after cleanup
        await fetchTargets();
      } else {
        toast.error("Couldn't clean up", {
          description: data.error || "Unknown error",
        });
      }
    } catch {
      toast.error("Cleanup failed", {
        description: "Network error — please try again",
      });
    } finally {
      setIsCleaning(false);
    }
  };

  const toggleTarget = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectRecommended = () => {
    setSelected(new Set(targets.filter((t) => t.recommended).map((t) => t.id)));
  };

  const selectAll = () => {
    setSelected(new Set(targets.map((t) => t.id)));
  };

  const selectNone = () => {
    setSelected(new Set());
  };

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center bg-zinc-900/50 rounded-lg border border-zinc-800">
        <Loader2 className="w-5 h-5 animate-spin text-zinc-500" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-zinc-900/30 rounded-lg border border-zinc-800 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/50">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-red-500 to-orange-600 flex items-center justify-center">
            <Trash2 className="w-4.5 h-4.5 text-white" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-zinc-100">
              Data Cleanup
            </h2>
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <HardDrive className="w-3 h-3" />
              <span>{totalSize} total</span>
              {recommendedCount > 0 && (
                <span className="text-amber-400">
                  {recommendedCount} recommended
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={fetchTargets}
            className="h-7 w-7 p-0 border-zinc-700"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
          <Button
            size="sm"
            onClick={handleCleanup}
            disabled={selected.size === 0 || isCleaning}
            className="h-8 text-sm bg-red-600 hover:bg-red-700 text-white"
          >
            {isCleaning ? (
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5 mr-1.5" />
            )}
            Clean ({selected.size})
          </Button>
        </div>
      </div>

      {/* Quick Select */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800/30 text-xs">
        <button
          onClick={selectRecommended}
          className="text-amber-400 hover:text-amber-300 font-medium"
        >
          Recommended
        </button>
        <button
          onClick={selectAll}
          className="text-zinc-500 hover:text-zinc-300"
        >
          All
        </button>
        <button
          onClick={selectNone}
          className="text-zinc-500 hover:text-zinc-300"
        >
          None
        </button>
        <span className="text-zinc-600 ml-auto">{selected.size} selected</span>
      </div>

      {/* Results banner */}
      {results && (
        <div className="px-4 py-2 border-b border-zinc-800/50 bg-emerald-500/5">
          <div className="flex items-center gap-2 text-xs">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
            <span className="text-emerald-400">
              Cleaned {results.filter((r) => r.success).length} targets
            </span>
            {results
              .filter((r) => r.freed && r.freed !== "0 B")
              .map((r) => (
                <span key={r.id} className="text-zinc-500">
                  {r.id}: {r.freed}
                </span>
              ))}
            <button
              onClick={() => setResults(null)}
              className="text-zinc-600 hover:text-zinc-400 ml-auto"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Targets List */}
      <div className="flex-1 overflow-auto">
        <div className="divide-y divide-zinc-800/20">
          {targets.map((target) => (
            <div
              key={target.id}
              className={cn(
                "flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-zinc-800/20 transition-colors",
                selected.has(target.id) && "bg-red-500/5",
              )}
              onClick={() => toggleTarget(target.id)}
            >
              <Checkbox
                checked={selected.has(target.id)}
                className="mt-0.5 pointer-events-none border-zinc-600 data-[state=checked]:bg-red-600 data-[state=checked]:border-red-600"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm text-zinc-200">{target.name}</p>
                  {target.recommended && (
                    <AlertTriangle className="w-3 h-3 text-amber-500" />
                  )}
                  <span
                    className={cn(
                      "text-xs px-1.5 py-0.5 rounded",
                      target.severity === "high"
                        ? "bg-red-500/20 text-red-400"
                        : target.severity === "medium"
                          ? "bg-amber-500/20 text-amber-400"
                          : "bg-zinc-800 text-zinc-500",
                    )}
                  >
                    {target.size}
                  </span>
                </div>
                <p className="text-xs text-zinc-500 mt-0.5">
                  {target.description}
                  {target.count !== undefined && (
                    <span className="text-zinc-600">
                      {" "}
                      ({target.count} items)
                    </span>
                  )}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default CleanupPanel;
