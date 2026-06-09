"use client";

import { useMemo, useState } from "react";
import { Info, Gavel, Loader2, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MarketDisplay } from "@/components/ui/market-display";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import type {
  Outcome,
  SettlementProposal,
  SettlementResponse,
} from "@/lib/bets-history/api-client";
import type { ValueBetRow } from "@/lib/bets-history/types";
import { buildGoogleAiModeUrl } from "@/lib/bets-history/google-verify";
import { cn } from "@/lib/utils";

const OUTCOME_OPTIONS: Outcome[] = [
  "pending",
  "won",
  "half_won",
  "lost",
  "half_lost",
  "void",
];

const OUTCOME_LABEL: Record<Outcome, string> = {
  pending: "Pending",
  won: "Won",
  half_won: "½ Won",
  lost: "Lost",
  half_lost: "½ Lost",
  void: "Void",
};

const confidenceClass = (c: number) =>
  c >= 0.9
    ? "bg-emerald-600/20 text-emerald-400 border-emerald-800"
    : c >= 0.7
      ? "bg-amber-600/20 text-amber-400 border-amber-800"
      : "bg-rose-600/20 text-rose-400 border-rose-800";

/**
 * Human-friendly label for a score source. "pinnacle-ws" → "Pinnacle",
 * "sofascore" → "SofaScore", etc. Null source → "—".
 */
const sourceLabel = (source: string | null): string => {
  if (!source) return "—";
  const map: Record<string, string> = {
    "pinnacle-ws": "Pinnacle WS",
    "pinnacle-settled": "Pinnacle",
    betconstruct: "BetConstruct",
    espn: "ESPN",
    "api-football": "API-Football",
    sofascore: "SofaScore",
    openligadb: "OpenLigaDB",
    "football-data": "football-data",
    manual: "Manual",
  };
  return map[source] ?? source;
};

/** Visual pill for the source tier. */
const sourceBadgeClass = (source: string | null): string => {
  if (!source) return "bg-muted/40 text-muted-foreground border-muted";
  if (
    source === "pinnacle-ws" ||
    source === "pinnacle-settled" ||
    source === "betconstruct"
  )
    return "bg-sky-600/20 text-sky-400 border-sky-800";
  return "bg-emerald-600/20 text-emerald-400 border-emerald-800";
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidateRows: ValueBetRow[];
  response: SettlementResponse | null;
  loading: boolean;
  progress?: { done: number; total: number } | null;
  onApply: (
    updates: {
      id: string;
      outcome: Outcome;
      source: string | null;
      score?: string | null;
    }[],
  ) => Promise<void>;
  applying: boolean;
  /** Ids currently being re-run (spinner shown in the row's Re-run column). */
  rerunningIds?: Set<string>;
  onRerun?: (id: string) => void;
};

const isError = (
  p: SettlementResponse["proposals"][number],
): p is { id: string; error: string } => "error" in p;

export function SettlementReviewDialog({
  open,
  onOpenChange,
  candidateRows,
  response,
  loading,
  progress,
  onApply,
  applying,
  rerunningIds,
  onRerun,
}: Props) {
  const [overrides, setOverrides] = useState<Record<string, Outcome>>({});
  const [prevOpen, setPrevOpen] = useState(open);

  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) setOverrides({});
  }

  const rowsById = useMemo(
    () => new Map(candidateRows.map((r) => [r.id, r])),
    [candidateRows],
  );

  const finalOutcome = (p: SettlementProposal): Outcome =>
    overrides[p.id] ?? p.proposedOutcome;

  const applyableUpdates = (() => {
    if (!response) return [];
    return response.proposals
      .filter((p): p is SettlementProposal => !isError(p))
      .map((p) => ({
        id: p.id,
        outcome: finalOutcome(p),
        // If the human overrode the proposed outcome, record "manual";
        // otherwise carry the tier/source the pipeline produced.
        source:
          overrides[p.id] != null && overrides[p.id] !== p.proposedOutcome
            ? "manual"
            : (p.source ?? null),
        score: p.score,
      }))
      .filter((u) => u.outcome !== "pending");
  })();

  const errorCount = response ? response.proposals.filter(isError).length : 0;
  const pendingCount = response
    ? response.proposals.filter(
        (p): p is SettlementProposal =>
          !isError(p) && finalOutcome(p) === "pending",
      ).length
    : 0;

  const footer = (
    <>
      <Button
        variant="outline"
        onClick={() => onOpenChange(false)}
        disabled={applying}
      >
        Cancel
      </Button>
      <Button
        onClick={() => onApply(applyableUpdates)}
        disabled={applying || loading || applyableUpdates.length === 0}
      >
        {applying
          ? "Applying…"
          : `Apply ${applyableUpdates.length} outcome${applyableUpdates.length === 1 ? "" : "s"}`}
      </Button>
    </>
  );

  const description = (
    <>
      {candidateRows.length} bet{candidateRows.length === 1 ? "" : "s"} settled
      through the source waterfall (cache → ESPN → SofaScore → API-Football).
      Unresolved rows stay pending for manual review.
    </>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="overflow-hidden flex flex-col sm:max-w-[min(1400px,96vw)] max-h-[90vh]">
          <DialogHeader>
            <DialogTitle>Settlement review</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-auto space-y-3">
            {response?.telemetry && (
              <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground px-1">
                <span className="uppercase tracking-wider">Waterfall:</span>
                <Badge variant="outline" className="h-5 text-[10px]">
                  cache {response.telemetry.tier0_hits}
                </Badge>
                <Badge variant="outline" className="h-5 text-[10px]">
                  live {response.telemetry.tier1_hits}
                </Badge>
                <Badge variant="outline" className="h-5 text-[10px]">
                  APIs {response.telemetry.tier2_hits}
                </Badge>
                <Badge
                  variant="outline"
                  className={cn(
                    "h-5 text-[10px]",
                    response.telemetry.unresolved > 0
                      ? "border-amber-800 text-amber-400"
                      : "",
                  )}
                >
                  unresolved {response.telemetry.unresolved}
                </Badge>
                <span className="ml-auto tabular-nums">
                  {response.telemetry.durationMs}ms
                </span>
              </div>
            )}

            {loading && progress && progress.total > 1 && (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground px-1">
                <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary transition-[width]"
                    style={{
                      width: `${Math.round((progress.done / progress.total) * 100)}%`,
                    }}
                  />
                </div>
                <span className="tabular-nums">
                  Batch {progress.done} / {progress.total}
                  {response &&
                    ` · ${response.proposals.length} proposal${response.proposals.length === 1 ? "" : "s"} so far`}
                </span>
              </div>
            )}

            <div className="flex-1 overflow-auto rounded-md border">
              {loading && (!response || response.proposals.length === 0) && (
                <div className="p-4 space-y-2">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              )}
              {response && response.proposals.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="h-8 text-[10px] uppercase tracking-wider">
                        Event
                      </TableHead>
                      <TableHead className="h-8 text-[10px] uppercase tracking-wider">
                        Market
                      </TableHead>
                      <TableHead className="h-8 text-[10px] uppercase tracking-wider w-52">
                        Settled by
                      </TableHead>
                      <TableHead className="h-8 text-[10px] uppercase tracking-wider w-20">
                        Conf.
                      </TableHead>
                      <TableHead className="h-8 text-[10px] uppercase tracking-wider w-24">
                        Result
                      </TableHead>
                      <TableHead className="h-8 text-[10px] uppercase tracking-wider w-24">
                        Final
                      </TableHead>
                      <TableHead className="h-8 text-[10px] uppercase tracking-wider w-12 text-center">
                        Verify
                      </TableHead>
                      {onRerun && (
                        <TableHead className="h-8 text-[10px] uppercase tracking-wider w-12 text-center">
                          Recheck
                        </TableHead>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {response.proposals.map((p) => {
                      const row = rowsById.get(p.id);
                      if (!row) return null;
                      if (isError(p)) {
                        return (
                          <TableRow key={p.id}>
                            <TableCell className="py-1.5">
                              <span className="font-medium text-[12px]">
                                {row.homeTeam} vs {row.awayTeam}
                              </span>
                            </TableCell>
                            <TableCell className="text-[11px] py-1.5">
                              <MarketDisplay
                                marketType={row.marketType}
                                timeScope={row.timeScope}
                                familyLine={row.familyLine}
                                selection={row.atomLabel}
                                className="max-w-[220px] justify-start"
                              />
                            </TableCell>
                            <TableCell
                              colSpan={4}
                              className="text-[11px] text-rose-400 py-1.5"
                            >
                              Error: {p.error}
                            </TableCell>
                            <TableCell className="py-1.5 text-center">
                              <GoogleAiModeButton row={row} />
                            </TableCell>
                            {onRerun && (
                              <TableCell className="py-1.5 text-center">
                                <RerunButton
                                  id={p.id}
                                  running={rerunningIds?.has(p.id) ?? false}
                                  onRerun={onRerun}
                                />
                              </TableCell>
                            )}
                          </TableRow>
                        );
                      }
                      const final = finalOutcome(p);
                      const changed = final !== p.proposedOutcome;
                      return (
                        <TableRow key={p.id}>
                          <TableCell className="py-1.5">
                            <span className="font-medium text-[12px]">
                              {row.homeTeam} vs {row.awayTeam}
                            </span>
                            {row.competition && (
                              <div className="text-[10px] text-muted-foreground leading-tight">
                                {row.competition}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-[11px] py-1.5">
                            <MarketDisplay
                              marketType={row.marketType}
                              timeScope={row.timeScope}
                              familyLine={row.familyLine}
                              selection={row.atomLabel}
                              className="max-w-[220px] justify-start"
                            />
                          </TableCell>
                          <TableCell className="py-1.5">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <Badge
                                variant="outline"
                                className="text-[10px] h-5 px-1.5 whitespace-nowrap"
                              >
                                {OUTCOME_LABEL[p.proposedOutcome]}
                              </Badge>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Badge
                                    variant="outline"
                                    className={cn(
                                      "text-[10px] h-5 px-1.5 whitespace-nowrap font-normal",
                                      sourceBadgeClass(p.source),
                                    )}
                                  >
                                    {p.tier === "pure"
                                      ? sourceLabel(p.source)
                                      : "unresolved"}
                                  </Badge>
                                </TooltipTrigger>
                                <TooltipContent side="left">
                                  {p.tier === "pure"
                                    ? `Resolved by ${sourceLabel(p.source)}.`
                                    : "Not resolved by any source."}
                                </TooltipContent>
                              </Tooltip>
                            </div>
                          </TableCell>
                          <TableCell className="py-1.5">
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[10px] h-5 px-1.5 tabular-nums",
                                confidenceClass(p.confidence),
                              )}
                            >
                              {(p.confidence * 100).toFixed(0)}%
                            </Badge>
                          </TableCell>
                          <TableCell className="py-1.5">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[12px] font-medium tabular-nums">
                                {p.score || "—"}
                              </span>
                              {p.reasoning && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <button
                                      type="button"
                                      className="inline-flex items-center justify-center size-4 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent"
                                      aria-label="Show reasoning"
                                    >
                                      <Info className="size-3" />
                                    </button>
                                  </TooltipTrigger>
                                  <TooltipContent
                                    side="left"
                                    className="max-w-[320px] text-[11px] leading-snug whitespace-normal"
                                  >
                                    {p.reasoning}
                                  </TooltipContent>
                                </Tooltip>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="py-1.5">
                            <Select
                              value={final}
                              onValueChange={(v) =>
                                setOverrides({
                                  ...overrides,
                                  [p.id]: v as Outcome,
                                })
                              }
                            >
                              <SelectTrigger
                                className={cn(
                                  "h-6 w-[100px] text-[11px] px-2",
                                  changed && "border-amber-500",
                                )}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {OUTCOME_OPTIONS.map((o) => (
                                  <SelectItem
                                    key={o}
                                    value={o}
                                    className="text-[11px]"
                                  >
                                    {OUTCOME_LABEL[o]}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell className="py-1.5 text-center">
                            <GoogleAiModeButton row={row} />
                          </TableCell>
                          {onRerun && (
                            <TableCell className="py-1.5 text-center">
                              <RerunButton
                                id={p.id}
                                running={rerunningIds?.has(p.id) ?? false}
                                onRerun={onRerun}
                              />
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </div>

            {response && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>
                  <span className="font-medium text-foreground">
                    {applyableUpdates.length}
                  </span>{" "}
                  ready to apply
                </span>
                {pendingCount > 0 && (
                  <span>
                    · <span className="font-medium">{pendingCount}</span> still
                    pending (not applied)
                  </span>
                )}
                {errorCount > 0 && (
                  <span>
                    ·{" "}
                    <span className="font-medium text-rose-400">
                      {errorCount}
                    </span>{" "}
                    errored
                  </span>
                )}
                {response.missing.length > 0 && (
                  <span>
                    ·{" "}
                    <span className="font-medium text-rose-400">
                      {response.missing.length}
                    </span>{" "}
                    missing ids
                  </span>
                )}
              </div>
            )}

            {!loading && !response && (
              <Alert>
                <AlertTitle>Nothing to review yet</AlertTitle>
                <AlertDescription>
                  Dialog opened before settlement completed. Close and retry.
                </AlertDescription>
              </Alert>
            )}
          </div>

          <DialogFooter>{footer}</DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

function GoogleAiModeButton({ row }: { row: ValueBetRow }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={buildGoogleAiModeUrl(row)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          aria-label="Verify settlement in Google search"
        >
          <Search className="size-3.5" />
        </a>
      </TooltipTrigger>
      <TooltipContent side="left">Verify settlement</TooltipContent>
    </Tooltip>
  );
}

/**
 * Per-row rerun control. Shows a spinner while an individual request is in
 * flight for that id. The parent owns the actual fetch + response-state update.
 */
export function RerunButton({
  id,
  running,
  disabled,
  onRerun,
}: {
  id: string;
  running: boolean;
  disabled?: boolean;
  onRerun: (id: string) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            size="icon"
            variant="ghost"
            className="size-6 text-muted-foreground hover:text-foreground"
            disabled={running || disabled}
            onClick={() => onRerun(id)}
            aria-label="Recheck result"
          >
            {running ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Gavel className="size-3.5" />
            )}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="left">
        {running ? "Rechecking result" : "Recheck result"}
      </TooltipContent>
    </Tooltip>
  );
}
