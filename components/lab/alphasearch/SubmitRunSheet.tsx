"use client";

/**
 * Submit-new-run sheet.
 *
 * Phase-1 minimum viable form: name, algorithm, n_trials. Defaults are
 * sensible enough for a casual user to click "Start" and get a result.
 * Phase 2 adds the per-dimension search-space editor.
 */

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { TermTooltip } from "@/components/ui/TermTooltip";
import { DataFiltersSection } from "./DataFiltersSection";
import type {
  CreateRunRequest,
  DataFiltersJson,
  SearchAlgorithm,
} from "@/lib/optimizer/types";

const ALGOS: Array<{ value: SearchAlgorithm; label: string; help: string }> = [
  {
    value: "ensemble",
    label: "Ensemble (recommended)",
    help: "Random + TPE under one study — best of both worlds.",
  },
  {
    value: "tpe",
    label: "TPE (Bayesian)",
    help: "Smart sampler, fast convergence.",
  },
  { value: "random", label: "Random", help: "Unbiased baseline coverage." },
  {
    value: "nsga2",
    label: "NSGA-II (multi-objective)",
    help: "Returns Pareto frontier directly. Slower.",
  },
];

// True if any filter would actually narrow the dataset.
const hasFilters = (f: DataFiltersJson): boolean =>
  Boolean(
    f.excludeSoftProviders?.length ||
    f.includeSoftProviders?.length ||
    f.excludeMarketTypes?.length ||
    f.includeMarketTypes?.length ||
    f.eventStartFrom ||
    f.eventStartTo ||
    f.placedOnly,
  );

export function SubmitRunSheet() {
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState(
    () => `Run ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
  );
  const [algorithm, setAlgorithm] = React.useState<SearchAlgorithm>("ensemble");
  const [nTrials, setNTrials] = React.useState(2000);
  const [dataFilters, setDataFilters] = React.useState<DataFiltersJson>({});

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
      return res.json();
    },
    onSuccess: () => {
      toast.success("Run queued — sidecar will begin shortly");
      qc.invalidateQueries({ queryKey: ["optimizer", "runs"] });
      setOpen(false);
    },
    onError: (err: Error) => toast.error(`Failed to queue run: ${err.message}`),
  });

  const handleSubmit = () => {
    submit.mutate({
      name,
      searchAlgorithm: algorithm,
      nTrialsTarget: nTrials,
      dataFilters: hasFilters(dataFilters) ? dataFilters : undefined,
    });
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button size="sm" className="gap-1.5">
          <Plus className="size-3.5" /> New run
        </Button>
      </SheetTrigger>
      <SheetContent className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            Submit a new optimization run
          </SheetTitle>
          <SheetDescription className="text-xs">
            The optimizer will sweep configurations of filters + sizing rules
            against your historical bets to find the highest, most consistent
            ROI. Defaults are sensible — click Start to begin.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5 px-4 py-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-8 text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground inline-flex items-center gap-1.5">
              <TermTooltip term="search_space">Search algorithm</TermTooltip>
            </label>
            <Select
              value={algorithm}
              onValueChange={(v) => setAlgorithm(v as SearchAlgorithm)}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALGOS.map((a) => (
                  <SelectItem key={a.value} value={a.value} className="text-xs">
                    <div className="flex flex-col">
                      <span>{a.label}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {a.help}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-foreground inline-flex items-center gap-1.5">
                <TermTooltip term="trial">Number of trials</TermTooltip>
              </label>
              <span className="text-xs tabular-nums text-muted-foreground">
                {nTrials.toLocaleString()}
              </span>
            </div>
            <Slider
              min={100}
              max={10000}
              step={100}
              value={[nTrials]}
              onValueChange={(v) => setNTrials(v[0])}
            />
            <p className="text-[10px] text-muted-foreground">
              More trials = better coverage of the search space, but takes
              longer. 2,000 is a good default for ~1k bets.
            </p>
          </div>

          <DataFiltersSection value={dataFilters} onChange={setDataFilters} />

          <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">Defaults applied</p>
            <ul className="list-disc list-inside space-y-0.5">
              <li>
                <TermTooltip term="cpcv">CPCV</TermTooltip> with 10 groups, 2
                test groups, 1% embargo (≈45 OOS paths)
              </li>
              <li>
                Random RNG seed (run is reproducible — seed saved with row)
              </li>
              <li>11-dimension search space (EV, Kelly, odds range, etc.)</li>
            </ul>
          </div>
        </div>

        <SheetFooter>
          <Button
            onClick={handleSubmit}
            disabled={submit.isPending || !name.trim()}
            className="w-full"
          >
            {submit.isPending ? "Queueing…" : "Start run"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
