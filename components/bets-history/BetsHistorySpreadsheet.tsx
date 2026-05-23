"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { BetsHistoryToolbar } from "./BetsHistoryToolbar";
import { BetsHistoryTable } from "./BetsHistoryTable";
import { SettlementReviewDialog } from "./SettlementReviewDialog";
import { SettlementMonitor } from "./SettlementMonitor";
import {
  REFRESH_INTERVAL_MS,
  useBetsList,
  useBetsStats,
  useBulkMarkOutcomes,
  useDeleteBet,
  useMarkOutcome,
} from "@/lib/bets-history/hooks";
import { settleBets } from "@/lib/bets-history/api-client";
import { useBetsHistoryPrefs } from "@/lib/bets-history/use-bets-history-prefs";
import { canResettle } from "@/lib/bets-history/resettle";
import { resolvePreset } from "@/lib/bets-history/date-presets";
import type { SettlementResponse } from "@/lib/bets-history/api-client";
import type { ListFilters } from "@/lib/bets-history/api-client";
import type { Outcome, ValueBetRow } from "@/lib/bets-history/types";

export function BetsHistorySpreadsheet() {
  const {
    filters,
    setFilters,
    sort,
    setSort,
    capturedPreset,
    kickoffPreset,
    setCapturedPreset,
    setKickoffPreset,
    resetToDefaults,
    saveCurrentAsDefault,
    clearSavedDefaults,
    isAtDefaults,
    hasSavedDefaults,
  } = useBetsHistoryPrefs();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { key: sortKey, dir: sortDir } = sort;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [resettlingIds, setResettlingIds] = useState<Set<string>>(new Set());

  const [settleOpen, setSettleOpen] = useState(false);
  const [settleCandidates, setSettleCandidates] = useState<ValueBetRow[]>([]);
  const [settleResponse, setSettleResponse] =
    useState<SettlementResponse | null>(null);
  // Ids currently being re-run individually via the per-row dropdown. Kept
  // separate from bulk progress so the UI can show a spinner only on the
  // specific row a user triggered.
  const [rerunningIds, setRerunningIds] = useState<Set<string>>(new Set());

  const [settlementMonitorOpen, setSettlementMonitorOpen] = useState(false);

  // Rolling date presets re-resolve on each tick so "Last 1h" always means
  // the trailing 60 minutes from *now*, not from when the preset was picked.
  // Aligned with the React Query refetch interval so the new query key
  // lines up with the refetch boundary.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // Cross-page hand-off: dashboard accounts panel links here with
  useEffect(() => {
    const p = searchParams.get("provider");
    const s = searchParams.get("status");
    if (p || s) {
      setFilters((prev) => ({
        ...prev,
        softProviders: p ? [p] : prev.softProviders,
        outcome: (s as Outcome) || prev.outcome,
        placedOnly: true,
      }));
      router.replace("/bets");
    }
  }, [searchParams, setFilters, router]);

  const effectiveFilters = useMemo<ListFilters>(() => {
    const f: ListFilters = { ...filters };
    if (capturedPreset !== "all" && capturedPreset !== "custom") {
      const { from, to } = resolvePreset(capturedPreset);
      f.from = from;
      f.to = to;
    }
    if (kickoffPreset !== "all" && kickoffPreset !== "custom") {
      const { from, to } = resolvePreset(kickoffPreset);
      f.eventFrom = from;
      f.eventTo = to;
    }
    return f;
    // `tick` is intentionally in deps so rolling windows refresh every interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, capturedPreset, kickoffPreset, tick]);

  const list = useBetsList(effectiveFilters);
  // Server-side aggregation over the full filter-matched population. Drives
  // the toolbar's ROI / win-loss cluster so numbers reflect every bet the
  // filter hits, not just the rows the user has scrolled into view.
  const statsQuery = useBetsStats(effectiveFilters);
  const rows = useMemo<ValueBetRow[]>(() => {
    // Dedupe by id across pages — offset pagination can duplicate a row when a
    // new insert shifts page boundaries between fetches.
    const seen = new Set<string>();
    const flat = list.data?.pages.flatMap((p) => p.rows) ?? [];
    return flat.filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
  }, [list.data]);
  const totalCount = list.data?.pages[0]?.total ?? 0;
  const filteredCount = rows.length;

  const markMutation = useMarkOutcome();
  const bulkMarkMutation = useBulkMarkOutcomes();
  const deleteMutation = useDeleteBet();
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

  // Settlement orchestration — batches server calls transparently so users can
  // select any number of rows without hitting the server's per-call cap.
  const [settlementRunning, setSettlementRunning] = useState(false);
  const [settlementProgress, setSettlementProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

  const visibleIds = useMemo(() => rows.map((r) => r.id), [rows]);

  const toggleRow = (id: string) => {
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllVisible = (ids: string[], check: boolean) => {
    setSelectedIds((cur) => {
      const next = new Set(cur);
      ids.forEach((id) => {
        if (check) next.add(id);
        else next.delete(id);
      });
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());
  const selectAllLoaded = () => setSelectedIds(new Set(visibleIds));

  // Reset selection whenever the partition the user is looking at changes —
  // i.e. outcome tab, ready-to-settle / needs-review toggles, or the placed-
  // only pill. Generic filter tweaks (search text, providers, dates) should
  // NOT clear selection, so those are intentionally excluded.
  const partitionKey = `${filters.outcome ?? ""}|${filters.readyToSettle ? 1 : 0}|${filters.needsReview ? 1 : 0}|${
    filters.placedOnly === undefined
      ? "any"
      : filters.placedOnly
        ? "placed"
        : "detected"
  }`;
  useEffect(() => {
    setSelectedIds(new Set());
  }, [partitionKey]);

  const handleSortChange = (key: typeof sortKey) => {
    // Tri-state cycle on the active column: desc → asc → none.
    // Clicking a different column always starts at desc.
    if (key !== sortKey) {
      setSort({ key, dir: "desc" });
      return;
    }
    if (sortDir === "desc") setSort({ key, dir: "asc" });
    else if (sortDir === "asc") setSort({ key, dir: "none" });
    else setSort({ key, dir: "desc" });
  };

  const handleMarkOutcome = (id: string, outcome: Outcome) => {
    markMutation.mutate(
      { id, outcome },
      {
        onSuccess: () => {
          const row = rows.find((r) => r.id === id);
          const label = row
            ? `${row.homeTeam} vs ${row.awayTeam}`.slice(0, 50)
            : undefined;
          const emoji =
            outcome === "won" || outcome === "half_won"
              ? "✅"
              : outcome === "lost" || outcome === "half_lost"
                ? "❌"
                : outcome === "void"
                  ? "⚪"
                  : "🟡";
          toast.success(`${emoji} Marked as ${outcome}`, {
            description: label,
          });
        },
        onError: (err) =>
          toast.error(`❌ Failed to mark outcome: ${(err as Error).message}`),
      },
    );
  };

  const handleDeleteBet = (id: string) => {
    setDeletingIds((cur) => new Set(cur).add(id));
    const row = rows.find((r) => r.id === id);
    const label = row
      ? `${row.homeTeam} vs ${row.awayTeam}`.slice(0, 50)
      : undefined;
    deleteMutation.mutate(id, {
      onSuccess: () => {
        toast.success("🗑️ Bet deleted", {
          description: label,
        });
        setSelectedIds((cur) => {
          const next = new Set(cur);
          next.delete(id);
          return next;
        });
      },
      onError: (err) =>
        toast.error(`❌ Failed to delete bet: ${(err as Error).message}`),
      onSettled: () =>
        setDeletingIds((cur) => {
          const next = new Set(cur);
          next.delete(id);
          return next;
        }),
    });
  };

  // Server caps at 50 per call; batch client-side so N rows always works.
  const SETTLEMENT_BATCH_SIZE = 50;
  // Fire 2 batches concurrently to cut wall-clock ~in half.
  const SETTLEMENT_BATCH_CONCURRENCY = 2;

  const runSettlement = async (
    ids: string[],
    reqOpts?: {
      bypassCache?: boolean;
    },
  ) => {
    if (ids.length === 0) {
      toast.error("⚠️ No rows to settle");
      return;
    }

    const candidates = rows.filter((r) => ids.includes(r.id));

    setSettleCandidates(candidates);
    setSettleResponse({ proposals: [], attempted: 0, missing: [] });
    setSettleOpen(true);

    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += SETTLEMENT_BATCH_SIZE) {
      chunks.push(ids.slice(i, i + SETTLEMENT_BATCH_SIZE));
    }
    setSettlementRunning(true);
    setSettlementProgress({ done: 0, total: chunks.length });

    let anyErr: Error | null = null;

    // Accumulate tier stats locally so the final toast reflects the
    // *actual* distribution across all batches. Reading from
    // `settleResponse` state in the closure would miss the last
    // batch's hits because state updates haven't been flushed yet.
    const summary = {
      resolved: 0,
      unresolved: 0,
      tier0: 0,
      tier1: 0,
      tier2: 0,
      durationMs: 0,
    };

    // Worker-pool style: at most SETTLEMENT_BATCH_CONCURRENCY in flight; results
    // stream into settleResponse as each batch returns.
    let nextIndex = 0;
    const runOne = async (): Promise<void> => {
      while (nextIndex < chunks.length) {
        const my = nextIndex++;
        const chunk = chunks[my];
        try {
          const data = await settleBets(
            chunk,
            reqOpts ?? { bypassCache: true },
          );
          if (data.telemetry) {
            summary.tier0 += data.telemetry.tier0_hits;
            summary.tier1 += data.telemetry.tier1_hits;
            summary.tier2 += data.telemetry.tier2_hits;
            summary.unresolved += data.telemetry.unresolved;
            summary.durationMs += data.telemetry.durationMs;
          }
          for (const p of data.proposals) {
            if ("error" in p) continue;
            if (p.proposedOutcome !== "pending") summary.resolved++;
          }
          setSettleResponse((prev) =>
            prev
              ? {
                  proposals: [...prev.proposals, ...data.proposals],
                  attempted: prev.attempted + data.attempted,
                  missing: [...prev.missing, ...data.missing],
                }
              : data,
          );
        } catch (err) {
          anyErr = err as Error;
          // Record every row in this chunk as an error so the user sees what
          // happened rather than silently-missing entries.
          setSettleResponse((prev) =>
            prev
              ? {
                  proposals: [
                    ...prev.proposals,
                    ...chunk.map((id) => ({
                      id,
                      error: (err as Error).message,
                    })),
                  ],
                  attempted: prev.attempted + chunk.length,
                  missing: prev.missing,
                }
              : null,
          );
        } finally {
          setSettlementProgress((p) =>
            p ? { ...p, done: p.done + 1 } : null,
          );
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(SETTLEMENT_BATCH_CONCURRENCY, chunks.length) },
      () => runOne(),
    );
    await Promise.all(workers);

    setSettlementRunning(false);

    if (anyErr) {
      const err = anyErr as Error;
      toast.error("❌ Settlement failed", { description: err.message });
    } else {
      const word = ids.length === 1 ? "bet" : "bets";
      const pieces: string[] = [];
      if (summary.tier0 > 0) pieces.push(`cache ${summary.tier0}`);
      if (summary.tier1 > 0) pieces.push(`live feed ${summary.tier1}`);
      if (summary.tier2 > 0) pieces.push(`source APIs ${summary.tier2}`);
      if (summary.unresolved > 0)
        pieces.push(`unresolved ${summary.unresolved}`);
      const seconds = (summary.durationMs / 1000).toFixed(1);
      toast.success(`✅ Settled ${summary.resolved} / ${ids.length} ${word}`, {
        description:
          pieces.length > 0
            ? `${pieces.join(" · ")} · ⏱️ ${seconds}s`
            : `Took ${seconds}s`,
      });
      // Whole batch finished — drop the selection so the user doesn't
      // accidentally re-trigger on the same rows.
      clearSelection();
    }
  };

  const handleTableRerun = async (id: string) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    const gate = canResettle(row);
    if (!gate.allowed) {
      toast.error("🚫 " + gate.message);
      return;
    }
    setSettleCandidates([row]);
    setSettleResponse({ proposals: [], attempted: 0, missing: [] });
    setSettleOpen(true);
    setResettlingIds(new Set([id]));
    setSettlementRunning(true);
    setSettlementProgress({ done: 0, total: 1 });
    try {
      const data = await settleBets([id], { bypassCache: true });
      setSettleResponse(data);
    } catch (err) {
      toast.error(`❌ Settlement failed: ${(err as Error).message}`);
      setSettleResponse({
        proposals: [{ id, error: (err as Error).message }],
        attempted: 1,
        missing: [],
      });
    } finally {
      setResettlingIds(new Set());
      setSettlementRunning(false);
      setSettlementProgress({ done: 1, total: 1 });
    }
  };

  // Count of currently-selected rows that are safe to re-settle (match
  // over OR already settled). Recomputed whenever selection / row data
  // changes so the toolbar can disable the bulk button accordingly.
  const resettleEligibleCount = useMemo(() => {
    let n = 0;
    for (const id of selectedIds) {
      const r = rows.find((x) => x.id === id);
      if (r && canResettle(r).allowed) n++;
    }
    return n;
  }, [selectedIds, rows]);
  const handleBulkSettle = async () => {
    const eligible: ValueBetRow[] = [];
    for (const id of selectedIds) {
      const row = rows.find((r) => r.id === id);
      if (row && canResettle(row).allowed) eligible.push(row);
    }
    if (eligible.length === 0) {
      toast.error(
        "🚫 None of the selected rows can be settled yet — matches still live.",
      );
      return;
    }

    const ids = eligible.map((r) => r.id);
    runSettlement(ids, { bypassCache: true });
  };

  /**
   * Re-run a single proposal and splice the fresh result back into
   * `settleResponse`. Re-fires the full source waterfall (bypassing Tier 0
   * so the source can actually change). Errors from the API surface as
   * an error row the dialog already knows how to render.
   */
  const handleRerunProposal = async (id: string) => {
    setRerunningIds((cur) => {
      const next = new Set(cur);
      next.add(id);
      return next;
    });
    try {
      const data = await settleBets([id], { bypassCache: true });
      const fresh = data.proposals.find((p) => p.id === id);
      if (!fresh) {
        toast.error(`❌ Re-run returned no proposal for ${id}`);
        return;
      }
      setSettleResponse((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          proposals: prev.proposals.map((p) => (p.id === id ? fresh : p)),
        };
      });
      if ("error" in fresh) {
        toast.error(`❌ Re-run failed: ${fresh.error}`);
      } else {
        toast.success(
          `♻️ Re-ran source waterfall → ${fresh.proposedOutcome}${
            fresh.score ? ` (${fresh.score})` : ""
          }`,
        );
      }
    } catch (err) {
      toast.error(`❌ Re-run failed: ${(err as Error).message}`);
    } finally {
      setRerunningIds((cur) => {
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
    }
  };

  const handleApplySettlementProposals = async (
    updates: { id: string; outcome: Outcome; source: string | null }[],
  ) => {
    if (updates.length === 0) return;
    try {
      const result = await bulkMarkMutation.mutateAsync(updates);
      toast.success(
        `✅ Applied ${result.applied} outcome${result.applied === 1 ? "" : "s"}`,
      );
      setSettleOpen(false);
      setSettleResponse(null);
      clearSelection();
    } catch (err) {
      toast.error(`❌ Bulk apply failed: ${(err as Error).message}`);
    }
  };

  const handleBulkMark = (outcome: Outcome) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    bulkMarkMutation.mutate(
      ids.map((id) => ({ id, outcome })),
      {
        onSuccess: (r) => {
          toast.success(`✅ Marked ${r.applied} as ${outcome}`);
          clearSelection();
        },
        onError: (err) =>
          toast.error(`❌ Bulk mark failed: ${(err as Error).message}`),
      },
    );
  };

  const handleFiltersChange = (f: typeof filters) => {
    setFilters(f);
  };

  const handleResetToDefaults = () => {
    resetToDefaults();
    toast.success(
      hasSavedDefaults
        ? "⚙️ Reset to saved defaults"
        : "⚙️ Reset to system defaults",
    );
  };

  const handleSaveAsDefault = () => {
    saveCurrentAsDefault();
    toast.success("💾 Current view saved as default");
  };

  const handleClearSavedDefaults = () => {
    clearSavedDefaults();
    toast.success("🧹 Saved defaults cleared — reset falls back to system");
  };

  return (
    <div className="flex flex-col gap-0 w-full flex-1 min-h-0">
      <Card className="flex flex-col flex-1 min-h-0 relative overflow-hidden py-0 gap-0">
        <BetsHistoryToolbar
          filters={filters}
          onFiltersChange={handleFiltersChange}
          capturedPreset={capturedPreset}
          kickoffPreset={kickoffPreset}
          onCapturedPresetChange={setCapturedPreset}
          onKickoffPresetChange={setKickoffPreset}
          totalCount={totalCount}
          filteredCount={filteredCount}
          selectedCount={selectedIds.size}
          stats={statsQuery.data ?? null}
          statsLoading={statsQuery.isLoading || statsQuery.isFetching}
          rows={rows}
          loading={list.isLoading || list.isFetching}
          onRefresh={() => list.refetch()}
          onClearSelection={clearSelection}
          onSelectAllLoaded={selectAllLoaded}
          onBulkSettle={handleBulkSettle}
          settleRunning={settlementRunning}
          resettleEligibleCount={resettleEligibleCount}
          onBulkMark={handleBulkMark}
          bulkMarkRunning={bulkMarkMutation.isPending}
          onOpenSettlementMonitor={() => setSettlementMonitorOpen(true)}
          onReset={handleResetToDefaults}
          onSaveAsDefault={handleSaveAsDefault}
          onClearSavedDefaults={handleClearSavedDefaults}
          isAtDefaults={isAtDefaults}
          hasSavedDefaults={hasSavedDefaults}
        />

        <BetsHistoryTable
          rows={rows}
          loading={list.isLoading}
          selectedIds={selectedIds}
          onToggleRow={toggleRow}
          onToggleAllVisible={toggleAllVisible}
          onMarkOutcome={handleMarkOutcome}
          onDeleteBet={handleDeleteBet}
          deletingIds={deletingIds}
          onRerunRow={handleTableRerun}
          rerunningIds={resettlingIds}
          sortKey={sortKey}
          sortDir={sortDir}
          onSortChange={handleSortChange}
          hasNextPage={list.hasNextPage}
          isFetchingNextPage={list.isFetchingNextPage}
          onLoadMore={() => list.fetchNextPage()}
          renderFooter={() => (
            <div className="text-center text-xs text-muted-foreground/60">
              Showing all {filteredCount} rows
              {totalCount !== filteredCount &&
                ` (${totalCount} total before filters)`}
            </div>
          )}
        />
      </Card>

      <SettlementReviewDialog
        open={settleOpen}
        onOpenChange={(o) => {
          setSettleOpen(o);
          if (!o) {
            setSettleResponse(null);
            setSettleCandidates([]);
            setSettlementProgress(null);
            setRerunningIds(new Set());
          }
        }}
        candidateRows={settleCandidates}
        response={settleResponse}
        loading={settlementRunning}
        progress={settlementProgress}
        onApply={handleApplySettlementProposals}
        applying={bulkMarkMutation.isPending}
        rerunningIds={rerunningIds}
        onRerun={handleRerunProposal}
      />

      <SettlementMonitor
        open={settlementMonitorOpen}
        onOpenChange={setSettlementMonitorOpen}
      />
    </div>
  );
}
