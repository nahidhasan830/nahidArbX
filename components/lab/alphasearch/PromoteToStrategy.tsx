"use client";

/**
 * Promote-to-strategy popover for the trial drawer.
 *
 * Captures a name + optional description and POSTs to /api/optimizer/promote.
 * The API route extracts filters/sizing from the trial's `params` and
 * snapshots the OOS metrics for the audit trail. Resulting strategy
 * starts in `candidate` status — user activates from the Strategies tab.
 */

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Rocket } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export function PromoteToStrategy({
  trialId,
  defaultName,
}: {
  trialId: string;
  defaultName: string;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState(defaultName);
  const [description, setDescription] = React.useState("");

  const promote = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/optimizer/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trialId,
          name,
          description: description.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success(
        "Strategy created (status: candidate). Activate from the Strategies tab to make it live.",
      );
      qc.invalidateQueries({ queryKey: ["optimizer", "strategies"] });
      setOpen(false);
    },
    onError: (e: Error) => toast.error(`Promote failed: ${e.message}`),
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" className="w-full gap-1.5">
          <Rocket className="size-3.5" /> Promote to strategy
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-3">
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium">Strategy name</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium">
            Description (optional)
          </label>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Why you promoted this trial…"
            className="h-8 text-xs"
          />
        </div>
        <p className="text-[10px] text-muted-foreground">
          Strategy will start in <strong>candidate</strong> status. Activate
          from the Strategies tab to make it live (the value detector starts
          claiming matching bets immediately).
        </p>
        <Button
          onClick={() => promote.mutate()}
          disabled={promote.isPending || !name.trim()}
          className="w-full"
          size="sm"
        >
          {promote.isPending ? "Creating…" : "Create candidate strategy"}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
