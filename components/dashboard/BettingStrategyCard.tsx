"use client";

/**
 * Compact auto-betting settings — renders as a popover anchored to a
 * Settings icon in the dashboard header. Dense Linear/Stripe patterns:
 *   - inline label:input rows (single 32-36px row per field)
 *   - help text lives inside `?` tooltips, not in hints below
 *   - `%` / `BDT` rendered as trailing badges inside the input
 *   - Safety rails rendered as "+ Add limit" affordances so blank
 *     fields have zero visual weight
 *   - Save lives in the header row of the popover
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Loader2, Settings2, Check, CircleHelp, X, Plus } from "lucide-react";
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

interface Strategy {
  id: string;
  label: string;
  description: string;
}

interface Settings {
  id: number;
  strategyId: string;
  useLiveBalance: boolean;
  manualBankrollBdt: number;
  unitSizeBdt: number;
  kellyCapPct: number;
  minStakeBdt: number;
  stakeBucketBdt: number;
  minEvPct: number;
  maxOddsAgeSec: number;
  dailyMaxLossBdt: number | null;
  dailyMaxStakeBdt: number | null;
  maxConcurrentExposureBdt: number | null;
  maxBetsPerDay: number | null;
  cooldownAfterLossSec: number | null;
  updatedAt: string;
}

type Draft = Omit<Settings, "id" | "updatedAt">;

function toDraft(s: Settings): Draft {
  const { id: _id, updatedAt: _updatedAt, ...rest } = s;
  return rest;
}

type NullableKey =
  | "dailyMaxLossBdt"
  | "dailyMaxStakeBdt"
  | "maxConcurrentExposureBdt"
  | "maxBetsPerDay"
  | "cooldownAfterLossSec";

const SAFETY_FIELDS: Array<{
  key: NullableKey;
  label: string;
  unit: string;
  step: number;
  integer?: boolean;
  defaultValue: number;
  help: string;
}> = [
  {
    key: "dailyMaxLossBdt",
    label: "Daily max loss",
    unit: "BDT",
    step: 100,
    defaultValue: 1000,
    help: "Auto-pauses auto-placing once today's net loss hits this.",
  },
  {
    key: "dailyMaxStakeBdt",
    label: "Daily max stake",
    unit: "BDT",
    step: 100,
    defaultValue: 5000,
    help: "Hard cap on total BDT staked per day.",
  },
  {
    key: "maxConcurrentExposureBdt",
    label: "Max concurrent exposure",
    unit: "BDT",
    step: 100,
    defaultValue: 2000,
    help: "Skip new bets while total open exposure is above this.",
  },
  {
    key: "maxBetsPerDay",
    label: "Max bets / day",
    unit: "",
    step: 1,
    integer: true,
    defaultValue: 20,
    help: "Hard count ceiling. Useful while evaluating a new strategy.",
  },
  {
    key: "cooldownAfterLossSec",
    label: "Cooldown after loss",
    unit: "s",
    step: 15,
    integer: true,
    defaultValue: 60,
    help: "Wait N seconds before placing again after a lost bet.",
  },
];

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
          size="sm"
          aria-label="Auto-betting settings"
          title="Auto-betting settings"
        >
          <Settings2 className="size-3.5" />
          <span className="hidden sm:inline">Auto-betting</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[420px] max-h-[80vh] overflow-y-auto p-3"
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
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);
  const [ready, setReady] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/betting-settings", { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as {
        settings?: Settings;
        strategies?: Strategy[];
        ready?: boolean;
        error?: string;
      } | null;
      if (!res.ok || !data?.settings) {
        setError(data?.error ?? `Failed to load settings (${res.status})`);
        setReady(false);
        return;
      }
      setSettings(data.settings);
      setStrategies(data.strategies ?? []);
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
      const res = await fetch("/api/betting-settings", {
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
  const activeStrategy = strategies.find((s) => s.id === draft.strategyId);

  return (
    <TooltipProvider>
      <div className="flex flex-col">
        <div className="flex items-center justify-between gap-2 pb-2">
          <div className="text-sm font-medium flex items-center gap-2 min-w-0">
            <Settings2 className="size-4 shrink-0" />
            <span className="truncate">Auto-betting</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {savedTick && (
              <span className="text-[11px] text-emerald-500 flex items-center gap-1">
                <Check className="size-3" /> Saved
              </span>
            )}
            <Button
              size="sm"
              onClick={save}
              disabled={!dirty || saving || !ready}
              className="h-7 px-3 text-xs"
            >
              {saving ? (
                <Loader2 className="size-3 animate-spin" />
              ) : dirty ? (
                "Save"
              ) : (
                "Saved"
              )}
            </Button>
          </div>
        </div>
        <div className="space-y-2">
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

          {/* Strategy */}
          <Row label="Strategy" help={activeStrategy?.description}>
            <Select
              value={draft.strategyId}
              onValueChange={(v) => setField("strategyId", v)}
            >
              <SelectTrigger className="h-7 text-xs w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {strategies.map((s) => (
                  <SelectItem key={s.id} value={s.id} className="text-xs">
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>

          {/* Bankroll — toggle + one of (live / manual) */}
          <Row
            label="Bankroll"
            help="Live = provider's current balance. Self-adjusting. Off = use a fixed manual amount below."
          >
            <label className="flex items-center gap-1.5 text-xs select-none h-7">
              <Checkbox
                checked={draft.useLiveBalance}
                onCheckedChange={(v) => setField("useLiveBalance", v === true)}
              />
              <span>Use live balance</span>
            </label>
          </Row>
          {!draft.useLiveBalance && (
            <Row label="Manual amount">
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
            help="Base unit for Flat / EV-proportional strategies."
          >
            <NumericField
              value={draft.unitSizeBdt}
              unit="BDT"
              step={50}
              min={0}
              onChange={(v) => setField("unitSizeBdt", v)}
            />
          </Row>

          <Row
            label="Kelly cap"
            help="Maximum stake as a percentage of bankroll. Applies to all Kelly variants."
          >
            <NumericField
              value={draft.kellyCapPct}
              unit="%"
              step={0.5}
              min={0}
              max={100}
              onChange={(v) => setField("kellyCapPct", v)}
            />
          </Row>

          <div className="h-px bg-border/60 my-1" />

          {/* Stake shaping */}
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
          <Row
            label="Max odds age"
            help="Sharp-odds snapshots older than this are considered stale; value bets computed from them are dropped."
          >
            <NumericField
              value={draft.maxOddsAgeSec}
              unit="s"
              step={5}
              min={5}
              integer
              onChange={(v) => setField("maxOddsAgeSec", v)}
            />
          </Row>

          {/* Safety rails — blank by default; each is a "+ Add limit"
              affordance that reveals its input when enabled. */}
          <SafetyRails draft={draft} setField={setField} />
        </div>
      </div>
    </TooltipProvider>
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
        className="h-7 text-xs pr-10 tabular-nums"
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
// Safety rails — Stripe/Linear pattern: show a bare "+ Add <limit>"
// button until enabled; then the input appears with an `x` to remove
// it. Persistence is null = "no limit", a number = the limit.
// ------------------------------------------------------------------
function SafetyRails({
  draft,
  setField,
}: {
  draft: Draft;
  setField: <K extends keyof Draft>(k: K, v: Draft[K]) => void;
}) {
  const active = SAFETY_FIELDS.filter((f) => draft[f.key] !== null);
  const inactive = SAFETY_FIELDS.filter((f) => draft[f.key] === null);
  const [open, setOpen] = useState(active.length > 0);
  const prevActiveCount = useRef(active.length);
  useEffect(() => {
    if (active.length > prevActiveCount.current) setOpen(true);
    prevActiveCount.current = active.length;
  }, [active.length]);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="pt-1">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between text-[11px] uppercase tracking-wider text-muted-foreground/80 hover:text-foreground transition-colors"
        >
          <span>
            Safety rails
            {active.length > 0 && (
              <span className="ml-1.5 normal-case tracking-normal text-[10.5px] text-foreground/80">
                · {active.length} active
              </span>
            )}
          </span>
          <span className="text-[10px] opacity-60">
            {open ? "hide" : "show"}
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-1.5 pt-1.5">
        {active.map((f) => (
          <div
            key={f.key}
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] items-center gap-2"
          >
            <div className="flex items-center gap-1 text-xs text-muted-foreground min-w-0">
              <span className="truncate">{f.label}</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="text-muted-foreground/60 hover:text-foreground transition-colors"
                    aria-label={`${f.label} help`}
                  >
                    <CircleHelp className="size-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent
                  side="left"
                  className="max-w-[240px] text-[11px] leading-snug"
                >
                  {f.help}
                </TooltipContent>
              </Tooltip>
            </div>
            <NumericField
              value={(draft[f.key] as number | null) ?? f.defaultValue}
              unit={f.unit}
              step={f.step}
              min={0}
              integer={f.integer}
              onChange={(v) => setField(f.key, v as Draft[typeof f.key])}
            />
            <button
              type="button"
              onClick={() => setField(f.key, null as Draft[typeof f.key])}
              className="text-muted-foreground/60 hover:text-destructive transition-colors"
              aria-label={`Remove ${f.label}`}
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
        {inactive.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {inactive.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() =>
                  setField(f.key, f.defaultValue as Draft[typeof f.key])
                }
                className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-border/70 px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground hover:border-border transition-colors"
              >
                <Plus className="size-2.5" />
                {f.label}
              </button>
            ))}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
