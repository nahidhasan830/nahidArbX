"use client";

/**
 * One-click run queuer. POSTs `/api/optimizer/runs` with the opinionated
 * defaults (ensemble / 2000 trials / CPCV / every settled bet / notify on
 * complete) — no sheet, no form, immediate queue. For power users who
 * just want to fire a sweep with one click; the full `SubmitRunSheet`
 * stays available for anything that needs tweaking.
 *
 * Defaults duplicated from lib/optimizer/repository.ts + search-space.py.
 * The API layer re-validates, so these values just drive the submit body.
 */

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Rocket } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { CreateRunRequest } from "@/lib/optimizer/types";

const quickName = () =>
  `Quick ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;

export function QuickRunButton() {
  const qc = useQueryClient();

  const submit = useMutation({
    mutationFn: async (req: CreateRunRequest) => {
      const res = await fetch("/api/optimizer/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      return res.json() as Promise<{ run: { id: string; name: string } }>;
    },
    onSuccess: (data) => {
      toast.success(`Run queued — ${data.run.name}`, {
        description: "Telegram ping will fire when it finishes.",
      });
      qc.invalidateQueries({ queryKey: ["optimizer", "runs"] });
    },
    onError: (err: Error) => toast.error(`Failed to queue run: ${err.message}`),
  });

  return (
    <Button
      size="sm"
      onClick={() =>
        submit.mutate({
          name: quickName(),
          searchAlgorithm: "ensemble",
          nTrialsTarget: 2000,
          cvStrategy: { type: "cpcv" },
          notifyOnComplete: true,
        })
      }
      disabled={submit.isPending}
      className="gap-1.5 h-7 text-[11px]"
      title="Queue a run with opinionated defaults (ensemble, 2000 trials, CPCV, all bets, Telegram on)"
    >
      <Rocket className="size-3.5" />
      {submit.isPending ? "Queueing…" : "Run now"}
    </Button>
  );
}
