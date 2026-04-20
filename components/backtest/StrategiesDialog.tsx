"use client";

import { useMemo, useState } from "react";
import {
  BookmarkPlus,
  ListOrdered,
  Pause,
  Play,
  PlayCircle,
  Sparkles,
  Trash2,
  UserPen,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useCreateStrategy,
  useDeleteStrategy,
  useStrategies,
  useUpdateStrategy,
} from "@/lib/backtest/hooks";
import type { ListFilters, Strategy } from "@/lib/backtest/api-client";
import { cn } from "@/lib/utils";
import { ExecutionsDialog } from "./ExecutionsDialog";

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  currentFilters: ListFilters;
  onLoadStrategy: (s: Strategy) => void;
};

// Filter fields that are meaningful to display on a strategy card. Pagination
// and source flags are stripped so a loaded strategy doesn't clobber the
// current dummy/real toggle.
const FILTER_DISPLAY_KEYS: (keyof ListFilters)[] = [
  "marketTypes",
  "softProviders",
  "outcome",
  "minEv",
  "maxEv",
  "search",
  "readyToSettle",
];

const summarizeFilters = (f: ListFilters): string => {
  const parts: string[] = [];
  if (f.marketTypes?.length) parts.push(`markets: ${f.marketTypes.join(",")}`);
  if (f.softProviders?.length)
    parts.push(`books: ${f.softProviders.join(",")}`);
  if (f.outcome) parts.push(`outcome=${f.outcome}`);
  if (f.minEv != null || f.maxEv != null)
    parts.push(`EV: ${f.minEv ?? "–∞"} to ${f.maxEv ?? "+∞"}`);
  if (f.search) parts.push(`"${f.search}"`);
  if (f.readyToSettle) parts.push("ready-to-settle");
  if (f.from || f.to)
    parts.push(
      `dates: ${f.from?.slice(0, 10) ?? ""}→${f.to?.slice(0, 10) ?? ""}`,
    );
  return parts.length ? parts.join(" · ") : "(no filters)";
};

const STATUS_PILL: Record<Strategy["status"], string> = {
  candidate: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
  live: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  paused: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  retired: "bg-muted text-muted-foreground border-border",
};

export function StrategiesDialog({
  open,
  onOpenChange,
  currentFilters,
  onLoadStrategy,
}: Props) {
  const { data: strategies = [], isLoading } = useStrategies();
  const createMut = useCreateStrategy();
  const updateMut = useUpdateStrategy();
  const deleteMut = useDeleteStrategy();

  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [executionsFor, setExecutionsFor] = useState<Strategy | null>(null);

  const cycleStatus = async (s: Strategy) => {
    const next: Strategy["status"] =
      s.status === "candidate"
        ? "live"
        : s.status === "live"
          ? "paused"
          : s.status === "paused"
            ? "candidate"
            : "candidate";
    try {
      await updateMut.mutateAsync({ id: s.id, patch: { status: next } });
      toast.success(`"${s.name}" is now ${next}`);
    } catch (err) {
      toast.error(`Status change failed: ${(err as Error).message}`);
    }
  };

  const cleanedFilters = useMemo(() => {
    // Strip offset/limit so saved strategies don't pin pagination.
    const { offset: _o, limit: _l, ...rest } = currentFilters;
    return rest as ListFilters;
  }, [currentFilters]);

  const hasActiveFilters = FILTER_DISPLAY_KEYS.some(
    (k) =>
      cleanedFilters[k] !== undefined &&
      !(
        Array.isArray(cleanedFilters[k]) &&
        (cleanedFilters[k] as unknown[]).length === 0
      ),
  );

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Give the strategy a name first");
      return;
    }
    try {
      await createMut.mutateAsync({
        name: trimmed,
        description: desc.trim() || null,
        filters: cleanedFilters,
        origin: "manual",
      });
      setName("");
      setDesc("");
      toast.success(`Saved "${trimmed}"`);
    } catch (err) {
      toast.error(`Save failed: ${(err as Error).message}`);
    }
  };

  const handleDelete = async (s: Strategy) => {
    if (!confirm(`Delete strategy "${s.name}"? This cannot be undone.`)) return;
    try {
      await deleteMut.mutateAsync(s.id);
      toast.success(`Deleted "${s.name}"`);
    } catch (err) {
      toast.error(`Delete failed: ${(err as Error).message}`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Strategies</DialogTitle>
          <DialogDescription>
            Save the current filter set as a reusable strategy. Load a saved
            strategy to re-apply its filters to the spreadsheet.
          </DialogDescription>
        </DialogHeader>

        <TooltipProvider delayDuration={200}>
          <div className="flex-1 overflow-auto space-y-4 pr-1">
            {/* Save current filters */}
            <section className="rounded-md border border-dashed border-border bg-muted/30 p-3">
              <div className="flex items-center gap-2 mb-2">
                <BookmarkPlus className="size-3.5 text-primary" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Save current filters
                </h3>
              </div>
              <div className="text-[11px] text-muted-foreground mb-2">
                {summarizeFilters(cleanedFilters)}
              </div>
              <div className="flex flex-col gap-1.5">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Strategy name"
                  className="h-8 text-[12px]"
                  disabled={createMut.isPending}
                />
                <textarea
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                  placeholder="Optional: why is this edge interesting?"
                  className="rounded-md border border-input bg-transparent px-3 py-2 text-[11px] min-h-[60px] shadow-xs focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none"
                  disabled={createMut.isPending}
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    onClick={handleSave}
                    disabled={
                      createMut.isPending || !name.trim() || !hasActiveFilters
                    }
                  >
                    {createMut.isPending ? "Saving…" : "Save"}
                  </Button>
                </div>
                {!hasActiveFilters && (
                  <div className="text-[10px] text-amber-300">
                    Apply at least one filter before saving.
                  </div>
                )}
              </div>
            </section>

            {/* Saved strategies list */}
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Saved ({strategies.length})
              </h3>
              {isLoading ? (
                <div className="text-[11px] text-muted-foreground py-4 text-center">
                  Loading…
                </div>
              ) : strategies.length === 0 ? (
                <div className="text-[11px] text-muted-foreground py-4 text-center">
                  No strategies saved yet. Apply filters above and hit Save.
                </div>
              ) : (
                <ul className="flex flex-col gap-2">
                  {strategies.map((s) => (
                    <li
                      key={s.id}
                      className="rounded-md border border-border bg-muted/20 p-3 flex flex-col gap-1.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-medium text-[13px]">
                              {s.name}
                            </span>
                            <Badge
                              className={cn(
                                "h-4 px-1.5 text-[9px] border",
                                STATUS_PILL[s.status],
                              )}
                              variant="outline"
                            >
                              {s.status}
                            </Badge>
                            {s.origin === "ai" && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex items-center gap-0.5 rounded-sm bg-purple-500/15 text-purple-300 border border-purple-500/40 px-1 py-0 text-[9px] font-medium leading-none">
                                    <Sparkles className="size-2.5" />
                                    AI
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>
                                  Proposed by Gemini — verify on OOS data
                                </TooltipContent>
                              </Tooltip>
                            )}
                            {s.origin === "manual" && (
                              <UserPen className="size-3 text-muted-foreground" />
                            )}
                          </div>
                          {s.description && (
                            <div className="text-[11px] text-muted-foreground mt-0.5">
                              {s.description}
                            </div>
                          )}
                          <div className="text-[10px] text-muted-foreground/80 font-mono mt-1 truncate">
                            {summarizeFilters(s.filters)}
                          </div>
                          {s.rationale && (
                            <details className="mt-1">
                              <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground">
                                Reasoning
                              </summary>
                              <pre className="text-[10px] text-muted-foreground/90 mt-1 whitespace-pre-wrap bg-muted/40 p-2 rounded">
                                {s.rationale}
                              </pre>
                            </details>
                          )}

                          {/* Live summary — only shown when we have executions */}
                          {s.summary && s.summary.totalExecutions > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] tabular-nums">
                              <span>
                                <span className="text-muted-foreground mr-1">
                                  Live
                                </span>
                                <span className="font-medium">
                                  {s.summary.totalExecutions}
                                </span>
                              </span>
                              <span>
                                <span className="text-muted-foreground mr-1">
                                  W/L
                                </span>
                                <span className="text-emerald-400">
                                  {s.summary.wins}
                                </span>
                                <span className="text-muted-foreground mx-0.5">
                                  /
                                </span>
                                <span className="text-rose-400">
                                  {s.summary.losses}
                                </span>
                              </span>
                              <span>
                                <span className="text-muted-foreground mr-1">
                                  ROI
                                </span>
                                <span
                                  className={cn(
                                    "font-medium",
                                    s.summary.roiPct == null
                                      ? "text-muted-foreground"
                                      : s.summary.roiPct > 0
                                        ? "text-emerald-400"
                                        : s.summary.roiPct < 0
                                          ? "text-rose-400"
                                          : "",
                                  )}
                                >
                                  {s.summary.roiPct == null
                                    ? "—"
                                    : `${s.summary.roiPct > 0 ? "+" : ""}${s.summary.roiPct.toFixed(1)}%`}
                                </span>
                              </span>
                              <span>
                                <span className="text-muted-foreground mr-1">
                                  CLV
                                </span>
                                <span
                                  className={cn(
                                    "font-medium",
                                    s.summary.clvPct == null
                                      ? "text-muted-foreground"
                                      : s.summary.clvPct > 0
                                        ? "text-emerald-400"
                                        : "text-rose-400",
                                  )}
                                >
                                  {s.summary.clvPct == null
                                    ? "—"
                                    : `${s.summary.clvPct > 0 ? "+" : ""}${s.summary.clvPct.toFixed(2)}%`}
                                </span>
                              </span>
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-0.5 shrink-0">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                size="icon"
                                variant="ghost"
                                className={cn(
                                  "size-7",
                                  s.status === "live"
                                    ? "text-emerald-300 hover:text-emerald-300 hover:bg-emerald-500/10"
                                    : s.status === "paused"
                                      ? "text-amber-300 hover:text-amber-300 hover:bg-amber-500/10"
                                      : "",
                                )}
                                onClick={() => cycleStatus(s)}
                                disabled={updateMut.isPending}
                              >
                                {s.status === "live" ? (
                                  <Pause className="size-3.5" />
                                ) : (
                                  <PlayCircle className="size-3.5" />
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {s.status === "candidate" &&
                                "Promote to live — matcher records executions"}
                              {s.status === "live" && "Pause matcher"}
                              {s.status === "paused" && "Back to candidate"}
                              {s.status === "retired" && "Retired"}
                            </TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="size-7"
                                onClick={() => setExecutionsFor(s)}
                                disabled={
                                  !s.summary || s.summary.totalExecutions === 0
                                }
                              >
                                <ListOrdered className="size-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {s.summary?.totalExecutions
                                ? `View ${s.summary.totalExecutions} executions`
                                : "No executions yet"}
                            </TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="size-7"
                                onClick={() => {
                                  onLoadStrategy(s);
                                  onOpenChange(false);
                                  toast.success(`Loaded "${s.name}"`);
                                }}
                              >
                                <Play className="size-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Apply filters</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="size-7 text-rose-300 hover:text-rose-300 hover:bg-rose-500/10"
                                onClick={() => handleDelete(s)}
                                disabled={deleteMut.isPending}
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Delete</TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </TooltipProvider>
      </DialogContent>

      <ExecutionsDialog
        strategy={executionsFor}
        onOpenChange={(o) => {
          if (!o) setExecutionsFor(null);
        }}
      />
    </Dialog>
  );
}
