"use client";

/**
 * Submit-new-run wizard — split-pane 4-step dialog.
 *
 * Design intent: the dialog never resizes between steps. Fixed envelope
 * (`w-[920px] h-[620px]`), left rail (280px) that always shows the
 * vertical stepper + live "Current setup" summary, right pane with a
 * header → scrollable body → sticky footer. Switching steps swaps the
 * body content but keeps the chrome identical — no jumping, no reflow.
 *
 * Defaults-on-open so every field is filled the moment the dialog
 * renders; the user can jump straight to step 4 and press `Run now`.
 *
 * Every jargon term is a `TermTooltip` (lib/lab/glossary.ts).
 */

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  BellOff,
  CheckCircle2,
  Database,
  FlaskConical,
  Plus,
  Rocket,
  Settings2,
  Sparkles,
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
import { durationLabel } from "@/lib/formatting/helpers";
import { TermTooltip } from "@/components/ui/TermTooltip";
import { ProviderBadge } from "@/components/ui/ProviderBadge";
import type { TermId } from "@/lib/lab/glossary";
import { DataFiltersSection } from "./DataFiltersSection";
import {
  StepFooter,
  StepHeader as WizardStepHeader,
  StepperRail,
  SummaryLine,
  type WizardStep,
} from "./wizard";
import { ALGOS, AlgorithmPicker } from "./wizard/algorithm-picker";
import { formatMarketType } from "@/lib/formatting/labels";
import type {
  CreateRunRequest,
  DataFiltersJson,
  SearchAlgorithm,
} from "@/lib/optimizer/types";

// ── Defaults + static config ─────────────────────────────────────────────

const defaultRunName = () =>
  `Run ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;

// `ALGOS` + the compact picker UI now live in `./wizard/algorithm-picker`
// so `CreateScheduleSheet` uses the same vocabulary. Imported below as
// `AlgorithmPicker` + `ALGOS` (ALGOS is still needed for the review step's
// label lookup).

interface CvOpt {
  value: "cpcv" | "walkforward";
  label: string;
  tagline: string;
  help: string;
  term: TermId;
  recommended?: boolean;
}

const CV_OPTIONS: CvOpt[] = [
  {
    value: "cpcv",
    label: "CPCV",
    tagline: "Many tests on bets it has never seen",
    help: "Splits your bet history into 10 groups, hides 2 of them at a time for testing, trains on the other 8 — and repeats for every possible pair of hidden groups. That's 45 mini-exams per strategy, so a winner has to actually be good.",
    term: "cpcv",
    recommended: true,
  },
  {
    value: "walkforward",
    label: "Walk-forward",
    tagline: "Mimics real betting in time order",
    help: "Trains on older bets, tests on newer ones, then slides the window forward in time. Six tests instead of 45 — but every one mimics 'you've never seen the future', exactly like real live betting.",
    term: "walkforward",
  },
];

type StepId = 1 | 2 | 3 | 4;

const STEPS: readonly WizardStep<StepId>[] = [
  {
    id: 1,
    label: "Basics",
    caption: "Name + search method",
    icon: Settings2,
    title: "Basics",
    subtitle:
      "Name this run and pick how the optimiser searches through the menu of knobs.",
  },
  {
    id: 2,
    label: "Data scope",
    caption: "Which bets enter the analysis",
    icon: Database,
    title: "Data scope",
    subtitle:
      "Narrow which historical bets enter the analysis. Everything starts included — untick anything you don't want.",
  },
  {
    id: 3,
    label: "Validation",
    caption: "How we tell skill from luck",
    icon: FlaskConical,
    title: "Validation",
    subtitle:
      "How we test each strategy on bets it has never seen, so we can tell real skill from lucky guesses.",
  },
  {
    id: 4,
    label: "Review",
    caption: "Summary + launch",
    icon: CheckCircle2,
    title: "Review & run",
    subtitle:
      "Confirm the setup, toggle the Telegram ping, then press Run now.",
  },
] as const;

// ── Top-level wizard ─────────────────────────────────────────────────────

export function SubmitRunSheet() {
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [step, setStep] = React.useState<StepId>(1);

  // Form state (defaults on mount)
  const [name, setName] = React.useState<string>(defaultRunName);
  const [algorithm, setAlgorithm] = React.useState<SearchAlgorithm>("ensemble");
  const [nTrials, setNTrials] = React.useState(2000);
  const [dataFilters, setDataFilters] = React.useState<DataFiltersJson>({});
  const [cvType, setCvType] = React.useState<"cpcv" | "walkforward">("cpcv");
  const [notifyOnStart, setNotifyOnStart] = React.useState(true);
  const [notifyOnComplete, setNotifyOnComplete] = React.useState(true);

  // Re-stamp the name every time the dialog opens (unless the user has typed).
  const nameEditedRef = React.useRef(false);
  React.useEffect(() => {
    if (open) {
      setStep(1);
      if (!nameEditedRef.current) setName(defaultRunName());
    }
  }, [open]);

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
    onSuccess: (data: {
      run?: { id?: string };
      estimate?: {
        estimatedSec: number | null;
        basis: string;
        sampleSize: number;
      } | null;
    }) => {
      const est = data.estimate;
      if (est?.estimatedSec && est.estimatedSec > 0) {
        toast.success(
          `Run queued — ETA ~${durationLabel(est.estimatedSec * 1000)} (${est.basis})`,
        );
      } else {
        toast.success("Run queued — the optimiser will begin shortly");
      }
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
      cvStrategy: { type: cvType },
      notifyOnStart,
      notifyOnComplete,
    });
  };

  const next = () => {
    if (step < 4) setStep((step + 1) as StepId);
  };
  const back = () => {
    if (step > 1) setStep((step - 1) as StepId);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5 h-7 text-[11px]">
          <Plus className="size-3.5" /> New run…
        </Button>
      </DialogTrigger>
      <DialogContent
        className={cn(
          // Fixed envelope — identical dimensions on every step so the
          // modal never resizes or jumps when switching.
          "p-0 gap-0 overflow-hidden",
          "w-[min(1080px,95vw)] max-w-[1080px] h-[min(720px,92vh)]",
          "grid grid-cols-[300px_1fr]",
        )}
      >
        <VisuallyHidden.Root>
          <DialogTitle>Start a new optimizer run</DialogTitle>
          <DialogDescription>
            Configure basics, data scope, and validation, then launch the run.
          </DialogDescription>
        </VisuallyHidden.Root>

        <StepperRail
          title="New run"
          titleIcon={Sparkles}
          steps={STEPS}
          current={step}
          onJump={setStep}
        >
          <RunSetupSummary
            name={name}
            algorithm={algorithm}
            nTrials={nTrials}
            dataFilters={dataFilters}
            cvType={cvType}
            notifyOnStart={notifyOnStart}
            notifyOnComplete={notifyOnComplete}
          />
        </StepperRail>

        <div className="flex flex-col min-w-0 overflow-hidden">
          <WizardStepHeader step={step} steps={STEPS} />

          <div className="flex-1 overflow-y-auto px-7 py-5 min-h-0">
            {step === 1 && (
              <StepBasics
                name={name}
                setName={(v) => {
                  nameEditedRef.current = true;
                  setName(v);
                }}
                algorithm={algorithm}
                setAlgorithm={setAlgorithm}
                nTrials={nTrials}
                setNTrials={setNTrials}
              />
            )}
            {step === 2 && (
              <StepDataScope
                dataFilters={dataFilters}
                setDataFilters={setDataFilters}
              />
            )}
            {step === 3 && (
              <StepValidation cvType={cvType} setCvType={setCvType} />
            )}
            {step === 4 && (
              <StepReview
                name={name}
                setName={(v) => {
                  nameEditedRef.current = true;
                  setName(v);
                }}
                algorithm={algorithm}
                nTrials={nTrials}
                dataFilters={dataFilters}
                cvType={cvType}
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
            submitLabel="Run now"
            submitIcon={Rocket}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Left-rail summary block (the "Current setup" body) ───────────────────

function RunSetupSummary({
  name,
  algorithm,
  nTrials,
  dataFilters,
  cvType,
  notifyOnStart,
  notifyOnComplete,
}: {
  name: string;
  algorithm: SearchAlgorithm;
  nTrials: number;
  dataFilters: DataFiltersJson;
  cvType: "cpcv" | "walkforward";
  notifyOnStart: boolean;
  notifyOnComplete: boolean;
}) {
  const algo = ALGOS.find((a) => a.value === algorithm)!;
  const cv = CV_OPTIONS.find((c) => c.value === cvType)!;
  const scopeSummary = summariseScope(dataFilters);
  return (
    <>
      <SummaryLine label="Name" value={name} />
      <SummaryLine label="Algorithm" value={algo.label} />
      <SummaryLine label="Trials" value={nTrials.toLocaleString()} mono />
      <SummaryLine label="Validation" value={cv.label} />
      <SummaryLine label="Data scope" value={scopeSummary} />
      <SummaryLine
        label="Notify"
        value={
          <NotifySummaryValue
            onStart={notifyOnStart}
            onComplete={notifyOnComplete}
          />
        }
      />
    </>
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

// ── Step 1 — Basics ──────────────────────────────────────────────────────

function StepBasics({
  name,
  setName,
  algorithm,
  setAlgorithm,
  nTrials,
  setNTrials,
}: {
  name: string;
  setName: (v: string) => void;
  algorithm: SearchAlgorithm;
  setAlgorithm: (v: SearchAlgorithm) => void;
  nTrials: number;
  setNTrials: (v: number) => void;
}) {
  return (
    <div className="space-y-5">
      <Field label="Run name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-10 text-sm"
          placeholder="e.g. Weekly production sweep"
          autoFocus
        />
      </Field>

      <Field
        label={
          <span className="inline-flex items-center gap-1.5">
            <TermTooltip term="search_space">Search algorithm</TermTooltip>
          </span>
        }
      >
        <AlgorithmPicker value={algorithm} onChange={setAlgorithm} />
      </Field>

      <Field
        label={
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5">
              <TermTooltip term="trial">Number of trials</TermTooltip>
            </span>
            <span className="text-base font-semibold tabular-nums">
              {nTrials.toLocaleString()}
            </span>
          </div>
        }
      >
        <Slider
          min={100}
          max={10000}
          step={100}
          value={[nTrials]}
          onValueChange={(v) => setNTrials(v[0])}
          className="py-1"
        />
        <div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
          <span>100</span>
          <span className="text-emerald-600 dark:text-emerald-400 font-medium">
            2,000 recommended
          </span>
          <span>10,000</span>
        </div>
      </Field>

      <BasicsEtaHint nTrials={nTrials} algorithm={algorithm} />
    </div>
  );
}

function BasicsEtaHint({
  nTrials,
  algorithm,
}: {
  nTrials: number;
  algorithm: SearchAlgorithm;
}) {
  const etaQ = useQuery({
    queryKey: ["optimizer", "estimate", nTrials, "cpcv", algorithm],
    queryFn: async () => {
      const res = await fetch(
        `/api/optimizer/runs/estimate?nTrials=${nTrials}&cvStrategy=cpcv&searchAlgorithm=${algorithm}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as {
        estimatedSec: number | null;
        basis: string;
        sampleSize: number;
      };
    },
    staleTime: 30_000,
  });
  const sec = etaQ.data?.estimatedSec;
  const basis = etaQ.data?.basis ?? "";
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 px-3.5 py-3 grid grid-cols-3 gap-3">
      <div>
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
          Estimated runtime
        </div>
        <div className="text-sm font-semibold tabular-nums mt-0.5">
          {sec && sec > 0 ? `~${durationLabel(sec * 1000)}` : "—"}
        </div>
        <div className="text-[11px] text-muted-foreground leading-snug mt-0.5 line-clamp-1">
          {basis || "No prior runs to benchmark"}
        </div>
      </div>
      <div>
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
          Configurations tested
        </div>
        <div className="text-sm font-semibold tabular-nums mt-0.5">
          {nTrials.toLocaleString()}
        </div>
        <div className="text-[11px] text-muted-foreground leading-snug mt-0.5">
          How many different strategy recipes the run will test.
        </div>
      </div>
      <div>
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
          Sampler
        </div>
        <div className="text-sm font-semibold mt-0.5">
          {ALGOS.find((a) => a.value === algorithm)?.label ?? algorithm}
        </div>
        <div className="text-[11px] text-muted-foreground leading-snug mt-0.5 line-clamp-1">
          {ALGOS.find((a) => a.value === algorithm)?.tagline ?? ""}
        </div>
      </div>
    </div>
  );
}

// ── Step 2 — Data scope ──────────────────────────────────────────────────

function StepDataScope({
  dataFilters,
  setDataFilters,
}: {
  dataFilters: DataFiltersJson;
  setDataFilters: (v: DataFiltersJson) => void;
}) {
  return (
    <div className="space-y-4">
      <DataFiltersSection value={dataFilters} onChange={setDataFilters} />
    </div>
  );
}

// ── Step 3 — Validation ──────────────────────────────────────────────────

function StepValidation({
  cvType,
  setCvType,
}: {
  cvType: "cpcv" | "walkforward";
  setCvType: (v: "cpcv" | "walkforward") => void;
}) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        {CV_OPTIONS.map((cv) => (
          <ChoiceCard
            key={cv.value}
            selected={cvType === cv.value}
            onSelect={() => setCvType(cv.value)}
            label={cv.label}
            tagline={cv.tagline}
            help={cv.help}
            term={cv.term}
            recommended={cv.recommended}
            large
          />
        ))}
      </div>

      <CvComparisonTable cvType={cvType} />

      <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-2">
        <div className="inline-flex items-center gap-1.5 text-sm font-semibold">
          <span className="text-primary">Why this step exists</span>
        </div>
        <p className="text-[13px] text-muted-foreground leading-relaxed">
          A strategy that looks great on the bets it was tuned on but flops on
          fresh ones is just memorising your history, not finding a real edge.
          The only way to tell the difference is to score every strategy on bets
          it was never trained on. CPCV does that 45 different ways — tight,
          trustworthy numbers. Walk-forward does it just 6 ways but always in
          real time order, exactly like live betting. Most runs should use CPCV;
          pick walk-forward when you want a real-time deployment dress
          rehearsal.
        </p>
      </div>
    </div>
  );
}

function CvComparisonTable({ cvType }: { cvType: "cpcv" | "walkforward" }) {
  const rows: Array<{
    label: string;
    cpcv: string;
    wf: string;
  }> = [
    {
      label: "How many tests per strategy",
      cpcv: "About 45",
      wf: "6",
    },
    {
      label: "How often each bet is used in testing",
      cpcv: "9 or more times",
      wf: "Once",
    },
    {
      label: "How tight the believable range is",
      cpcv: "Tight — many tests",
      wf: "Wider — fewer tests",
    },
    {
      label: "Matches real live betting",
      cpcv: "Close, but not exact",
      wf: "Yes — strict past → future",
    },
    {
      label: "How long it takes to run",
      cpcv: "About twice as long",
      wf: "Faster baseline",
    },
  ];
  return (
    <div className="rounded-lg border border-border/60 bg-card overflow-hidden">
      <div className="grid grid-cols-[1fr_1fr_1fr] text-[11px] uppercase tracking-wide text-muted-foreground font-medium border-b border-border/60 bg-muted/30">
        <div className="px-3 py-2">Aspect</div>
        <div
          className={cn(
            "px-3 py-2 border-l border-border/60",
            cvType === "cpcv" && "bg-primary/10 text-primary",
          )}
        >
          CPCV
        </div>
        <div
          className={cn(
            "px-3 py-2 border-l border-border/60",
            cvType === "walkforward" && "bg-primary/10 text-primary",
          )}
        >
          Walk-forward
        </div>
      </div>
      {rows.map((r) => (
        <div
          key={r.label}
          className="grid grid-cols-[1fr_1fr_1fr] text-[13px] border-b border-border/60 last:border-b-0"
        >
          <div className="px-3 py-2 text-muted-foreground">{r.label}</div>
          <div
            className={cn(
              "px-3 py-2 border-l border-border/60",
              cvType === "cpcv" && "bg-primary/5 font-medium text-foreground",
            )}
          >
            {r.cpcv}
          </div>
          <div
            className={cn(
              "px-3 py-2 border-l border-border/60",
              cvType === "walkforward" &&
                "bg-primary/5 font-medium text-foreground",
            )}
          >
            {r.wf}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Step 4 — Review ──────────────────────────────────────────────────────

function StepReview({
  name,
  setName,
  algorithm,
  nTrials,
  dataFilters,
  cvType,
  notifyOnStart,
  setNotifyOnStart,
  notifyOnComplete,
  setNotifyOnComplete,
}: {
  name: string;
  setName: (v: string) => void;
  algorithm: SearchAlgorithm;
  nTrials: number;
  dataFilters: DataFiltersJson;
  cvType: "cpcv" | "walkforward";
  notifyOnStart: boolean;
  setNotifyOnStart: (v: boolean) => void;
  notifyOnComplete: boolean;
  setNotifyOnComplete: (v: boolean) => void;
}) {
  const algo = ALGOS.find((a) => a.value === algorithm)!;
  const cv = CV_OPTIONS.find((c) => c.value === cvType)!;

  // Live ETA based on the current config — queries historical durations
  // with a small debounce via React Query's built-in staleTime.
  const etaQ = useQuery({
    queryKey: ["optimizer", "estimate", nTrials, cvType, algorithm],
    queryFn: async () => {
      const res = await fetch(
        `/api/optimizer/runs/estimate?nTrials=${nTrials}&cvStrategy=${cvType}&searchAlgorithm=${algorithm}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as {
        estimatedSec: number | null;
        basis: string;
        sampleSize: number;
      };
    },
    staleTime: 30_000,
  });

  return (
    <div className="space-y-5">
      <Field label="Run name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-9 text-sm"
        />
      </Field>

      {etaQ.data?.estimatedSec != null && etaQ.data.estimatedSec > 0 && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 px-3.5 py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-primary">⏱</span>
            <div className="min-w-0">
              <div className="text-sm font-semibold">
                Estimated ~{durationLabel(etaQ.data.estimatedSec * 1000)}
              </div>
              <div className="text-[13px] text-muted-foreground leading-snug">
                {etaQ.data.basis}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border/60 bg-card">
        <SummaryRow label="Algorithm">
          <div className="flex items-center gap-2 justify-end">
            <span className="text-sm font-semibold">{algo.label}</span>
            <span className="text-[11px] text-muted-foreground">
              {algo.tagline}
            </span>
          </div>
        </SummaryRow>
        <SummaryRow label="Trials">
          <span className="text-sm font-semibold tabular-nums">
            {nTrials.toLocaleString()}
          </span>
        </SummaryRow>
        <SummaryRow label="Validation">
          <div className="flex items-center gap-2 justify-end">
            <span className="text-sm font-semibold">{cv.label}</span>
            <span className="text-[11px] text-muted-foreground">
              {cv.tagline}
            </span>
          </div>
        </SummaryRow>
        <SummaryRow label="Data scope">
          <ScopeReview filters={dataFilters} />
        </SummaryRow>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">
            Telegram pings
          </div>
          <div className="text-[11px] text-muted-foreground">
            Pick either, both, or neither.
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <NotifyToggle
            label="On start"
            checked={notifyOnStart}
            onCheckedChange={setNotifyOnStart}
            description="Pings you the moment the run picks up — includes the time estimate and how many bets are in scope, so you know when to check back."
          />
          <NotifyToggle
            label="On complete"
            checked={notifyOnComplete}
            onCheckedChange={setNotifyOnComplete}
            description="Pings you when the run finishes — with the winning strategy's ROI, smoothness, biggest drawdown, and how many trade-off options were found."
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

function ScopeReview({ filters }: { filters: DataFiltersJson }) {
  const incProviders = filters.includeSoftProviders;
  const exMarkets = filters.excludeMarketTypes ?? [];
  const hasAny =
    (incProviders && incProviders.length > 0) ||
    exMarkets.length > 0 ||
    filters.eventStartFrom ||
    filters.eventStartTo ||
    filters.placedOnly;

  if (!hasAny) {
    return (
      <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
        All settled bets
      </span>
    );
  }

  return (
    <div className="flex flex-wrap gap-1.5 justify-end">
      {incProviders && incProviders.length > 0 && (
        <PlainChip>{incProviders.length} providers</PlainChip>
      )}
      {exMarkets.map((m) => (
        <ExcludedChip key={`em-${m}`}>{formatMarketType(m)}</ExcludedChip>
      ))}
      {filters.eventStartFrom && (
        <PlainChip>From {filters.eventStartFrom.slice(0, 10)}</PlainChip>
      )}
      {filters.eventStartTo && (
        <PlainChip>To {filters.eventStartTo.slice(0, 10)}</PlainChip>
      )}
      {filters.placedOnly && <PlainChip>Placed only</PlainChip>}
    </div>
  );
}

// ── Shared primitives ────────────────────────────────────────────────────

function Field({
  label,
  children,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2.5">
      <div className="text-sm font-semibold text-foreground">{label}</div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

/**
 * Larger selectable card for the 2-card CV picker where there's space
 * for a full help blurb inline.
 */
function ChoiceCard({
  selected,
  onSelect,
  label,
  tagline,
  help,
  term,
  recommended,
  large = false,
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
  tagline: string;
  help: string;
  term: TermId;
  recommended?: boolean;
  large?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "relative text-left rounded-lg border transition-all p-4 flex flex-col gap-2 group",
        large && "p-5 gap-2.5",
        selected
          ? "border-primary bg-primary/5 shadow-sm"
          : "border-border bg-card hover:border-foreground/30 hover:bg-muted/30",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-base">{label}</span>
            {recommended && (
              <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
                Recommended
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">{tagline}</p>
        </div>
        <span
          aria-hidden
          className={cn(
            "shrink-0 mt-0.5 size-5 rounded-full border-2 flex items-center justify-center transition-colors",
            selected
              ? "border-primary bg-primary"
              : "border-muted-foreground/40 group-hover:border-foreground/60",
          )}
        >
          {selected && (
            <span className="size-2 rounded-full bg-primary-foreground" />
          )}
        </span>
      </div>
      <p className="text-[13px] text-muted-foreground leading-relaxed">
        {help} <TermTooltip term={term} iconOnly />
      </p>
    </button>
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
    <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border/60 last:border-b-0 min-h-[52px]">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
        {label}
      </span>
      <div className="text-right max-w-[70%]">{children}</div>
    </div>
  );
}

function ExcludedChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/5 px-2 py-0.5 text-[11px] text-red-600 dark:text-red-400">
      <span>−</span>
      {children}
    </span>
  );
}

function PlainChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] text-foreground/80">
      {children}
    </span>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

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
