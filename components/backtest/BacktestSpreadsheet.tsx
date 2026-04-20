"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { BacktestToolbar } from "./BacktestToolbar";
import { BacktestTable } from "./BacktestTable";
import { AiSettleDialog, type RerunChoice } from "./AiSettleDialog";
import { AnalysisDialog } from "./AnalysisDialog";
import { StrategiesDialog } from "./StrategiesDialog";
import { SettlementMonitor } from "./SettlementMonitor";
import {
  useBetsList,
  useBulkMarkOutcomes,
  useMarkOutcome,
} from "@/lib/backtest/hooks";
import { aiLabelBets, listValueBets } from "@/lib/backtest/api-client";
import { estimateBatchCostUsd } from "@/lib/settle/cost-guard";
import { useBacktestPrefs } from "@/lib/backtest/use-backtest-prefs";
import { canResettle } from "@/lib/backtest/resettle";
import type { AiLabelResponse, Strategy } from "@/lib/backtest/api-client";
import type { Outcome, ValueBetRow } from "@/lib/backtest/types";

export function BacktestSpreadsheet() {
  const {
    filters,
    setFilters,
    sort,
    setSort,
    resetToDefaults,
    saveCurrentAsDefault,
    clearSavedDefaults,
    isAtDefaults,
    hasSavedDefaults,
  } = useBacktestPrefs();
  const { key: sortKey, dir: sortDir } = sort;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [aiSettlingIds, setAiSettlingIds] = useState<Set<string>>(new Set());
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

  const [analyzeOpen, setAnalyzeOpen] = useState(false);
  const [analyzeScope, setAnalyzeScope] = useState<"selected" | "all">(
    "selected",
  );
  const [analyzeAllRows, setAnalyzeAllRows] = useState<ValueBetRow[] | null>(
    null,
  );
  const [analyzeAllLoading, setAnalyzeAllLoading] = useState(false);
  const [analyzeAllProgress, setAnalyzeAllProgress] = useState<{
    loaded: number;
    total: number | null;
  } | null>(null);

  const [strategiesOpen, setStrategiesOpen] = useState(false);
  const [settlementMonitorOpen, setSettlementMonitorOpen] = useState(false);

  const handleLoadStrategy = (s: Strategy) => {
    setFilters({ ...s.filters });
  };

  const list = useBetsList(filters);
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
          // the user opted in, so unlock the paid Gemini fallback tier.
          const data = await aiLabelBets(chunk, { useAi: true });
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
    } else {
      // AI settle — run through the dialog flow
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

  const handleAnalyze = async (scope: "selected" | "all") => {
    setAnalyzeScope(scope);
    if (scope === "selected") {
      setAnalyzeAllRows(null);
      setAnalyzeAllProgress(null);
      setAnalyzeOpen(true);
      return;
    }
    // scope === "all": open the dialog immediately in a loading state, then
    // fetch every row matching the current filters, paging through the server
    // endpoint (capped at 1000 per page). The user sees live progress instead
    // of waiting on a blocked button.
    setAnalyzeAllRows(null);
    setAnalyzeAllProgress({ loaded: 0, total: totalCount || null });
    setAnalyzeAllLoading(true);
    setAnalyzeOpen(true);
    try {
      const collected: ValueBetRow[] = [];
      const pageSize = 1000;
      let offset = 0;
      const maxRows = 100_000;
      while (collected.length < maxRows) {
        const res = await listValueBets({
          ...filters,
          preMatchOnly: true,
          limit: pageSize,
          offset,
        });
        collected.push(...res.rows);
        setAnalyzeAllProgress({ loaded: collected.length, total: res.total });
        if (collected.length >= res.total || res.rows.length === 0) break;
        offset += res.rows.length;
      }
      setAnalyzeAllRows(collected);
    } catch (err) {
      toast.error(`Fetch all failed: ${(err as Error).message}`);
      setAnalyzeOpen(false);
    } finally {
      setAnalyzeAllLoading(false);
    }
  };

  const handleFiltersChange = (f: typeof filters) => {
    setFilters(f);
  };

  const handleResetToDefaults = () => {
    resetToDefaults();
    toast.success(
      hasSavedDefaults ? "Reset to saved defaults" : "Reset to system defaults",
    );
  };

  // Platform is pre-match only (see in-play.md). Any rows with firstSeenAt at
  // or after kickoff are historical pollution from before the 2026-04-19 fix
  // and must be excluded from analysis — they represent phantom edges from
  // snapshot-timing mismatches during live play, not real value bets.
  const isPreMatch = (r: ValueBetRow) =>
    new Date(r.firstSeenAt).getTime() < new Date(r.eventStartTime).getTime();

  const rawAnalysisSet = useMemo<ValueBetRow[]>(() => {
    if (analyzeScope === "selected") {
      return rows.filter((r) => selectedIds.has(r.id));
    }
    return analyzeAllRows ?? [];
  }, [analyzeScope, rows, selectedIds, analyzeAllRows]);

  const analysisRows = useMemo<ValueBetRow[]>(
    () => rawAnalysisSet.filter(isPreMatch),
    [rawAnalysisSet],
  );

  const excludedInPlayCount = rawAnalysisSet.length - analysisRows.length;

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
        <BacktestToolbar
          filters={filters}
          onFiltersChange={handleFiltersChange}
          totalCount={totalCount}
          filteredCount={filteredCount}
          selectedCount={selectedIds.size}
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
          onAnalyze={handleAnalyze}
          analyzeRunning={analyzeAllLoading}
          onOpenStrategies={() => setStrategiesOpen(true)}
          onOpenSettlementMonitor={() => setSettlementMonitorOpen(true)}
          onReset={handleResetToDefaults}
          onSaveAsDefault={handleSaveAsDefault}
          onClearSavedDefaults={handleClearSavedDefaults}
          isAtDefaults={isAtDefaults}
          hasSavedDefaults={hasSavedDefaults}
        />

        <BacktestTable
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
        />

        <div className="flex items-center justify-between px-3 py-1.5 border-t border-border bg-muted/30 text-[11px] text-muted-foreground">
          <div>
            <span className="tabular-nums text-foreground">
              {filteredCount}
            </span>{" "}
            of <span className="tabular-nums">{totalCount}</span> loaded
            {list.isFetchingNextPage && (
              <span className="ml-2 inline-flex items-center gap-1 text-muted-foreground/80">
                · loading more…
              </span>
            )}
            {!list.isFetchingNextPage && list.isFetching && (
              <span className="ml-2 inline-flex items-center gap-1 text-muted-foreground/80">
                · refreshing…
              </span>
            )}
          </div>
          {!list.hasNextPage && filteredCount > 0 && (
            <span className="text-muted-foreground/80">End of results</span>
          )}
        </div>
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

      <AnalysisDialog
        open={analyzeOpen}
        onOpenChange={setAnalyzeOpen}
        rows={analysisRows}
        scope={analyzeScope}
        loading={analyzeAllLoading}
        loadingProgress={analyzeAllProgress}
        excludedInPlayCount={excludedInPlayCount}
      />

      <StrategiesDialog
        open={strategiesOpen}
        onOpenChange={setStrategiesOpen}
        currentFilters={filters}
        onLoadStrategy={handleLoadStrategy}
      />

      <SettlementMonitor
        open={settlementMonitorOpen}
        onOpenChange={setSettlementMonitorOpen}
      />
    </div>
  );
}
