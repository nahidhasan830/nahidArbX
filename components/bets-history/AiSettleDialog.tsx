"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Crown,
  ExternalLink,
  Info,
  Gavel,
  Loader2,
  Sparkles,
  Workflow,
  Zap,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { buildGoogleAiModeUrl } from "@/lib/bets-history/google-verify";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  AiLabelResponse,
  AiLabelResult,
  ModelTier,
  Outcome,
} from "@/lib/bets-history/api-client";
import type { ValueBetRow } from "@/lib/bets-history/types";
import { cn } from "@/lib/utils";
import { formatMarketType, formatAtomLabel } from "@/lib/formatting/labels";

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

const marketLabel = (row: ValueBetRow) => {
  const line = row.familyLine != null ? ` ${row.familyLine}` : "";
  const market = formatMarketType(row.marketType);
  const atom = formatAtomLabel(row.atomLabel);
  return `${market}${line} · ${atom}`;
};

/**
 * Options the user can pick when re-running a single proposal. The
 * "default" option runs the free waterfall again (bypassing cache so
 * the source can actually change); the AI tiers skip the free tiers
 * and go straight to Gemini.
 */
export type RerunChoice =
  | { kind: "default" }
  | { kind: "ai"; model: ModelTier };

export const RERUN_OPTIONS: {
  choice: RerunChoice;
  label: string;
  hint: string;
  group: "default" | "ai";
  icon: React.ComponentType<{ className?: string }>;
  accent?: string;
}[] = [
  {
    choice: { kind: "default" },
    label: "Default pipeline",
    hint: "Bypasses cache → ESPN → SofaScore (no AI)",
    group: "default",
    icon: Workflow,
    accent: "text-emerald-400",
  },
  {
    choice: { kind: "ai", model: "lite" },
    label: "Lite",
    hint: "Cheapest AI — default model",
    group: "ai",
    icon: Zap,
    accent: "text-blue-400",
  },
  {
    choice: { kind: "ai", model: "flash" },
    label: "Flash",
    hint: "Balanced — if Lite looks shaky",
    group: "ai",
    icon: Sparkles,
    accent: "text-violet-400",
  },
  {
    choice: { kind: "ai", model: "pro" },
    label: "Pro",
    hint: "Most capable — use for stuck rows",
    group: "ai",
    icon: Crown,
    accent: "text-amber-400",
  },
];

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
    sofascore: "SofaScore",
    openligadb: "OpenLigaDB",
    "football-data": "football-data",
    "url-context": "Gemini url_context",
    "gemini-batch": "Gemini Batch",
    "legacy-ai": "Legacy AI",
    manual: "Manual",
  };
  return map[source] ?? source;
};

/** Visual pill for the tier — cheap/free sources look different from AI. */
const sourceBadgeClass = (source: string | null): string => {
  if (!source) return "bg-muted/40 text-muted-foreground border-muted";
  if (
    source === "url-context" ||
    source === "gemini-batch" ||
    source === "legacy-ai"
  )
    return "bg-violet-600/20 text-violet-400 border-violet-800";
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
  response: AiLabelResponse | null;
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
  /**
   * Re-run a single proposal at the given model tier. The parent is
   * responsible for POSTing to /api/bets-history/ai-label with ids=[id] and
   * replacing that id's proposal in `response` when it returns.
   */
  onRerun?: (id: string, choice: RerunChoice) => void;
};

const isError = (
  p: AiLabelResponse["proposals"][number],
): p is { id: string; error: string } => "error" in p;

export function AiSettleDialog({
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

  useEffect(() => {
    if (!open) setOverrides({});
  }, [open]);

  const rowsById = useMemo(
    () => new Map(candidateRows.map((r) => [r.id, r])),
    [candidateRows],
  );

  const finalOutcome = (p: AiLabelResult): Outcome =>
    overrides[p.id] ?? p.proposedOutcome;

  const applyableUpdates = useMemo(() => {
    if (!response) return [];
    return response.proposals
      .filter((p): p is AiLabelResult => !isError(p))
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
  }, [response, overrides]);

  const errorCount = response ? response.proposals.filter(isError).length : 0;
  const pendingCount = response
    ? response.proposals.filter(
        (p): p is AiLabelResult => !isError(p) && finalOutcome(p) === "pending",
      ).length
    : 0;

  return (
    <TooltipProvider delayDuration={200}>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[min(1400px,96vw)] max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>Settlement review</DialogTitle>
            <DialogDescription>
              {candidateRows.length} bet{candidateRows.length === 1 ? "" : "s"}{" "}
              settled through the waterfall (cache → live feed → ESPN →
              SofaScore → optional AI). Unresolved rows can be manually verified
              via the Google AI Mode link beside each event.
            </DialogDescription>
          </DialogHeader>

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
                free APIs {response.telemetry.tier2_hits}
              </Badge>
              <Badge variant="outline" className="h-5 text-[10px]">
                AI {response.telemetry.tier3_hits}
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
                    {onRerun && (
                      <TableHead className="h-8 text-[10px] uppercase tracking-wider w-12 text-center">
                        Re-run
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
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-[12px]">
                                {row.homeTeam} vs {row.awayTeam}
                              </span>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <a
                                    href={buildGoogleAiModeUrl(row)}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex items-center justify-center size-4 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent"
                                  >
                                    <ExternalLink className="size-3" />
                                  </a>
                                </TooltipTrigger>
                                <TooltipContent>
                                  Verify on Google AI Mode
                                </TooltipContent>
                              </Tooltip>
                            </div>
                          </TableCell>
                          <TableCell className="text-[11px] py-1.5">
                            {marketLabel(row)}
                          </TableCell>
                          <TableCell
                            colSpan={4}
                            className="text-[11px] text-rose-400 py-1.5"
                          >
                            Error: {p.error}
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
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium text-[12px]">
                              {row.homeTeam} vs {row.awayTeam}
                            </span>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <a
                                  href={buildGoogleAiModeUrl(row)}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center justify-center size-4 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent"
                                >
                                  <ExternalLink className="size-3" />
                                </a>
                              </TooltipTrigger>
                              <TooltipContent>
                                Verify on Google AI Mode
                              </TooltipContent>
                            </Tooltip>
                          </div>
                          {row.competition && (
                            <div className="text-[10px] text-muted-foreground leading-tight">
                              {row.competition}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-[11px] py-1.5">
                          {marketLabel(row)}
                        </TableCell>
                        <TableCell className="py-1.5">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <Badge
                              variant="outline"
                              className="text-[10px] h-5 px-1.5 whitespace-nowrap"
                            >
                              {OUTCOME_LABEL[p.proposedOutcome]}
                            </Badge>
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[10px] h-5 px-1.5 whitespace-nowrap font-normal",
                                sourceBadgeClass(p.source),
                              )}
                              title={
                                p.tier === "pure"
                                  ? `Resolved by ${sourceLabel(p.source)} — deterministic settlement.`
                                  : "Not resolved by any free tier — manually verify."
                              }
                            >
                              {p.tier === "pure"
                                ? sourceLabel(p.source)
                                : "unresolved"}
                            </Badge>
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
                Dialog opened before the AI call completed. Close and retry.
              </AlertDescription>
            </Alert>
          )}

          <DialogFooter>
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
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

/**
 * Per-row "re-run with <model>" control. Shows a spinner while an individual
 * re-run request is in flight for that id. The parent owns the actual fetch
 * + response-state update — we just fire the callback.
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
  onRerun: (id: string, choice: RerunChoice) => void;
}) {
  const rerunKey = (c: RerunChoice) =>
    c.kind === "default" ? "default" : `ai-${c.model}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-6 text-muted-foreground hover:text-foreground"
          disabled={running || disabled}
          title={
            disabled
              ? undefined
              : "Settle this event — pick pipeline or AI model"
          }
        >
          {running ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Gavel className="size-3.5" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[180px] p-1">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground/70 px-2 py-1">
          Settle with
        </DropdownMenuLabel>
        {RERUN_OPTIONS.filter((o) => o.group === "default").map((opt) => (
          <DropdownMenuItem
            key={rerunKey(opt.choice)}
            onSelect={() => onRerun(id, opt.choice)}
            className="cursor-pointer gap-2.5 rounded-md px-2 py-2"
            title={opt.hint}
          >
            <opt.icon className={cn("size-3.5 shrink-0", opt.accent)} />
            <span className="text-[12px] font-medium">{opt.label}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator className="my-1" />
        <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground/70 px-2 py-1">
          AI Models
        </DropdownMenuLabel>
        {RERUN_OPTIONS.filter((o) => o.group === "ai").map((opt) => (
          <DropdownMenuItem
            key={rerunKey(opt.choice)}
            onSelect={() => onRerun(id, opt.choice)}
            className="cursor-pointer gap-2.5 rounded-md px-2 py-2"
            title={opt.hint}
          >
            <opt.icon className={cn("size-3.5 shrink-0", opt.accent)} />
            <span className="text-[12px] font-medium">{opt.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
