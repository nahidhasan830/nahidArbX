"use client";

/**
 * Create-new-schedule sheet. Reuses DataFiltersSection so a schedule's data
 * scope works exactly the same as a one-off run.
 *
 * Phase 2 v1 — preset frequency picker only (no free-form cron). Covers
 * "every N hours" / "daily HH:00" / "weekly day HH:00".
 */

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
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
import { FrequencyPicker } from "./FrequencyPicker";
import type { Frequency } from "@/lib/optimizer/schedules";
import type { DataFiltersJson, SearchAlgorithm } from "@/lib/optimizer/types";

interface CreatePayload {
  name: string;
  description?: string;
  timezone: string;
  frequency: Frequency;
  nTrialsTarget: number;
  searchAlgorithm: SearchAlgorithm;
  dataFilters?: DataFiltersJson;
}

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

export function CreateScheduleSheet() {
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("Daily 3am sweep");
  const [timezone] = React.useState("Asia/Dhaka");
  const [frequency, setFrequency] = React.useState<Frequency>({
    kind: "daily",
    hourLocal: 3,
  });
  const [nTrials, setNTrials] = React.useState(2000);
  const [dataFilters, setDataFilters] = React.useState<DataFiltersJson>({});

  const submit = useMutation({
    mutationFn: async (p: CreatePayload) => {
      const res = await fetch("/api/optimizer/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("Schedule created");
      qc.invalidateQueries({ queryKey: ["optimizer", "schedules"] });
      setOpen(false);
    },
    onError: (err: Error) =>
      toast.error(`Failed to create schedule: ${err.message}`),
  });

  const handleSubmit = () => {
    submit.mutate({
      name,
      timezone,
      frequency,
      nTrialsTarget: nTrials,
      searchAlgorithm: "ensemble",
      dataFilters: hasFilters(dataFilters) ? dataFilters : undefined,
    });
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5">
          <Plus className="size-3.5" /> New schedule
        </Button>
      </SheetTrigger>
      <SheetContent className="sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <CalendarClock className="size-4 text-primary" />
            Schedule a recurring optimization run
          </SheetTitle>
          <SheetDescription className="text-xs">
            Same configuration as a one-off run, but fires on a recurring
            cadence. Useful for daily drift checks on the latest data.
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
              <TermTooltip term="schedule_frequency">Frequency</TermTooltip>
            </label>
            <FrequencyPicker
              value={frequency}
              onChange={setFrequency}
              timezone={timezone}
            />
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
          </div>

          <DataFiltersSection value={dataFilters} onChange={setDataFilters} />
        </div>

        <SheetFooter>
          <Button
            onClick={handleSubmit}
            disabled={submit.isPending || !name.trim()}
            className="w-full"
          >
            {submit.isPending ? "Saving…" : "Create schedule"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
