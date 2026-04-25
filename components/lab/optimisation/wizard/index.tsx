"use client";

/**
 * Shared stepper primitives used by `SubmitRunSheet` ("New run") and
 * `CreateScheduleSheet` ("New schedule").
 *
 * These two sheets are conceptually the same shape — "configure a run,
 * confirm, launch" — so they share the visual language:
 *   ┌────────────────────┬────────────────────────────────────────────┐
 *   │ title + stepper    │ StepHeader (step X of N + title + hint)    │
 *   │ + "Current setup"  │ ──────────────────────────────────────────  │
 *   │ summary            │ step content (scrollable)                  │
 *   │ (sticky left rail) │ ──────────────────────────────────────────  │
 *   │                    │ StepFooter (back / progress dots / submit) │
 *   └────────────────────┴────────────────────────────────────────────┘
 *
 * The consumer owns step state, form state, and validation; these primitives
 * only render the chrome.
 */

import * as React from "react";
import { Check, ChevronLeft, ChevronRight, Rocket } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

// ── Types ────────────────────────────────────────────────────────────────

export interface WizardStep<Id extends number = number> {
  id: Id;
  label: string;
  caption: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Large title shown in the right-pane `<StepHeader>`. */
  title: string;
  /** Short sentence shown under the step title. */
  subtitle: string;
}

// ── Left rail ────────────────────────────────────────────────────────────

export function StepperRail<Id extends number>({
  title,
  titleIcon: TitleIcon,
  steps,
  current,
  onJump,
  children,
}: {
  title: string;
  titleIcon?: React.ComponentType<{ className?: string }>;
  steps: readonly WizardStep<Id>[];
  current: Id;
  onJump: (id: Id) => void;
  /** Slot for the "Current setup" summary below the step list. */
  children: React.ReactNode;
}) {
  return (
    <aside className="border-r border-border/60 bg-muted/30 flex flex-col min-h-0">
      <div className="px-5 pt-5 pb-4 border-b border-border/60 flex items-center gap-2.5">
        {TitleIcon ? (
          <TitleIcon className="size-4 text-primary" aria-hidden />
        ) : null}
        <span className="text-base font-semibold">{title}</span>
      </div>

      <ol className="flex flex-col gap-1 p-3">
        {steps.map((s) => {
          const active = current === s.id;
          const completed = current > s.id;
          const Icon = s.icon;
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onJump(s.id)}
                className={cn(
                  "w-full flex items-start gap-3 text-left rounded-md px-2.5 py-2.5 transition-colors",
                  active && "bg-background shadow-sm",
                  !active && "hover:bg-background/60",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 inline-flex items-center justify-center size-7 rounded-full text-xs font-semibold border shrink-0 transition-colors",
                    active &&
                      "bg-primary text-primary-foreground border-primary",
                    completed && "bg-emerald-500 text-white border-emerald-500",
                    !active &&
                      !completed &&
                      "bg-background text-muted-foreground border-border",
                  )}
                >
                  {completed ? (
                    <Check className="size-4" />
                  ) : (
                    <Icon className="size-4" />
                  )}
                </span>
                <span className="flex-1 min-w-0">
                  <span
                    className={cn(
                      "block text-sm font-semibold leading-tight",
                      active ? "text-foreground" : "text-foreground/90",
                    )}
                  >
                    {s.id}. {s.label}
                  </span>
                  <span className="block text-[13px] text-muted-foreground leading-snug mt-0.5">
                    {s.caption}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="border-t border-border/60 mx-3" />

      <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Current setup
        </p>
        {children}
      </div>
    </aside>
  );
}

// ── Right-pane header ─────────────────────────────────────────────────────

export function StepHeader<Id extends number>({
  step,
  steps,
}: {
  step: Id;
  steps: readonly WizardStep<Id>[];
}) {
  const def = steps.find((s) => s.id === step);
  return (
    <header className="px-8 pt-6 pb-4 border-b border-border/60 shrink-0">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Step {step} of {steps.length}
      </div>
      <h2 className="text-xl font-semibold leading-tight mt-1">{def?.title}</h2>
      {def?.subtitle && (
        <p className="text-sm text-muted-foreground leading-relaxed mt-1.5 max-w-[640px]">
          {def.subtitle}
        </p>
      )}
    </header>
  );
}

// ── Right-pane footer ─────────────────────────────────────────────────────

export function StepFooter<Id extends number>({
  step,
  steps,
  onBack,
  onNext,
  onSubmit,
  canSubmit,
  pending,
  submitLabel = "Run now",
  submitIcon: SubmitIcon = Rocket,
  pendingLabel = "Queueing…",
}: {
  step: Id;
  steps: readonly WizardStep<Id>[];
  onBack: () => void;
  onNext: () => void;
  onSubmit: () => void;
  canSubmit: boolean;
  pending: boolean;
  submitLabel?: string;
  submitIcon?: React.ComponentType<{ className?: string }>;
  pendingLabel?: string;
}) {
  const atEnd = step === steps[steps.length - 1]?.id;
  const atStart = step === steps[0]?.id;
  return (
    <footer className="px-7 py-3.5 border-t border-border/60 flex items-center justify-between gap-3 bg-muted/20 shrink-0">
      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
        disabled={atStart}
        className="gap-1.5 h-8"
      >
        <ChevronLeft className="size-3.5" /> Back
      </Button>

      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        {steps.map((s) => (
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
          <SubmitIcon className="size-3.5" />
          {pending ? pendingLabel : submitLabel}
        </Button>
      ) : (
        <Button size="sm" onClick={onNext} className="gap-1.5 h-8">
          Next <ChevronRight className="size-3.5" />
        </Button>
      )}
    </footer>
  );
}

// ── Left-rail key/value summary line ──────────────────────────────────────

export function SummaryLine({
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
      <span className="text-xs text-muted-foreground shrink-0 w-[68px] pt-0.5">
        {label}
      </span>
      <span
        className={cn(
          "text-xs font-medium text-right flex-1 min-w-0 break-words",
          mono && "tabular-nums",
        )}
      >
        {value}
      </span>
    </div>
  );
}
