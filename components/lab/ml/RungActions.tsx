"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Loader2, Terminal, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { PipelineData } from "./types";
import type { RungAction, RungDefinition } from "@/lib/lab/ml/rungs";

interface Props {
  definition: RungDefinition;
  data: PipelineData;
}

/**
 * Renders the inline action buttons for a rung. Two kinds:
 *
 *   - mutation: POST to an endpoint, optionally guarded by a confirm dialog.
 *   - instruction: shows a copyable command (operator runs locally).
 */
export function RungActions({ definition, data }: Props) {
  const actions = (definition.actions ?? []).filter(
    (a) => a.visibleWhen?.(data) ?? true,
  );

  if (actions.length === 0) return null;

  return (
    <div className="grid gap-2">
      {actions.map((action) =>
        action.kind === "mutation" ? (
          <MutationAction key={action.id} action={action} data={data} />
        ) : (
          <InstructionAction key={action.id} action={action} />
        ),
      )}
    </div>
  );
}

function MutationAction({
  action,
  data,
}: {
  action: Extract<RungAction, { kind: "mutation" }>;
  data: PipelineData;
}) {
  const qc = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);

  const isDestructive = action.intent === "destructive";

  const run = async () => {
    setRunning(true);
    try {
      const res = await fetch(action.endpoint, {
        method: action.method ?? "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action.body?.(data) ?? {}),
      });
      const payload = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!res.ok) {
        throw new Error(
          (payload.error as string) ?? `HTTP ${res.status}`,
        );
      }
      toast.success(`${action.label} succeeded`, {
        description: describeMutationResult(payload),
      });
      // Refresh the pipeline payload so the dashboard reflects the change.
      void qc.invalidateQueries({ queryKey: ["ml", "pipeline"] });
    } catch (err) {
      toast.error(`${action.label} failed`, {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunning(false);
      setConfirmOpen(false);
    }
  };

  return (
    <div className="flex items-start gap-3 rounded-md border border-border/40 bg-background/60 px-3 py-2.5">
      <Zap className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-foreground">{action.label}</p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
          {action.description}
        </p>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant={isDestructive ? "destructive" : "default"}
            disabled={running}
            onClick={() => {
              if (action.confirm) setConfirmOpen(true);
              else void run();
            }}
            className="h-7 shrink-0 text-[12px]"
          >
            {running ? (
              <Loader2 className="mr-1.5 size-3 animate-spin" />
            ) : null}
            {action.label}
          </Button>
        </TooltipTrigger>
        <TooltipContent className="text-sm">
          {isDestructive ? "Destructive — confirm required" : "Runs immediately"}
        </TooltipContent>
      </Tooltip>

      {action.confirm && (
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{action.confirm.title}</DialogTitle>
              <DialogDescription className="text-sm leading-relaxed">
                {action.confirm.body}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => setConfirmOpen(false)}
                disabled={running}
              >
                Cancel
              </Button>
              <Button
                variant={isDestructive ? "destructive" : "default"}
                onClick={() => void run()}
                disabled={running}
              >
                {running ? (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                ) : null}
                {action.confirm.confirmText ?? action.label}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function describeMutationResult(payload: Record<string, unknown>): string {
  if (typeof payload.written === "number") {
    return `${payload.written} training examples written.`;
  }
  if (typeof payload.modelId === "string") {
    return `model id: ${payload.modelId}`;
  }
  if (typeof payload.targetVersion === "number") {
    const prev = payload.previousVersion as number | null | undefined;
    return prev
      ? `v${prev} retired, v${payload.targetVersion} deployed.`
      : `v${payload.targetVersion} deployed.`;
  }
  return "OK.";
}

function InstructionAction({
  action,
}: {
  action: Extract<RungAction, { kind: "instruction" }>;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard
      .writeText(action.command)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* clipboard not allowed; user can still select/copy */
      });
  };

  return (
    <div className="grid gap-2 rounded-md border border-border/40 bg-background/60 px-3 py-2.5">
      <div className="flex items-start gap-3">
        <Terminal className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-foreground">
            {action.label}
          </p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
            {action.description}
          </p>
        </div>
      </div>
      <div className="relative">
        <pre className="overflow-x-auto rounded-md border border-border/50 bg-background/80 px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground/90">
          {action.command}
        </pre>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={handleCopy}
              className={cn(
                "absolute right-1.5 top-1.5 size-6 rounded-md text-muted-foreground hover:text-foreground",
                copied && "text-emerald-400 hover:text-emerald-400",
              )}
              aria-label={copied ? "Copied" : "Copy command"}
            >
              {copied ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent className="text-sm">
            {copied ? "Copied" : "Copy command"}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
