"use client";

/**
 * Create-new-schedule wizard. Shares the stepper chrome with `SubmitRunSheet`
 * (see `components/lab/optimisation/wizard/index.tsx`) so the "configure →
 * confirm → launch" flow looks identical whether the user is running a
 * one-off run or wiring up a recurring schedule.
 *
 * Three steps — Basics (name + frequency + trials), Data scope, Review.
 * Validation strategy is not exposed here: schedules always run with CPCV
 * (the default) since they're meant for unattended operation.
 */

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  BellOff,
  CalendarClock,
  CheckCircle2,
  Database,
  Plus,
  Settings2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { cn } from "@/lib/utils";
import { TermTooltip } from "@/components/ui/TermTooltip";
import { DataFiltersSection } from "./DataFiltersSection";
import { FrequencyPicker } from "./FrequencyPicker";
import {
  StepFooter,
  StepHeader,
  StepperRail,
  SummaryLine,
  type WizardStep,
} from "./wizard";
import { ALGOS, AlgorithmPicker } from "./wizard/algorithm-picker";
import {
  describeFrequency,
  type Frequency,
} from "@/lib/optimizer/schedule-types";
import type { DataFiltersJson, SearchAlgorithm } from "@/lib/optimizer/types";

// ── Types + static config ────────────────────────────────────────────────

interface CreatePayload {
  name: string;
  description?: string;
  timezone: string;
  frequency: Frequency;
  nTrialsTarget: number;
  searchAlgorithm: SearchAlgorithm;
  dataFilters?: DataFiltersJson;
  notifyOnStart?: boolean;
  notifyOnComplete?: boolean;
}

type StepId = 1 | 2 | 3;

const STEPS: readonly WizardStep<StepId>[] = [
  {
    id: 1,
    label: "Basics",
    caption: "Name + frequency + trials",
    icon: Settings2,
    title: "Basics",
    subtitle:
      "Give the schedule a name and choose when (and how often) it should fire.",
  },
  {
    id: 2,
    label: "Data scope",
    caption: "Which bets each fired run sees",
    icon: Database,
    title: "Data scope",
    subtitle:
      "Narrow which historical bets each fired run analyses. Every fire re-queries the DB so filters apply to the latest data automatically.",
  },
  {
    id: 3,
    label: "Review",
    caption: "Summary + activate",
    icon: CheckCircle2,
    title: "Review & activate",
    subtitle:
      "Confirm the cadence + scope, toggle the Telegram ping, then create the schedule.",
  },
];

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

function summariseScope(f: DataFiltersJson): string {
  const parts: string[] = [];
  if (f.includeSoftProviders?.length)
    parts.push(`only ${f.includeSoftProviders.length} providers`);
  else if (f.excludeSoftProviders?.length)
    parts.push(`−${f.excludeSoftProviders.length} providers`);
  if (f.excludeMarketTypes?.length)
    parts.push(`−${f.excludeMarketTypes.length} markets`);
  if (f.includeMarketTypes?.length)
    parts.push(`only ${f.includeMarketTypes.length} markets`);
  if (f.eventStartFrom) parts.push(`from ${f.eventStartFrom.slice(0, 10)}`);
  if (f.eventStartTo) parts.push(`to ${f.eventStartTo.slice(0, 10)}`);
  if (f.placedOnly) parts.push("placed only");
  return parts.length === 0 ? "All settled bets" : parts.join(" · ");
}

// ── Top-level wizard ─────────────────────────────────────────────────────

export function CreateScheduleSheet() {
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [step, setStep] = React.useState<StepId>(1);

  const [name, setName] = React.useState("Daily 3am sweep");
  const [timezone] = React.useState("Asia/Dhaka");
  const [frequency, setFrequency] = React.useState<Frequency>({
    kind: "daily",
    hourLocal: 3,
  });
  const [nTrials, setNTrials] = React.useState(2000);
  const [algorithm, setAlgorithm] = React.useState<SearchAlgorithm>("ensemble");
  const [dataFilters, setDataFilters] = React.useState<DataFiltersJson>({});
  const [notifyOnStart, setNotifyOnStart] = React.useState(true);
  const [notifyOnComplete, setNotifyOnComplete] = React.useState(true);

  React.useEffect(() => {
    if (open) setStep(1);
  }, [open]);

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
      searchAlgorithm: algorithm,
      dataFilters: hasFilters(dataFilters) ? dataFilters : undefined,
      notifyOnStart,
      notifyOnComplete,
    });
  };

  const back = () => {
    if (step > 1) setStep(((step as number) - 1) as StepId);
  };
  const next = () => {
    if ((step as number) < STEPS.length)
      setStep(((step as number) + 1) as StepId);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5 h-7 text-[11px]">
          <Plus className="size-3.5" /> New schedule
        </Button>
      </DialogTrigger>
      <DialogContent
        className={cn(
          "p-0 gap-0 overflow-hidden",
          "w-[min(1080px,95vw)] max-w-[1080px] h-[min(720px,92vh)]",
          "grid grid-cols-[300px_1fr]",
        )}
      >
        <VisuallyHidden.Root>
          <DialogTitle>Schedule a recurring optimization run</DialogTitle>
          <DialogDescription>
            Configure cadence + data scope, then activate the schedule.
          </DialogDescription>
        </VisuallyHidden.Root>

        <StepperRail
          title="New schedule"
          titleIcon={CalendarClock}
          steps={STEPS}
          current={step}
          onJump={setStep}
        >
          <SummaryLine label="Name" value={name} />
          <SummaryLine
            label="When"
            value={describeFrequency(frequency, timezone)}
          />
          <SummaryLine label="Trials" value={nTrials.toLocaleString()} mono />
          <SummaryLine
            label="Algorithm"
            value={ALGOS.find((a) => a.value === algorithm)?.label ?? algorithm}
          />
          <SummaryLine label="Data scope" value={summariseScope(dataFilters)} />
          <SummaryLine
            label="Notify"
            value={
              <NotifySummaryValue
                onStart={notifyOnStart}
                onComplete={notifyOnComplete}
              />
            }
          />
        </StepperRail>

        <div className="flex flex-col min-w-0 overflow-hidden">
          <StepHeader step={step} steps={STEPS} />

          <div className="flex-1 overflow-y-auto px-7 py-5 min-h-0">
            {step === 1 && (
              <StepBasics
                name={name}
                setName={setName}
                frequency={frequency}
                setFrequency={setFrequency}
                timezone={timezone}
                nTrials={nTrials}
                setNTrials={setNTrials}
                algorithm={algorithm}
                setAlgorithm={setAlgorithm}
              />
            )}
            {step === 2 && (
              <DataFiltersSection
                value={dataFilters}
                onChange={setDataFilters}
              />
            )}
            {step === 3 && (
              <StepReview
                name={name}
                setName={setName}
                frequency={frequency}
                timezone={timezone}
                nTrials={nTrials}
                algorithm={algorithm}
                notifyOnStart={notifyOnStart}
                setNotifyOnStart={setNotifyOnStart}
                notifyOnComplete={notifyOnComplete}
                setNotifyOnComplete={setNotifyOnComplete}
              />
            )}
          </div>

          <StepFooter
            step={step}
            steps={STEPS}
            onBack={back}
            onNext={next}
            onSubmit={handleSubmit}
            canSubmit={!submit.isPending && Boolean(name.trim())}
            pending={submit.isPending}
            submitLabel="Create schedule"
            pendingLabel="Saving…"
            submitIcon={CalendarClock}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Step 1 — Basics (name + frequency + trials) ──────────────────────────

function StepBasics({
  name,
  setName,
  frequency,
  setFrequency,
  timezone,
  nTrials,
  setNTrials,
  algorithm,
  setAlgorithm,
}: {
  name: string;
  setName: (v: string) => void;
  frequency: Frequency;
  setFrequency: (f: Frequency) => void;
  timezone: string;
  nTrials: number;
  setNTrials: (v: number) => void;
  algorithm: SearchAlgorithm;
  setAlgorithm: (v: SearchAlgorithm) => void;
}) {
  return (
    <div className="space-y-5">
      <Field label="Schedule name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-10 text-sm"
          placeholder="e.g. Daily 3am sweep"
          autoFocus
        />
      </Field>

      <Field
        label={<TermTooltip term="schedule_frequency">Frequency</TermTooltip>}
      >
        <FrequencyPicker
          value={frequency}
          onChange={setFrequency}
          timezone={timezone}
        />
      </Field>

      <Field
        label={<TermTooltip term="search_space">Search algorithm</TermTooltip>}
      >
        <AlgorithmPicker value={algorithm} onChange={setAlgorithm} />
      </Field>

      <Field
        label={
          <TermTooltip term="trial">Number of trials per fire</TermTooltip>
        }
      >
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-muted-foreground">
              More trials test more strategies but each fire takes longer.
            </span>
            <span className="text-sm font-semibold tabular-nums">
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
      </Field>
    </div>
  );
}

// ── Step 3 — Review ──────────────────────────────────────────────────────

function StepReview({
  name,
  setName,
  frequency,
  timezone,
  nTrials,
  algorithm,
  notifyOnStart,
  setNotifyOnStart,
  notifyOnComplete,
  setNotifyOnComplete,
}: {
  name: string;
  setName: (v: string) => void;
  frequency: Frequency;
  timezone: string;
  nTrials: number;
  algorithm: SearchAlgorithm;
  notifyOnStart: boolean;
  setNotifyOnStart: (v: boolean) => void;
  notifyOnComplete: boolean;
  setNotifyOnComplete: (v: boolean) => void;
}) {
  const algoLabel =
    ALGOS.find((a) => a.value === algorithm)?.label ?? algorithm;
  return (
    <div className="space-y-5">
      <Field label="Schedule name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-9 text-sm"
        />
      </Field>

      <div className="rounded-lg border border-border/60 bg-card">
        <SummaryRow label="When">
          <span className="text-sm font-semibold">
            {describeFrequency(frequency, timezone)}
          </span>
        </SummaryRow>
        <SummaryRow label="Trials per fire">
          <span className="text-sm font-semibold tabular-nums">
            {nTrials.toLocaleString()}
          </span>
        </SummaryRow>
        <SummaryRow label="Algorithm">
          <span className="text-sm font-semibold">{algoLabel}</span>
        </SummaryRow>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">
            Telegram pings
          </div>
          <div className="text-[11px] text-muted-foreground">
            Each fired run respects these independently.
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <NotifyToggle
            label="On start"
            checked={notifyOnStart}
            onCheckedChange={setNotifyOnStart}
            description="Pings you when each scheduled run picks up — with the time estimate and how many bets are in scope so you know when to check back."
          />
          <NotifyToggle
            label="On complete"
            checked={notifyOnComplete}
            onCheckedChange={setNotifyOnComplete}
            description="Pings you when each run finishes (so you don't miss an overnight sweep) — with the winning strategy's ROI, smoothness, and biggest drawdown."
          />
        </div>
      </div>
    </div>
  );
}

function NotifyToggle({
  label,
  checked,
  onCheckedChange,
  description,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  description: string;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-2.5 cursor-pointer rounded-lg border p-3 transition-colors",
        checked
          ? "border-primary/50 bg-primary/5"
          : "border-border/60 bg-card hover:bg-muted/20",
      )}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(Boolean(v))}
        className="mt-0.5"
      />
      <div className="flex-1 space-y-0.5 min-w-0">
        <div className="inline-flex items-center gap-1.5 text-sm font-semibold">
          {checked ? (
            <Bell className="size-3.5 text-primary" />
          ) : (
            <BellOff className="size-3.5 text-muted-foreground" />
          )}
          {label}
        </div>
        <p className="text-[13px] text-muted-foreground leading-snug">
          {description}
        </p>
      </div>
    </label>
  );
}

function NotifySummaryValue({
  onStart,
  onComplete,
}: {
  onStart: boolean;
  onComplete: boolean;
}) {
  if (!onStart && !onComplete) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <BellOff className="size-3.5" /> Off
      </span>
    );
  }
  const parts: string[] = [];
  if (onStart) parts.push("Start");
  if (onComplete) parts.push("End");
  return (
    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
      <Bell className="size-3.5" /> {parts.join(" + ")}
    </span>
  );
}

// ── Small shared atoms ───────────────────────────────────────────────────

function Field({
  label,
  children,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-sm font-medium text-foreground inline-flex items-center gap-1.5">
        {label}
      </div>
      {children}
    </div>
  );
}

function SummaryRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border/60 last:border-b-0">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <div className="min-w-0 text-right">{children}</div>
    </div>
  );
}
