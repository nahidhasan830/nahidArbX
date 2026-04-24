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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  BellOff,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
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
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { TermTooltip } from "@/components/ui/TermTooltip";
import { ProviderBadge } from "@/components/ui/ProviderBadge";
import type { TermId } from "@/lib/lab/glossary";
import { DataFiltersSection } from "./DataFiltersSection";
import { formatMarketType } from "@/lib/formatting/labels";
import type {
  CreateRunRequest,
  DataFiltersJson,
  SearchAlgorithm,
} from "@/lib/optimizer/types";

// ── Defaults + static config ─────────────────────────────────────────────

const defaultRunName = () =>
  `Run ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;

interface AlgoOpt {
  value: SearchAlgorithm;
  label: string;
  tagline: string;
  help: string;
  term: TermId;
  recommended?: boolean;
}

const ALGOS: AlgoOpt[] = [
  {
    value: "ensemble",
    label: "Ensemble",
    tagline: "Random + TPE together",
    help: "Random gives unbiased coverage, TPE refines — the best-of-both default for most runs.",
    term: "ensemble",
    recommended: true,
  },
  {
    value: "tpe",
    label: "TPE · Bayesian",
    tagline: "Smart, learns from previous trials",
    help: "Bayesian sampler that learns where good configs cluster. Converges 5-10× faster than random in high-dim spaces.",
    term: "tpe",
  },
  {
    value: "random",
    label: "Random",
    tagline: "Unbiased baseline coverage",
    help: "Samples uniformly from the search space. Provably better than grid search above 5 dimensions.",
    term: "random_search",
  },
  {
    value: "nsga2",
    label: "NSGA-II",
    tagline: "Multi-objective genetic",
    help: "Returns the Pareto frontier directly. Best when ROI vs. drawdown trade-offs matter. Slower.",
    term: "nsga2",
  },
  {
    value: "ml-xgboost",
    label: "ML · XGBoost",
    tagline: "Gradient-boosted classifier",
    help: "Trains a calibrated XGBoost model per CV fold and bets when its probability exceeds a threshold. Same CPCV harness.",
    term: "ml_xgboost",
  },
];

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
    tagline: "~45 OOS paths, tighter CIs",
    help: "Combinatorial Purged Cross-Validation with 10 groups, 2 test, 1% embargo. Squeezes more OOS signal from the same data.",
    term: "cpcv",
    recommended: true,
  },
  {
    value: "walkforward",
    label: "Walk-forward",
    tagline: "Closer to live trading",
    help: "6 anchored forward-marching folds. Fewer OOS paths but matches how a strategy would actually be deployed in time.",
    term: "walkforward",
  },
];

const STEPS = [
  {
    id: 1,
    label: "Basics",
    caption: "Name + search algorithm",
    icon: Settings2,
  },
  {
    id: 2,
    label: "Data scope",
    caption: "Which bets enter the analysis",
    icon: Database,
  },
  {
    id: 3,
    label: "Validation",
    caption: "How we test for luck vs. skill",
    icon: FlaskConical,
  },
  {
    id: 4,
    label: "Review",
    caption: "Summary + launch",
    icon: CheckCircle2,
  },
] as const;

type StepId = (typeof STEPS)[number]["id"];

const STEP_TITLE: Record<StepId, string> = {
  1: "Basics",
  2: "Data scope",
  3: "Cross-validation",
  4: "Review & run",
};

const STEP_SUBTITLE: Record<StepId, string> = {
  1: "Name the run and decide how the optimizer explores the configuration space.",
  2: "Narrow which historical bets enter the analysis. Everything starts included — untick anything you don't want.",
  3: "How we split your historical bets into train/test windows to separate skill from luck.",
  4: "Confirm the setup, toggle the Telegram ping, then press Run now.",
};

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
      cvStrategy: { type: cvType },
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
          "w-[min(960px,95vw)] max-w-[960px] h-[min(640px,90vh)]",
          "grid grid-cols-[280px_1fr]",
        )}
      >
        <LeftRail
          step={step}
          onJump={setStep}
          name={name}
          algorithm={algorithm}
          nTrials={nTrials}
          dataFilters={dataFilters}
          cvType={cvType}
          notifyOnComplete={notifyOnComplete}
        />

        <div className="flex flex-col min-w-0 overflow-hidden">
          <StepHeader step={step} />

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
                notifyOnComplete={notifyOnComplete}
                setNotifyOnComplete={setNotifyOnComplete}
              />
            )}
          </div>

          <Footer
            step={step}
            onBack={back}
            onNext={next}
            onSubmit={handleSubmit}
            canSubmit={!submit.isPending && Boolean(name.trim())}
            pending={submit.isPending}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Left rail — vertical stepper + live summary ──────────────────────────

function LeftRail({
  step,
  onJump,
  name,
  algorithm,
  nTrials,
  dataFilters,
  cvType,
  notifyOnComplete,
}: {
  step: StepId;
  onJump: (s: StepId) => void;
  name: string;
  algorithm: SearchAlgorithm;
  nTrials: number;
  dataFilters: DataFiltersJson;
  cvType: "cpcv" | "walkforward";
  notifyOnComplete: boolean;
}) {
  const algo = ALGOS.find((a) => a.value === algorithm)!;
  const cv = CV_OPTIONS.find((c) => c.value === cvType)!;
  const scopeSummary = summariseScope(dataFilters);

  return (
    <aside className="border-r border-border/60 bg-muted/30 flex flex-col min-h-0">
      <div className="px-5 pt-5 pb-4 border-b border-border/60 flex items-center gap-2">
        <Sparkles className="size-4 text-primary" aria-hidden />
        <span className="text-sm font-semibold">New run</span>
      </div>

      <ol className="flex flex-col gap-1 p-3">
        {STEPS.map((s) => {
          const active = step === s.id;
          const completed = step > s.id;
          const Icon = s.icon;
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onJump(s.id)}
                className={cn(
                  "w-full flex items-start gap-3 text-left rounded-md px-2.5 py-2 transition-colors",
                  active && "bg-background shadow-sm",
                  !active && "hover:bg-background/60",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 inline-flex items-center justify-center size-6 rounded-full text-[11px] font-semibold border shrink-0 transition-colors",
                    active &&
                      "bg-primary text-primary-foreground border-primary",
                    completed && "bg-emerald-500 text-white border-emerald-500",
                    !active &&
                      !completed &&
                      "bg-background text-muted-foreground border-border",
                  )}
                >
                  {completed ? (
                    <Check className="size-3.5" />
                  ) : (
                    <Icon className="size-3.5" />
                  )}
                </span>
                <span className="flex-1 min-w-0">
                  <span
                    className={cn(
                      "block text-xs font-semibold leading-tight",
                      active ? "text-foreground" : "text-foreground/90",
                    )}
                  >
                    {s.id}. {s.label}
                  </span>
                  <span className="block text-[10px] text-muted-foreground leading-snug mt-0.5">
                    {s.caption}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="border-t border-border/60 mx-3" />

      <div className="flex-1 overflow-y-auto p-4 space-y-2.5 min-h-0">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Current setup
        </p>
        <SummaryLine label="Name" value={name} />
        <SummaryLine label="Algorithm" value={algo.label} />
        <SummaryLine label="Trials" value={nTrials.toLocaleString()} mono />
        <SummaryLine label="Validation" value={cv.label} />
        <SummaryLine label="Data scope" value={scopeSummary} />
        <SummaryLine
          label="Notify"
          value={
            notifyOnComplete ? (
              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <Bell className="size-3" /> On
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <BellOff className="size-3" /> Off
              </span>
            )
          }
        />
      </div>
    </aside>
  );
}

function SummaryLine({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="text-[10px] text-muted-foreground shrink-0 w-[60px] pt-0.5">
        {label}
      </span>
      <span
        className={cn(
          "text-[11px] font-medium text-right flex-1 min-w-0 break-words",
          mono && "tabular-nums",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function summariseScope(f: DataFiltersJson): string {
  const parts: string[] = [];
  if (f.excludeSoftProviders?.length)
    parts.push(`−${f.excludeSoftProviders.length} providers`);
  if (f.includeSoftProviders?.length)
    parts.push(`only ${f.includeSoftProviders.length} providers`);
  if (f.excludeMarketTypes?.length)
    parts.push(`−${f.excludeMarketTypes.length} markets`);
  if (f.includeMarketTypes?.length)
    parts.push(`only ${f.includeMarketTypes.length} markets`);
  if (f.eventStartFrom) parts.push(`from ${f.eventStartFrom.slice(0, 10)}`);
  if (f.eventStartTo) parts.push(`to ${f.eventStartTo.slice(0, 10)}`);
  if (f.placedOnly) parts.push("placed only");
  return parts.length === 0 ? "All settled bets" : parts.join(" · ");
}

// ── Right pane header ────────────────────────────────────────────────────

function StepHeader({ step }: { step: StepId }) {
  return (
    <header className="px-7 pt-5 pb-4 border-b border-border/60 shrink-0">
      <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
        Step {step} of {STEPS.length}
      </div>
      <h2 className="text-lg font-semibold leading-tight mt-0.5">
        {STEP_TITLE[step]}
      </h2>
      <p className="text-xs text-muted-foreground leading-relaxed mt-1 max-w-[580px]">
        {STEP_SUBTITLE[step]}
      </p>
    </header>
  );
}

// ── Right pane footer ────────────────────────────────────────────────────

function Footer({
  step,
  onBack,
  onNext,
  onSubmit,
  canSubmit,
  pending,
}: {
  step: StepId;
  onBack: () => void;
  onNext: () => void;
  onSubmit: () => void;
  canSubmit: boolean;
  pending: boolean;
}) {
  const atEnd = step === STEPS.length;
  return (
    <footer className="px-7 py-3.5 border-t border-border/60 flex items-center justify-between gap-3 bg-muted/20 shrink-0">
      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
        disabled={step === 1}
        className="gap-1.5 h-8"
      >
        <ChevronLeft className="size-3.5" /> Back
      </Button>

      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        {STEPS.map((s) => (
          <span
            key={s.id}
            aria-hidden
            className={cn(
              "h-1 rounded-full transition-all",
              step === s.id && "w-6 bg-primary",
              step > s.id && "w-4 bg-emerald-500",
              step < s.id && "w-4 bg-muted-foreground/30",
            )}
          />
        ))}
      </div>

      {atEnd ? (
        <Button
          size="sm"
          onClick={onSubmit}
          disabled={!canSubmit}
          className="gap-1.5 h-8"
        >
          <Rocket className="size-3.5" />
          {pending ? "Queueing…" : "Run now"}
        </Button>
      ) : (
        <Button size="sm" onClick={onNext} className="gap-1.5 h-8">
          Next <ChevronRight className="size-3.5" />
        </Button>
      )}
    </footer>
  );
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
    <div className="space-y-6">
      <Field label="Run name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-9 text-sm"
          placeholder="e.g. Weekly production sweep"
          autoFocus
        />
        <FieldHint>
          Shown in the runs list and in Telegram notifications — pick something
          you&apos;ll recognise later.
        </FieldHint>
      </Field>

      <Field
        label={
          <span className="inline-flex items-center gap-1.5">
            <TermTooltip term="search_space">Search algorithm</TermTooltip>
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-2">
          {ALGOS.map((a) => (
            <ChoiceCard
              key={a.value}
              selected={algorithm === a.value}
              onSelect={() => setAlgorithm(a.value)}
              label={a.label}
              tagline={a.tagline}
              help={a.help}
              term={a.term}
              recommended={a.recommended}
            />
          ))}
        </div>
      </Field>

      <Field
        label={
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5">
              <TermTooltip term="trial">Number of trials</TermTooltip>
            </span>
            <span className="text-sm font-semibold tabular-nums">
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
        />
        <div className="flex items-center justify-between text-[11px] text-muted-foreground tabular-nums">
          <span>100</span>
          <span>2,000 (recommended)</span>
          <span>10,000</span>
        </div>
        <FieldHint>
          More trials = better coverage, longer runtime. 2,000 is the empirical
          sweet spot for ~1,000 historical bets.
        </FieldHint>
      </Field>
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

      <div className="text-[11px] text-muted-foreground leading-relaxed rounded-md border border-border/60 bg-muted/30 p-3.5">
        <strong className="text-foreground">Why it matters: </strong>
        With a small number of bets, the apparent winning configuration is often
        just lucky. Good cross-validation (with{" "}
        <TermTooltip term="embargo" iconOnly>
          embargo
        </TermTooltip>{" "}
        so bets from adjacent folds can&apos;t leak signal to each other) is how
        we separate skill from luck.
      </div>
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
  notifyOnComplete,
  setNotifyOnComplete,
}: {
  name: string;
  setName: (v: string) => void;
  algorithm: SearchAlgorithm;
  nTrials: number;
  dataFilters: DataFiltersJson;
  cvType: "cpcv" | "walkforward";
  notifyOnComplete: boolean;
  setNotifyOnComplete: (v: boolean) => void;
}) {
  const algo = ALGOS.find((a) => a.value === algorithm)!;
  const cv = CV_OPTIONS.find((c) => c.value === cvType)!;

  return (
    <div className="space-y-5">
      <Field label="Run name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-9 text-sm"
        />
      </Field>

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

      <label className="flex items-start gap-2.5 cursor-pointer rounded-lg border border-border/60 bg-card p-3.5 hover:bg-muted/20 transition-colors">
        <Checkbox
          checked={notifyOnComplete}
          onCheckedChange={(v) => setNotifyOnComplete(Boolean(v))}
          className="mt-0.5"
        />
        <div className="flex-1 space-y-0.5 min-w-0">
          <div className="inline-flex items-center gap-1.5 text-sm font-semibold">
            {notifyOnComplete ? (
              <Bell className="size-3.5 text-primary" />
            ) : (
              <BellOff className="size-3.5 text-muted-foreground" />
            )}
            Notify on complete (Telegram)
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Pings your chat with a formatted summary (best trial ROI, Sharpe,
            drawdown, Pareto count) the moment this run hits a terminal status.
          </p>
        </div>
      </label>
    </div>
  );
}

function ScopeReview({ filters }: { filters: DataFiltersJson }) {
  const exProviders = filters.excludeSoftProviders ?? [];
  const exMarkets = filters.excludeMarketTypes ?? [];
  const hasAny =
    exProviders.length > 0 ||
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
      {exProviders.map((p) => (
        <ExcludedChip key={`ep-${p}`}>
          <ProviderBadge
            id={p}
            size="sm"
            short
            className="!border-0 !bg-transparent !text-inherit !px-0 !py-0"
          />
        </ExcludedChip>
      ))}
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
    <div className="space-y-2">
      <div className="text-xs font-semibold text-foreground">{label}</div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] text-muted-foreground leading-relaxed">
      {children}
    </p>
  );
}

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
        "relative text-left rounded-lg border transition-all p-3 flex flex-col gap-1.5 group",
        large && "p-4 gap-2",
        selected
          ? "border-primary bg-primary/5 shadow-sm"
          : "border-border bg-card hover:border-foreground/30 hover:bg-muted/30",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm">{label}</span>
            {recommended && (
              <span className="inline-flex items-center rounded-full px-1.5 py-px text-[9px] font-medium uppercase tracking-wide bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
                Recommended
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">{tagline}</p>
        </div>
        <span
          aria-hidden
          className={cn(
            "shrink-0 mt-0.5 size-4 rounded-full border-2 flex items-center justify-center transition-colors",
            selected
              ? "border-primary bg-primary"
              : "border-muted-foreground/40 group-hover:border-foreground/60",
          )}
        >
          {selected && (
            <span className="size-1.5 rounded-full bg-primary-foreground" />
          )}
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground leading-relaxed">
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
