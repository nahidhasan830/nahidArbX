"use client";

/**
 * ML Optimizer — Retrain button and model status helpers.
 *
 * Exports the RetrainButton component used by the ML dashboard.
 */

import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Cpu, RefreshCw, Loader2 } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { toast } from "sonner";

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
      toast.success("Cloud training pipeline started");
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ["ml"] });
    },
    onError: (e) => toast.error(`Training failed: ${e.message}`),
  });

  const isDisabled =
    retrain.isPending || Boolean(disabledReason) || Boolean(isTraining);
  const actionLabel = hasExistingModel ? "Retrain Model" : "Train Model";
  const dialogTitle = hasExistingModel
    ? "Retrain model?"
    : "Train first model?";
  const startLabel = hasExistingModel ? "Start Retraining" : "Start Training";
  const tooltip = isTraining
    ? `Training v${trainingVersion ?? "?"} in progress — wait for completion.`
    : (disabledReason ??
      (hasExistingModel
        ? "Build a fresh model from the latest settled examples."
        : "Build the first model once enough settled examples exist."));
  const Icon = hasExistingModel ? RefreshCw : Cpu;
  const doRetrain = useCallback(() => {
    retrain.mutate();
  }, [retrain]);

  // Show pulsing training state
  const buttonLabel = retrain.isPending
    ? "Starting..."
    : isTraining
      ? `Training v${trainingVersion ?? "?"}...`
      : actionLabel;
  const ButtonIcon = retrain.isPending || isTraining ? Loader2 : Icon;

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
            <ButtonIcon
              className={cn(
                "mr-1.5 size-3",
                (retrain.isPending || isTraining) && "animate-spin",
              )}
            />
            {buttonLabel}
          </Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[300px] text-sm leading-relaxed">
          {tooltip}
        </TooltipContent>
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>
            This starts the background trainer with the latest settled examples.
            It usually takes 5-10 minutes. A candidate model only goes live if
            it passes the safety checks.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={retrain.isPending}
          >
            Cancel
          </Button>
          <Button onClick={doRetrain} disabled={retrain.isPending}>
            {retrain.isPending ? "Starting..." : startLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
