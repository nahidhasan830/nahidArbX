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
import {
  Loader2,
  Settings2,
  SlidersHorizontal,
  Check,
  CircleHelp,
  X,
  Plus,
  Info,
} from "lucide-react";
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
import { useApplicableStrategies } from "@/lib/optimizer/use-live-strategies";
import {
  formatFilterChips,
  formatStrategyDetails,
} from "@/lib/optimizer/format-strategy";
import type {
  StrategyFilters,
  StrategySizing,
} from "@/lib/optimizer/strategy-filters";
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
  maxOddsAgeSec: number;
  dailyMaxLossBdt: number | null;
  dailyMaxStakeBdt: number | null;
  maxConcurrentExposureBdt: number | null;
  maxBetsPerDay: number | null;
  cooldownAfterLossSec: number | null;
  /**
   * Strategies the auto-placer must match before placing a bet. Empty =
   * the global EV cutoff applies to everything (pre-strategy behaviour).
   */
  activeStrategyIds: string[];
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
  const activeSafetyRails = SAFETY_FIELDS.filter(
    (f) => draft[f.key] !== null,
  ).length;
  const activeStrategiesCount = draft.activeStrategyIds?.length ?? 0;

  return (
    <TooltipProvider>
      <div className="flex flex-col max-h-[80vh]">
        {/* ── Header: title + live strategy summary ───────────────── */}
        <div className="px-3 pt-3 pb-2 border-b border-border/60 bg-muted/30">
          <div className="flex items-center gap-2">
            <Settings2 className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-sm font-medium">Strategy &amp; limits</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
            <StrategyPill label={kellyLabel} />
            <StrategyPill label={`cap ${draft.kellyCapPct}%`} />
            <StrategyPill label={bankrollLabel} />
            {activeSafetyRails > 0 && (
              <StrategyPill
                label={`${activeSafetyRails} safety rail${activeSafetyRails === 1 ? "" : "s"}`}
              />
            )}
            {activeStrategiesCount > 0 && (
              <StrategyPill
                label={`${activeStrategiesCount} active strateg${activeStrategiesCount === 1 ? "y" : "ies"}`}
                tone="accent"
              />
            )}
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

          {/* QUALITY — which bets pass the filter. */}
          <Section
            title="Bet quality"
            hint="Which opportunities are eligible for auto-placement. Bets below Min EV or computed from stale sharp odds are dropped before sizing runs."
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
          </Section>

          {/* ACTIVE STRATEGIES — gate auto-placement by saved strategies. */}
          <ActiveStrategiesSection
            value={draft.activeStrategyIds}
            onChange={(ids) => setField("activeStrategyIds", ids)}
          />

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

          {/* SAFETY RAILS — collapsible, blank by default. */}
          <SafetyRails draft={draft} setField={setField} />
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
// Active strategies — multi-select gate for auto-placement.
//
// When non-empty, the auto-placer only places bets that match at least
// one of the selected strategies' filters. Empty = global EV cutoff
// applies to everything.
// ------------------------------------------------------------------
function ActiveStrategiesSection({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const { data: strategies, isLoading } = useApplicableStrategies();
  const list = strategies ?? [];
  const selected = new Set(value);
  // Surface stale selections (strategy retired or hard-deleted) so the
  // user can clean them out — silently dropping would mask the issue.
  const knownIds = new Set(list.map((s) => s.id));
  const staleIds = value.filter((id) => !knownIds.has(id));

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  };

  const trailing =
    list.length > 1 ? (
      selected.size === list.length ? (
        <button
          type="button"
          onClick={() => onChange([])}
          className="text-[10px] text-muted-foreground hover:text-foreground tracking-normal normal-case"
        >
          Clear
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onChange(list.map((s) => s.id))}
          className="text-[10px] text-muted-foreground hover:text-foreground tracking-normal normal-case"
        >
          Select all
        </button>
      )
    ) : null;

  return (
    <Section
      title="Active strategies"
      hint="Auto-place only bets that match at least one selected strategy. Leave empty to fall back on the global Min EV cutoff."
      trailing={trailing}
    >
      {isLoading ? (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground py-2">
          <Loader2 className="size-3 animate-spin" /> Loading strategies…
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/60 bg-muted/20 px-2.5 py-3 text-[11px] text-muted-foreground leading-relaxed">
          No strategies yet. Promote a trial from{" "}
          <span className="font-medium text-foreground">/lab/optimisation</span>{" "}
          to gate auto-placement on it here.
        </div>
      ) : (
        <div className="rounded-md border border-border/60 bg-muted/30 divide-y divide-border/40 max-h-56 overflow-y-auto">
          {list.map((s) => (
            <StrategyRow
              key={s.id}
              name={s.name}
              description={s.description}
              filters={s.filters as StrategyFilters}
              sizing={s.sizing as StrategySizing | null}
              checked={selected.has(s.id)}
              onToggle={() => toggle(s.id)}
            />
          ))}
        </div>
      )}
      {staleIds.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[10.5px] text-amber-700 dark:text-amber-300 leading-tight flex items-center justify-between gap-2">
          <span>
            {staleIds.length} selected strateg
            {staleIds.length === 1 ? "y" : "ies"} no longer exist
          </span>
          <button
            type="button"
            onClick={() => onChange(value.filter((id) => knownIds.has(id)))}
            className="text-amber-700 dark:text-amber-300 hover:underline font-medium"
          >
            Clear
          </button>
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------
// One strategy entry. Click anywhere on the row to toggle. The info
// icon hover reveals a structured tooltip with the full filter +
// sizing config in human-readable form, so the user doesn't have to
// open /lab/optimisation to confirm what they're enabling.
// ------------------------------------------------------------------
function StrategyRow({
  name,
  description,
  filters,
  sizing,
  checked,
  onToggle,
}: {
  name: string;
  description: string | null;
  filters: StrategyFilters;
  sizing: StrategySizing | null;
  checked: boolean;
  onToggle: () => void;
}) {
  const chips = formatFilterChips(filters);
  const details = formatStrategyDetails(filters, sizing);
  return (
    <label
      className={cn(
        "flex items-start gap-2 px-2 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors",
        checked && "bg-cyan-500/10",
      )}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={onToggle}
        className="mt-0.5"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-medium truncate">{name}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => e.preventDefault()}
                className="text-muted-foreground/50 hover:text-foreground transition-colors shrink-0"
                aria-label={`${name} configuration`}
              >
                <Info className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="left"
              align="start"
              className="max-w-[280px] p-0 overflow-hidden"
            >
              <StrategyConfigTooltip
                name={name}
                description={description}
                details={details}
              />
            </TooltipContent>
          </Tooltip>
        </div>
        {chips.length > 0 ? (
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            {chips.map((c, i) => (
              <span
                key={i}
                className="inline-flex items-center rounded-sm bg-background/80 border border-border/60 px-1 py-px text-[9.5px] font-medium tabular-nums text-muted-foreground"
              >
                {c}
              </span>
            ))}
          </div>
        ) : (
          description && (
            <div className="mt-0.5 text-[10px] text-muted-foreground truncate">
              {description}
            </div>
          )
        )}
      </div>
    </label>
  );
}

// ------------------------------------------------------------------
// Tooltip body for a strategy. Uses two stacked sections (filters,
// sizing) with right-aligned values — same visual rhythm as the
// optimisation report, so the user's eye recognises it instantly.
// ------------------------------------------------------------------
function StrategyConfigTooltip({
  name,
  description,
  details,
}: {
  name: string;
  description: string | null;
  details: ReturnType<typeof formatStrategyDetails>;
}) {
  return (
    <div className="text-[11px] leading-snug">
      <div className="px-2.5 py-2 border-b border-border/60 bg-muted/40">
        <div className="font-semibold text-foreground">{name}</div>
        {description && (
          <div className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">
            {description}
          </div>
        )}
      </div>
      <div className="px-2.5 py-2 space-y-2">
        <div>
          <div className="text-[9.5px] uppercase tracking-wider text-muted-foreground/80 font-medium mb-1">
            Filters
          </div>
          <dl className="space-y-0.5">
            {details.filters.map((row) => (
              <div
                key={row.label}
                className="grid grid-cols-[auto_1fr] gap-2 items-baseline"
              >
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd className="text-foreground text-right tabular-nums break-words">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
        {details.sizing.length > 0 && (
          <div>
            <div className="text-[9.5px] uppercase tracking-wider text-muted-foreground/80 font-medium mb-1">
              Sizing
            </div>
            <dl className="space-y-0.5">
              {details.sizing.map((row) => (
                <div
                  key={row.label}
                  className="grid grid-cols-[auto_1fr] gap-2 items-baseline"
                >
                  <dt className="text-muted-foreground">{row.label}</dt>
                  <dd className="text-foreground text-right tabular-nums break-words">
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </div>
  );
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
// → Bet quality → Rounding → Safety rails so fields aren't a wall
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
          className="group flex w-full items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-muted-foreground/90 font-medium hover:text-foreground transition-colors"
        >
          <span>Safety rails</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="text-muted-foreground/50 group-hover:text-foreground transition-colors"
                aria-label="Safety rails help"
              >
                <CircleHelp className="size-3" />
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              align="start"
              className="max-w-[260px] text-[11px] leading-snug"
            >
              Optional auto-pause rules that override sizing. Any rail you
              enable will block new placements once the threshold is hit; leave
              them off to run unbounded.
            </TooltipContent>
          </Tooltip>
          {active.length > 0 && (
            <span className="normal-case tracking-normal rounded-sm bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 px-1.5 py-0.5 text-[10px] font-medium tabular-nums">
              {active.length} active
            </span>
          )}
          <span className="ml-auto text-[10px] opacity-60 normal-case tracking-normal">
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
