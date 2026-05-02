"use client";

/**
 * Compact auto-betting settings — renders as a popover anchored to a
 * Settings icon in the dashboard header. Dense Linear/Stripe patterns:
 *   - inline label:input rows (single 32-36px row per field)
 *   - help text lives inside `?` tooltips, not in hints below
 *   - `%` / `BDT` rendered as trailing badges inside the input
 *   - Save lives in the header row of the popover
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Loader2, Settings2, SlidersHorizontal, Check, CircleHelp, Info } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { cn } from "@/lib/utils";

interface Settings {
  id: number;
  useLiveBalance: boolean;
  manualBankrollBdt: number;
  unitSizeBdt: number;
  kellyCapPct: number;
  kellyFraction: number;
  minStakeBdt: number;
  stakeBucketBdt: number;
  minEvPct: number;
  updatedAt: string;
}

type Draft = Omit<Settings, "id" | "updatedAt">;

function toDraft(s: Settings): Draft {
  const { id: _id, updatedAt: _updatedAt, ...rest } = s;
  return rest;
}



/**
 * Popover wrapper — the public entry point. Renders a Settings icon
 * button that opens the form in a popover on click. Safe to drop into
 * any header's `actions` slot.
 */
export function BettingStrategyPopover() {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          aria-label="Strategy & limits"
          title="Strategy & limits"
        >
          <SlidersHorizontal className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[440px] max-h-[80vh] overflow-hidden p-0"
      >
        <BettingStrategyForm />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Pure form body — no chrome wrapper. Used inside the popover; could
 * also be embedded elsewhere (e.g. a dedicated /settings page) without
 * any changes.
 */
export function BettingStrategyForm() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);
  const [ready, setReady] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as {
        settings?: Settings;
        ready?: boolean;
        error?: string;
      } | null;
      if (!res.ok || !data?.settings) {
        setError(data?.error ?? `Failed to load settings (${res.status})`);
        setReady(false);
        return;
      }
      setSettings(data.settings);
      setDraft(toDraft(data.settings));
      setError(
        data.ready ? null : (data.error ?? "Settings table unavailable"),
      );
      setReady(data.ready ?? true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setReady(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const dirty = useMemo(() => {
    if (!settings || !draft) return false;
    return JSON.stringify(toDraft(settings)) !== JSON.stringify(draft);
  }, [settings, draft]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(body.error ?? `Save failed (${res.status})`);
        return;
      }
      const data = (await res.json()) as { settings: Settings };
      setSettings(data.settings);
      setDraft(toDraft(data.settings));
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1500);
    } finally {
      setSaving(false);
    }
  };

  if (!draft || !settings) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
        <Loader2 className="size-3 animate-spin" /> Loading settings…
      </div>
    );
  }

  const setField = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  // Live strategy summary shown in the header — lets the user confirm
  // the effective rule without scrolling through every field.
  const kellyLabel = formatKellyFractionLabel(draft.kellyFraction);
  const bankrollLabel = draft.useLiveBalance
    ? "live balance"
    : `${draft.manualBankrollBdt.toLocaleString()} BDT`;

  return (
    <TooltipProvider>
      <div className="flex flex-col max-h-[80vh]">
        {/* ── Header: title + live settings summary ────────────────── */}
        <div className="px-3 pt-3 pb-2 border-b border-border/60 bg-muted/30">
          <div className="flex items-center gap-2">
            <Settings2 className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-sm font-medium">Strategy &amp; limits</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
            <StrategyPill label={kellyLabel} />
            <StrategyPill label={`cap ${draft.kellyCapPct}%`} />
            <StrategyPill label={bankrollLabel} />
          </div>
        </div>

        {/* ── Scrollable body ─────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
          {!ready && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[10.5px] text-amber-200 leading-tight">
              Settings table unavailable — showing defaults. Run pending
              migration to persist.
            </div>
          )}
          {error && ready && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[10.5px] text-destructive leading-tight">
              {error}
            </div>
          )}

          {/* SIZING — primary, most visible. Kelly fraction + cap side
              by side to read as a unit. */}
          <Section
            title="Sizing"
            hint="How much to stake on each value bet. Kelly fraction picks the aggressiveness; the cap is a hard ceiling on any single bet as a percentage of bankroll."
          >
            <div className="grid grid-cols-2 gap-2">
              <MiniField
                label="Kelly fraction"
                help="Multiplier on the full-Kelly stake. Lower = smaller swings, slower growth."
              >
                <KellyFractionSelect
                  value={draft.kellyFraction}
                  onChange={(v) => setField("kellyFraction", v)}
                />
              </MiniField>
              <MiniField
                label="Kelly cap"
                help="Maximum stake as a percentage of bankroll. Applies on top of the Kelly fraction."
              >
                <NumericField
                  value={draft.kellyCapPct}
                  unit="%"
                  step={0.5}
                  min={0}
                  max={100}
                  onChange={(v) => setField("kellyCapPct", v)}
                />
              </MiniField>
            </div>
          </Section>

          {/* BANKROLL — what Kelly sizes against. */}
          <Section
            title="Bankroll"
            hint="The reference balance Kelly sizes against. Live balance auto-adjusts as bets settle; manual is a fixed number you set yourself."
          >
            <label className="flex items-center gap-2 text-xs select-none h-7">
              <Checkbox
                checked={draft.useLiveBalance}
                onCheckedChange={(v) => setField("useLiveBalance", v === true)}
              />
              <span>Use provider live balance</span>
            </label>
            {!draft.useLiveBalance && (
              <Row label="Manual balance">
                <NumericField
                  value={draft.manualBankrollBdt}
                  unit="BDT"
                  step={100}
                  min={0}
                  onChange={(v) => setField("manualBankrollBdt", v)}
                />
              </Row>
            )}
            <Row
              label="Unit size"
              help="Base unit for Flat / EV-proportional strategies. Kelly sizing ignores this."
            >
              <NumericField
                value={draft.unitSizeBdt}
                unit="BDT"
                step={50}
                min={0}
                onChange={(v) => setField("unitSizeBdt", v)}
              />
            </Row>
          </Section>

          <Section
            title="Bet quality"
            hint="Which opportunities are eligible for auto-placement. Bets below Min EV are dropped before sizing runs."
          >
            <Row
              label="Min EV"
              help="Bets below this EV percentage are ignored entirely — never surfaced to auto-placement."
            >
              <NumericField
                value={draft.minEvPct}
                unit="%"
                step={0.1}
                min={0}
                onChange={(v) => setField("minEvPct", v)}
              />
            </Row>
          </Section>


          {/* ROUNDING — stake shaping applied after Kelly. */}
          <Section
            title="Rounding"
            hint="Stake shaping applied after Kelly. Bumps tiny stakes up to Min stake and snaps the final number to the nearest Stake bucket so place-orders stay neat."
          >
            <Row
              label="Min stake"
              help="Stakes below this are clamped up (or the bet is skipped if balance can't cover it)."
            >
              <NumericField
                value={draft.minStakeBdt}
                unit="BDT"
                step={50}
                min={0}
                onChange={(v) => setField("minStakeBdt", v)}
              />
            </Row>
            <Row
              label="Stake bucket"
              help="All auto-placed stakes round to multiples of this."
            >
              <NumericField
                value={draft.stakeBucketBdt}
                unit="BDT"
                step={10}
                min={1}
                onChange={(v) => setField("stakeBucketBdt", v)}
              />
            </Row>
          </Section>

        </div>

        {/* ── Sticky save bar (appears only when dirty) ───────────── */}
        {(dirty || savedTick) && (
          <div className="border-t border-border/60 bg-muted/30 px-3 py-2 flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">
              {savedTick ? (
                <span className="flex items-center gap-1 text-emerald-500">
                  <Check className="size-3" /> Saved
                </span>
              ) : (
                "Unsaved changes"
              )}
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDraft(toDraft(settings))}
                disabled={!dirty || saving}
                className="h-7 px-2 text-xs"
              >
                Discard
              </Button>
              <Button
                size="sm"
                onClick={save}
                disabled={!dirty || saving || !ready}
                className="h-7 px-3 text-xs"
              >
                {saving ? (
                  <>
                    <Loader2 className="size-3 animate-spin" />
                    Saving…
                  </>
                ) : (
                  "Save"
                )}
              </Button>
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}

// ------------------------------------------------------------------
// Small helper that formats the raw kellyFraction into a human label
// matching the dropdown presets. Kept here so the header summary and
// the tooltip stay in sync.
// ------------------------------------------------------------------
function formatKellyFractionLabel(v: number): string {
  if (v >= 0.99) return "Full Kelly";
  if (Math.abs(v - 0.5) < 0.01) return "½ Kelly";
  if (Math.abs(v - 0.25) < 0.01) return "¼ Kelly";
  if (Math.abs(v - 0.125) < 0.01) return "⅛ Kelly";
  return `${v.toFixed(3).replace(/\.?0+$/, "")}× Kelly`;
}


// ------------------------------------------------------------------
// Strategy summary pill in the header. Compact neutral chip — the
// colour the user cares about (P&L) lives elsewhere.
// ------------------------------------------------------------------
function StrategyPill({
  label,
  tone = "muted",
}: {
  label: string;
  tone?: "muted" | "accent";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums",
        tone === "accent"
          ? "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300"
          : "bg-muted/60 text-foreground/80",
      )}
    >
      {label}
    </span>
  );
}

// ------------------------------------------------------------------
// Section grouping helper — uppercase tracking-wide label with a
// muted hint below it. Sets up a visual rhythm of Sizing → Bankroll
// → Bet quality → Rounding so fields aren't a wall
// of label:input pairs.
// ------------------------------------------------------------------
function Section({
  title,
  hint,
  trailing,
  children,
}: {
  title: string;
  hint?: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[10.5px] uppercase tracking-wider text-foreground font-bold">
          {title}
        </span>
        {hint && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="text-muted-foreground/50 hover:text-foreground transition-colors"
                aria-label={`${title} help`}
              >
                <CircleHelp className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              align="start"
              className="max-w-[260px] text-[11px] leading-snug"
            >
              {hint}
            </TooltipContent>
          </Tooltip>
        )}
        {trailing && <div className="ml-auto">{trailing}</div>}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

// ------------------------------------------------------------------
// MiniField — stacked label / input used inside the 2-col Sizing
// grid. Unlike Row (horizontal), this stacks vertically so two fields
// sit side by side without colliding with long labels.
// ------------------------------------------------------------------
function MiniField({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <span className="truncate">{label}</span>
        {help && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="text-muted-foreground/60 hover:text-foreground transition-colors"
                aria-label={`${label} help`}
              >
                <CircleHelp className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="max-w-[240px] text-[11px] leading-snug"
            >
              {help}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {children}
    </div>
  );
}

// ------------------------------------------------------------------
// Compact row primitive: label | input pair in a single line.
// `help` renders as a `?` tooltip instead of a sub-line of text.
// ------------------------------------------------------------------
function Row({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] items-center gap-2">
      <div className="flex items-center gap-1 text-xs text-muted-foreground min-w-0">
        <span className="truncate">{label}</span>
        {help && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="text-muted-foreground/60 hover:text-foreground transition-colors"
                aria-label={`${label} help`}
              >
                <CircleHelp className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="left"
              className="max-w-[240px] text-[11px] leading-snug"
            >
              {help}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// ------------------------------------------------------------------
// Numeric input with a trailing unit badge (e.g. "100 BDT", "10 %").
// Smaller than separate label + unit column.
// ------------------------------------------------------------------
function NumericField({
  value,
  unit,
  min,
  max,
  step,
  integer,
  onChange,
  disabled,
}: {
  value: number;
  unit: string;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className={cn("relative", disabled && "opacity-60")}>
      <Input
        type="number"
        inputMode={integer ? "numeric" : "decimal"}
        value={Number.isFinite(value) ? value : 0}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!Number.isFinite(v)) return;
          onChange(integer ? Math.round(v) : v);
        }}
        className="h-7 text-xs md:text-xs py-0 pr-10 tabular-nums"
      />
      {unit && (
        <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[10px] uppercase tracking-wide text-muted-foreground/70">
          {unit}
        </span>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// Kelly fraction dropdown. Four presets with inline descriptions so the
// user doesn't need to know Kelly theory to pick one. Stored as the raw
// multiplier (0.125 / 0.25 / 0.5 / 1.0) — matches what `computeStake`
// expects.
// ------------------------------------------------------------------
const KELLY_FRACTION_OPTIONS: Array<{
  value: number;
  label: string;
  description: string;
}> = [
  {
    value: 1,
    label: "Full Kelly (1×)",
    description:
      "Theoretical optimum. Maximum growth, maximum swings. Only with perfect edge estimates.",
  },
  {
    value: 0.5,
    label: "Half Kelly (1/2×)",
    description:
      "Aggressive. ~75% of full-Kelly growth at ~half the volatility.",
  },
  {
    value: 0.25,
    label: "Quarter Kelly (1/4×)",
    description:
      "Default. Conservative — absorbs edge-estimation error and soft-book limits.",
  },
  {
    value: 0.125,
    label: "Eighth Kelly (1/8×)",
    description:
      "Very conservative. Use when edge confidence is low or during a drawdown.",
  },
];

function KellyFractionSelect({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  // Snap whatever's in the DB to the closest preset so the Select always
  // has a matching item to highlight.
  const closest = KELLY_FRACTION_OPTIONS.reduce((best, opt) =>
    Math.abs(opt.value - value) < Math.abs(best.value - value) ? opt : best,
  );
  return (
    <Select
      value={String(closest.value)}
      onValueChange={(v) => onChange(Number(v))}
    >
      <SelectTrigger
        data-size="sm"
        className="!h-7 py-0 text-xs w-full"
        title={closest.description}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {KELLY_FRACTION_OPTIONS.map((opt) => (
          <Tooltip key={opt.value}>
            <TooltipTrigger asChild>
              <SelectItem value={String(opt.value)} className="text-xs">
                {opt.label}
              </SelectItem>
            </TooltipTrigger>
            <TooltipContent
              side="left"
              className="max-w-[240px] text-[11px] leading-snug"
            >
              {opt.description}
            </TooltipContent>
          </Tooltip>
        ))}
      </SelectContent>
    </Select>
  );
}

