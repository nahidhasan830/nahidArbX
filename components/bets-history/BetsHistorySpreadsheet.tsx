"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { BetsHistoryToolbar } from "./BetsHistoryToolbar";
import { BetsHistoryTable } from "./BetsHistoryTable";
import { AiSettleDialog, type RerunChoice } from "./AiSettleDialog";
import { SettlementMonitor } from "./SettlementMonitor";
import {
  REFRESH_INTERVAL_MS,
  useBetsList,
  useBetsStats,
  useBulkMarkOutcomes,
  useMarkOutcome,
} from "@/lib/bets-history/hooks";
import { aiLabelBets } from "@/lib/bets-history/api-client";
import { estimateBatchCostUsd } from "@/lib/settle/cost-guard";
import { useBetsHistoryPrefs } from "@/lib/bets-history/use-bets-history-prefs";
import { canResettle } from "@/lib/bets-history/resettle";
import { resolvePreset } from "@/lib/bets-history/date-presets";
import { useLocalStorage } from "@/components/hooks/useLocalStorage";
import { useApplicableStrategies } from "@/lib/optimizer/use-live-strategies";
import {
  betsHistoryFiltersMatchTemplate,
  strategyToBetsHistoryPatch,
} from "@/lib/optimizer/apply-strategy-to-prefs";
import type { StrategyFilters } from "@/lib/optimizer/strategy-filters";
import type { AiLabelResponse } from "@/lib/bets-history/api-client";
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
  const { key: sortKey, dir: sortDir } = sort;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [, setAiSettlingIds] = useState<Set<string>>(new Set());
  // Separate from aiSettlingIds so the re-settle spinner doesn't overlap
  // with the AI-settle spinner on the same row.
  const [resettlingIds, setResettlingIds] = useState<Set<string>>(new Set());
  const [resettleRunning, setResettleRunning] = useState(false);

  const [settleOpen, setSettleOpen] = useState(false);
  const [settleCandidates, setSettleCandidates] = useState<ValueBetRow[]>([]);
  const [settleResponse, setSettleResponse] = useState<AiLabelResponse | null>(
    null,
  );
  // Ids currently being re-run individually via the per-row dropdown. Kept
  // separate from aiSettlingIds (which tracks the initial bulk run) so the
  // UI can show a spinner only on the specific row a user triggered.
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

  // Strategy = filter template. Picking a strategy populates the toolbar's
  // strategy-mapped fields (EV / odds / providers / markets) so the user can
  // see exactly what's being filtered and adjust further (date, search…).
  // Persisted per-surface so the last selection survives reloads, but the
  // toolbar values themselves are the source of truth — once any strategy
  // field is edited, the picker badge drops via `isStrategyModified`.
  const [appliedStrategyIds, setAppliedStrategyIds] = useLocalStorage<string[]>(
    "bets-history:applied-strategies",
    [],
  );
  const { data: strategies } = useApplicableStrategies();
  const appliedStrategyFilters = useMemo<StrategyFilters[]>(() => {
    if (!strategies || appliedStrategyIds.length === 0) return [];
    return appliedStrategyIds
      .map((id) => strategies.find((s) => s.id === id))
      .filter((s): s is NonNullable<typeof s> => s != null)
      .map((s) => s.filters as StrategyFilters);
  }, [strategies, appliedStrategyIds]);

  // Drop the "applied" badge once the toolbar diverges from the merged
  // template. The user can still see which strategies they last picked
  // (the dropdown shows checkmarks); the badge just reflects whether the
  // toolbar values still equal the template.
  const isStrategyModified = useMemo(() => {
    if (appliedStrategyFilters.length === 0) return false;
    return !betsHistoryFiltersMatchTemplate(filters, appliedStrategyFilters);
  }, [filters, appliedStrategyFilters]);

  const handleAppliedStrategiesChange = useCallback(
    (ids: string[]) => {
      setAppliedStrategyIds(ids);
      const list = strategies ?? [];
      const picked = ids
        .map((id) => list.find((s) => s.id === id))
        .filter((s): s is NonNullable<typeof s> => s != null)
        .map((s) => s.filters as StrategyFilters);
      const patch = strategyToBetsHistoryPatch(picked);
      setFilters((prev) => ({ ...prev, ...patch }));
    },
    [setAppliedStrategyIds, strategies, setFilters],
  );

  // Cross-page hand-off: /lab/optimisation StrategiesTable links here with
  // ?strategy=<id> when the user clicks "View bets" on a row. Apply once
  // strategies are loaded, then strip the param so refresh doesn't reapply.
  const router = useRouter();
  const searchParams = useSearchParams();
  // Dashboard accounts panel cross-page hand-off
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

  useEffect(() => {
    const sid = searchParams.get("strategy");
    if (!sid || !strategies) return;
    const exists = strategies.some((s) => s.id === sid);
    if (exists) {
      handleAppliedStrategiesChange([sid]);
    }
    router.replace("/bets");
  }, [searchParams, strategies, handleAppliedStrategiesChange, router]);

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

  // AI-settle orchestration — batches server calls transparently so users can
  // select any number of rows without hitting the server's per-call cap.
  const [aiSettleRunning, setAiSettleRunning] = useState(false);
  const [aiSettleProgress, setAiSettleProgress] = useState<{
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
        onSuccess: () => toast.success(`Outcome: ${outcome}`),
        onError: (err) =>
          toast.error(`Failed to mark outcome: ${(err as Error).message}`),
      },
    );
  };

  // Server caps at 50 per call; batch client-side so N rows always works.
  const AI_BATCH_SIZE = 50;
  // Fire 2 batches concurrently — respects Gemini rate limits while cutting
  // wall-clock ~in half vs sequential.
  const AI_BATCH_CONCURRENCY = 2;

  const runAiSettle = async (ids: string[]) => {
    if (ids.length === 0) {
      toast.error("No rows to settle");
      return;
    }

    // Cost confirmation. We show a conservative worst-case $ estimate
    // so the user can back out before firing if it's a large batch.
    const candidates = rows.filter((r) => ids.includes(r.id));
    const uniqueEventCount = new Set(candidates.map((c) => c.eventId)).size;
    if (uniqueEventCount > 500) {
      const estUsd = estimateBatchCostUsd(uniqueEventCount, "lite", "fallback");
      const pretty =
        estUsd < 0.01 ? "<$0.01" : `~$${estUsd.toFixed(estUsd < 1 ? 3 : 2)}`;
      const ok = window.confirm(
        `Run AI settlement on ${ids.length} bet${ids.length === 1 ? "" : "s"} (${uniqueEventCount} unique event${uniqueEventCount === 1 ? "" : "s"})?\n\n` +
          `Estimated worst-case Tier 3 cost: ${pretty} (lite).\n` +
          `Most events resolve via the free waterfall first — actual cost is usually much lower.\n\n` +
          `Proceed?`,
      );
      if (!ok) return;
    }

    setSettleCandidates(candidates);
    setSettleResponse({ proposals: [], attempted: 0, missing: [] });
    setSettleOpen(true);
    setAiSettlingIds(new Set(ids));

    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += AI_BATCH_SIZE) {
      chunks.push(ids.slice(i, i + AI_BATCH_SIZE));
    }
    setAiSettleRunning(true);
    setAiSettleProgress({ done: 0, total: chunks.length });

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
      tier3: 0,
      durationMs: 0,
    };

    // Worker-pool style: at most AI_BATCH_CONCURRENCY in flight; results
    // stream into settleResponse as each batch returns.
    let nextIndex = 0;
    const runOne = async (): Promise<void> => {
      while (nextIndex < chunks.length) {
        const my = nextIndex++;
        const chunk = chunks[my];
        try {
          // This entry-point is the UI's explicit "AI settle" button —
          // the user opted in, so go straight to Gemini Tier 3.
          const data = await aiLabelBets(chunk, { forceAi: true });
          if (data.telemetry) {
            summary.tier0 += data.telemetry.tier0_hits;
            summary.tier1 += data.telemetry.tier1_hits;
            summary.tier2 += data.telemetry.tier2_hits;
            summary.tier3 += data.telemetry.tier3_hits;
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
          setAiSettleProgress((p) => (p ? { ...p, done: p.done + 1 } : null));
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(AI_BATCH_CONCURRENCY, chunks.length) },
      () => runOne(),
    );
    await Promise.all(workers);

    setAiSettleRunning(false);
    setAiSettlingIds(new Set());

    if (anyErr) {
      const err = anyErr as Error;
      toast.error("Settlement failed", { description: err.message });
    } else {
      // Rich toast: concise title + breakdown on line 2. Mentions AI
      // only when it actually contributed; otherwise it's the free
      // waterfall doing the work.
      const word = ids.length === 1 ? "bet" : "bets";
      const pieces: string[] = [];
      if (summary.tier0 > 0) pieces.push(`cache ${summary.tier0}`);
      if (summary.tier1 > 0) pieces.push(`live feed ${summary.tier1}`);
      if (summary.tier2 > 0) pieces.push(`free APIs ${summary.tier2}`);
      if (summary.tier3 > 0) pieces.push(`AI ${summary.tier3}`);
      if (summary.unresolved > 0)
        pieces.push(`unresolved ${summary.unresolved}`);
      const seconds = (summary.durationMs / 1000).toFixed(1);
      toast.success(`Settled ${summary.resolved} / ${ids.length} ${word}`, {
        description:
          pieces.length > 0
            ? `${pieces.join(" · ")} · ${seconds}s`
            : `Took ${seconds}s`,
      });
      // Whole batch finished — drop the selection so the user doesn't
      // accidentally re-trigger on the same rows.
      clearSelection();
    }
  };

  const handleTableRerun = async (id: string, choice: RerunChoice) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    const gate = canResettle(row);
    if (!gate.allowed) {
      toast.error(gate.message);
      return;
    }
    setSettleCandidates([row]);
    setSettleResponse({ proposals: [], attempted: 0, missing: [] });
    setSettleOpen(true);
    setResettlingIds(new Set([id]));
    setAiSettleRunning(true);
    setAiSettleProgress({ done: 0, total: 1 });
    try {
      const reqOpts =
        choice.kind === "default"
          ? { bypassCache: true }
          : { forceAi: true, aiModel: choice.model };
      const data = await aiLabelBets([id], reqOpts);
      setSettleResponse(data);
    } catch (err) {
      toast.error(`Settlement failed: ${(err as Error).message}`);
      setSettleResponse({
        proposals: [{ id, error: (err as Error).message }],
        attempted: 1,
        missing: [],
      });
    } finally {
      setResettlingIds(new Set());
      setAiSettleRunning(false);
      setAiSettleProgress({ done: 1, total: 1 });
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

  /**
   * Unified bulk settle: routes based on the RerunChoice the user picked
   * from the toolbar dropdown.
   *  - "default" → re-run the free waterfall (bypass cache, no AI)
   *  - "ai"     → run through AI settle with the chosen model
   */
  const handleBulkSettle = async (choice: RerunChoice) => {
    if (choice.kind === "default") {
      const eligible: ValueBetRow[] = [];
      for (const id of selectedIds) {
        const row = rows.find((r) => r.id === id);
        if (row && canResettle(row).allowed) eligible.push(row);
      }
      if (eligible.length === 0) {
        toast.error(
          "None of the selected rows can be settled yet — matches still live.",
        );
        return;
      }
      setResettleRunning(true);
      setResettlingIds(new Set(eligible.map((r) => r.id)));

      const BATCH = 50;
      const chunks: string[][] = [];
      const ids = eligible.map((r) => r.id);
      for (let i = 0; i < ids.length; i += BATCH) {
        chunks.push(ids.slice(i, i + BATCH));
      }

      let unresolved = 0;
      let errors = 0;
      const updates: {
        id: string;
        outcome: Outcome;
        source: string | null;
        score?: string | null;
      }[] = [];

      for (const chunk of chunks) {
        try {
          const data = await aiLabelBets(chunk, { bypassCache: true });
          for (const p of data.proposals) {
            if ("error" in p) {
              errors++;
              continue;
            }
            if (p.proposedOutcome !== "pending") {
              updates.push({
                id: p.id,
                outcome: p.proposedOutcome,
                source: p.source ?? null,
                score: p.score,
              });
            } else {
              unresolved++;
            }
          }
        } catch (err) {
          errors += chunk.length;
          toast.error(`Settlement batch failed: ${(err as Error).message}`, {
            description: `${chunk.length} rows skipped`,
          });
        }
      }

      if (updates.length > 0) {
        try {
          const res = await bulkMarkMutation.mutateAsync(updates);
          toast.success(
            `Settled ${res.applied} of ${eligible.length} selected`,
            {
              description: `unresolved ${unresolved}${errors > 0 ? ` · errors ${errors}` : ""}`,
            },
          );
        } catch (err) {
          toast.error(`Apply failed: ${(err as Error).message}`);
        }
      } else {
        toast.info(
          `No outcomes changed — ${unresolved} unresolved${errors > 0 ? `, ${errors} errors` : ""}`,
        );
      }

      setResettleRunning(false);
      setResettlingIds(new Set());
      // Default-path success: drop the selection — the user shouldn't keep
      // re-running settle on rows they just processed.
      clearSelection();
    } else {
      // AI settle — run through the dialog flow (selection is cleared
      // inside runAiSettle on its success path).
      runAiSettle(Array.from(selectedIds));
    }
  };

  /**
   * Re-run a single proposal and splice the fresh result back into
   * `settleResponse`. The choice controls whether we re-fire the free
   * waterfall (bypassing Tier 0 so the source can actually change) or
   * skip the free tiers entirely and go straight to a specific Gemini
   * tier. Errors from the API surface as an error row the dialog
   * already knows how to render.
   */
  const handleRerunProposal = async (
    id: string,
    choice:
      | { kind: "default" }
      | { kind: "ai"; model: "lite" | "flash" | "pro" },
  ) => {
    setRerunningIds((cur) => {
      const next = new Set(cur);
      next.add(id);
      return next;
    });
    try {
      const reqOpts =
        choice.kind === "default"
          ? { bypassCache: true }
          : { forceAi: true, aiModel: choice.model };
      const data = await aiLabelBets([id], reqOpts);
      const fresh = data.proposals.find((p) => p.id === id);
      if (!fresh) {
        toast.error(`Re-run returned no proposal for ${id}`);
        return;
      }
      setSettleResponse((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          proposals: prev.proposals.map((p) => (p.id === id ? fresh : p)),
        };
      });
      const pathLabel =
        choice.kind === "default" ? "default pipeline" : `AI · ${choice.model}`;
      if ("error" in fresh) {
        toast.error(`Re-run failed: ${fresh.error}`);
      } else {
        toast.success(
          `Re-ran via ${pathLabel} → ${fresh.proposedOutcome}${
            fresh.score ? ` (${fresh.score})` : ""
          }`,
        );
      }
    } catch (err) {
      toast.error(`Re-run failed: ${(err as Error).message}`);
    } finally {
      setRerunningIds((cur) => {
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
    }
  };

  const handleApplyAiProposals = async (
    updates: { id: string; outcome: Outcome; source: string | null }[],
  ) => {
    if (updates.length === 0) return;
    try {
      const result = await bulkMarkMutation.mutateAsync(updates);
      toast.success(
        `Applied ${result.applied} outcome${result.applied === 1 ? "" : "s"}`,
      );
      setSettleOpen(false);
      setSettleResponse(null);
      clearSelection();
    } catch (err) {
      toast.error(`Bulk apply failed: ${(err as Error).message}`);
    }
  };

  const handleBulkMark = (outcome: Outcome) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    bulkMarkMutation.mutate(
      ids.map((id) => ({ id, outcome })),
      {
        onSuccess: (r) => {
          toast.success(`Marked ${r.applied} as ${outcome}`);
          clearSelection();
        },
        onError: (err) =>
          toast.error(`Bulk mark failed: ${(err as Error).message}`),
      },
    );
  };

  const handleFiltersChange = (f: typeof filters) => {
    setFilters(f);
  };

  const handleResetToDefaults = () => {
    resetToDefaults();
    setAppliedStrategyIds([]);
    toast.success(
      hasSavedDefaults ? "Reset to saved defaults" : "Reset to system defaults",
    );
  };

  const handleSaveAsDefault = () => {
    saveCurrentAsDefault();
    toast.success("Current view saved as default");
  };

  const handleClearSavedDefaults = () => {
    clearSavedDefaults();
    toast.success("Saved defaults cleared — reset falls back to system");
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
          settleRunning={aiSettleRunning || resettleRunning}
          resettleEligibleCount={resettleEligibleCount}
          onBulkMark={handleBulkMark}
          bulkMarkRunning={bulkMarkMutation.isPending}
          onOpenSettlementMonitor={() => setSettlementMonitorOpen(true)}
          onReset={handleResetToDefaults}
          onSaveAsDefault={handleSaveAsDefault}
          onClearSavedDefaults={handleClearSavedDefaults}
          isAtDefaults={isAtDefaults}
          hasSavedDefaults={hasSavedDefaults}
          appliedStrategyIds={appliedStrategyIds}
          onAppliedStrategiesChange={handleAppliedStrategiesChange}
          strategyTemplateModified={isStrategyModified}
        />

        <BetsHistoryTable
          rows={rows}
          loading={list.isLoading}
          selectedIds={selectedIds}
          onToggleRow={toggleRow}
          onToggleAllVisible={toggleAllVisible}
          onMarkOutcome={handleMarkOutcome}
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

      <AiSettleDialog
        open={settleOpen}
        onOpenChange={(o) => {
          setSettleOpen(o);
          if (!o) {
            setSettleResponse(null);
            setSettleCandidates([]);
            setAiSettleProgress(null);
            setRerunningIds(new Set());
          }
        }}
        candidateRows={settleCandidates}
        response={settleResponse}
        loading={aiSettleRunning}
        progress={aiSettleProgress}
        onApply={handleApplyAiProposals}
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
