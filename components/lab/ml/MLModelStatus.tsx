"use client";

/**
 * ML Optimizer — Section components for History and Retrain.
 *
 * Exports individual section components that are composed by the
 * main MLOptimizerDashboard in both the Overview and Setup Guide tabs.
 */

import { useCallback, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Cpu,
  RefreshCw,
  Clock,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DataTable } from "@/components/ui/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import type { MlModelRow } from "@/lib/db/schema";
import { toast } from "sonner";

// ── Queries ───────────────────────────────────────────────────────────

export function useModels() {
  return useQuery<{ models: MlModelRow[] }>({
    queryKey: ["ml", "models"],
    queryFn: async () => {
      const res = await fetch("/api/ml/models", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const cfg = {
    deployed: { icon: CheckCircle2, color: "text-emerald-400 bg-emerald-500/15 border-emerald-500/30", label: "Deployed" },
    validated: { icon: Activity, color: "text-blue-400 bg-blue-500/15 border-blue-500/30", label: "Validated" },
    training: { icon: Loader2, color: "text-amber-400 bg-amber-500/15 border-amber-500/30", label: "Training" },
    failed: { icon: XCircle, color: "text-red-400 bg-red-500/15 border-red-500/30", label: "Failed" },
    retired: { icon: Clock, color: "text-zinc-400 bg-zinc-500/15 border-zinc-500/30", label: "Retired" },
  }[status] ?? { icon: AlertTriangle, color: "text-zinc-400 bg-zinc-500/15 border-zinc-500/30", label: status };
  const Icon = cfg.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium", cfg.color)}>
      <Icon className={cn("size-3", status === "training" && "animate-pulse")} />
      {cfg.label}
    </span>
  );
}

// ── Columns ───────────────────────────────────────────────────────────

const columns: ColumnDef<MlModelRow>[] = [
  { accessorKey: "version", header: "Ver",
    cell: ({ row }) => <span className="font-medium tabular-nums">v{row.original.version}</span>,
    meta: { hint: "Model version number", initialSize: 60 } },
  { accessorKey: "status", header: "Status",
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
    meta: { hint: "Model lifecycle: training → validated → deployed → retired", initialSize: 110 } },
  { accessorKey: "trainingSamples", header: "Samples",
    cell: ({ row }) => <span className="tabular-nums">{row.original.trainingSamples.toLocaleString()}</span>,
    meta: { hint: "Number of settled bets used for training", align: "right" as const, initialSize: 90 } },
  { accessorKey: "oosAucRoc", header: "AUC",
    cell: ({ row }) => row.original.oosAucRoc != null ? Number(row.original.oosAucRoc).toFixed(4) : "—",
    meta: { hint: "Area Under the ROC Curve — 1.0 = perfect, 0.5 = random. Above 0.55 is useful.", align: "right" as const, initialSize: 80 } },
  { accessorKey: "deflatedSharpe", header: "DSR",
    cell: ({ row }) => row.original.deflatedSharpe != null ? Number(row.original.deflatedSharpe).toFixed(3) : "—",
    meta: { hint: "Deflated Sharpe Ratio — adjusts for trial count. Above 1.0 is strong.", align: "right" as const, initialSize: 80 } },
  { accessorKey: "pbo", header: "PBO",
    cell: ({ row }) => row.original.pbo != null ? Number(row.original.pbo).toFixed(3) : "—",
    meta: { hint: "Probability of Backtest Overfitting — lower is better. Below 0.5 = likely real.", align: "right" as const, initialSize: 80 } },
  { accessorKey: "createdAt", header: "Created",
    cell: ({ row }) => row.original.createdAt ? new Date(row.original.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—",
    meta: { hint: "When this model was trained", initialSize: 140 } },
];

// ── Retrain Button (shared) ───────────────────────────────────────────

export function RetrainButton({
  size = "sm",
  hasExistingModel,
  disabledReason,
  isTraining,
  trainingVersion,
}: {
  size?: "sm" | "default";
  hasExistingModel?: boolean;
  disabledReason?: string;
  /** When true, button shows a training-in-progress state. */
  isTraining?: boolean;
  /** Version currently training (e.g. 1). */
  trainingVersion?: number;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const retrain = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/ml/retrain", { method: "POST" });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        throw new Error(b.error ?? `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(hasExistingModel ? "Retraining job triggered" : "Training job triggered");
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ["ml"] });
    },
    onError: (e) => toast.error(`${hasExistingModel ? "Retrain" : "Training"} failed: ${e.message}`),
  });

  const isDisabled = retrain.isPending || Boolean(disabledReason) || Boolean(isTraining);
  const actionLabel = hasExistingModel ? "Retrain Model" : "Train Model";
  const dialogTitle = hasExistingModel ? "Retrain model?" : "Train first model?";
  const startLabel = hasExistingModel ? "Start Retraining" : "Start Training";
  const tooltip = isTraining
    ? `Training v${trainingVersion ?? "?"} in progress — wait for completion.`
    : disabledReason
      ?? (hasExistingModel
        ? "Start a new Cloud Run training job using the latest settled examples."
        : "Start the first Cloud Run training job once enough settled examples exist.");
  const Icon = hasExistingModel ? RefreshCw : Cpu;
  const doRetrain = useCallback(() => { retrain.mutate(); }, [retrain]);

  // Show pulsing training state
  const buttonLabel = retrain.isPending
    ? "Starting..."
    : isTraining
      ? `Training v${trainingVersion ?? "?"}...`
      : actionLabel;
  const ButtonIcon = retrain.isPending || isTraining
    ? Loader2
    : Icon;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size={size}
            className={cn(
              "px-2.5 text-[11px]",
              size === "sm" && "h-7",
              isTraining && "border-cyan-500/30 text-cyan-400 animate-pulse",
            )}
            disabled={isDisabled}
            onClick={() => setOpen(true)}
          >
            <ButtonIcon className={cn("mr-1.5 size-3", (retrain.isPending || isTraining) && "animate-spin")} />
            {buttonLabel}
          </Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[300px] text-sm leading-relaxed">{tooltip}</TooltipContent>
      </Tooltip>
      <DialogContent>
        <DialogHeader><DialogTitle>{dialogTitle}</DialogTitle>
        <DialogDescription>
          This starts a LightGBM Cloud Run job using settled bets with feature vectors. It usually takes 5-15 minutes. A candidate only deploys if validation gates accept it; otherwise it is saved as rejected for review.
        </DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)} disabled={retrain.isPending}>Cancel</Button><Button onClick={doRetrain} disabled={retrain.isPending}>{retrain.isPending ? "Starting..." : startLabel}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}



// ── History Section ───────────────────────────────────────────────────

export function HistorySection() {
  const { data: md, isLoading } = useModels();
  const models = md?.models ?? [];

  return (
    <section>
      <div className="mb-3">
        <h3 className="text-base font-semibold text-foreground">Training History</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          {models.length} model{models.length !== 1 ? "s" : ""} total. Models passing quality gates (DSR &gt; 0.8, PBO &lt; 0.5) are auto-deployed.
        </p>
      </div>
      {isLoading ? (
        <div className="space-y-2 py-6">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-10 bg-muted/15 rounded-lg animate-pulse" style={{ animationDelay: `${i * 80}ms` }} />
          ))}
        </div>
      ) : models.length === 0 ? (
        <div className="text-sm text-muted-foreground rounded-lg border border-border/40 bg-muted/10 px-4 py-3">
          No training runs yet. Collect enough data, then click <strong>Train Model</strong>.
        </div>
      ) : (
        <DataTable columns={columns} data={models} getRowId={(r) => r.id} enableSorting enableColumnResizing density="compact" persistenceKey="ml-training-history" />
      )}
    </section>
  );
}
