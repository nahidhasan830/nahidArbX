"use client";

/**
 * Optimisation unified workbench.
 *
 * Three scopes:
 *   - Runs       — list of optimization runs with live progress
 *   - Schedules  — recurring runs
 *   - Strategies — saved filter+sizing recommendations (promoted from trials)
 *
 * Scope is URL-driven (`?scope=schedules`) so deep-links / back button work.
 * The header uses an underline-tab pattern (text-sm) — modern, calm, and
 * the icon+label combo reads cleanly without a heavy container chrome.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { HelpCircle, List, Repeat, Target } from "lucide-react";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { RunsTable } from "@/components/lab/optimisation/RunsTable";
import { SubmitRunSheet } from "@/components/lab/optimisation/SubmitRunSheet";
import { QuickRunButton } from "@/components/lab/optimisation/QuickRunButton";
import { SchedulesTable } from "@/components/lab/optimisation/SchedulesTable";
import { CreateScheduleSheet } from "@/components/lab/optimisation/CreateScheduleSheet";
import { StrategiesTable } from "@/components/lab/optimisation/StrategiesTable";
import { cn } from "@/lib/utils";

type Scope = "runs" | "schedules" | "strategies";

const TABS: ReadonlyArray<{
  id: Scope;
  label: string;
  Icon: typeof List;
}> = [
  { id: "runs", label: "Runs", Icon: List },
  { id: "schedules", label: "Schedules", Icon: Repeat },
  { id: "strategies", label: "Strategies", Icon: Target },
];

function isScope(v: string | null): v is Scope {
  return v === "runs" || v === "schedules" || v === "strategies";
}

export default function OptimisationPage() {
  const router = useRouter();
  const params = useSearchParams();
  const scope: Scope = isScope(params.get("scope"))
    ? (params.get("scope") as Scope)
    : "runs";

  const setScope = (next: Scope) => {
    const qs = new URLSearchParams(params.toString());
    if (next === "runs") qs.delete("scope");
    else qs.set("scope", next);
    const query = qs.toString();
    router.replace(query ? `/lab/optimisation?${query}` : "/lab/optimisation", {
      scroll: false,
    });
  };

  return (
    <AppShell
      title="Optimisation"
      edgeToEdge
      actions={<TopActions scope={scope} />}
    >
      <div className="flex flex-col gap-4 lg:gap-6 p-4 lg:p-6">
        <CommandBar scope={scope} onScopeChange={setScope} />

        <div className="min-h-0">
          {scope === "runs" && <RunsTable />}
          {scope === "schedules" && <SchedulesTable />}
          {scope === "strategies" && <StrategiesTable />}
        </div>
      </div>
    </AppShell>
  );
}

// ── Top-right actions (context-aware) ────────────────────────────────────

function TopActions({ scope }: { scope: Scope }) {
  if (scope === "runs") {
    return (
      <div className="flex items-center gap-1.5">
        <SubmitRunSheet />
        <QuickRunButton />
      </div>
    );
  }
  if (scope === "schedules") return <CreateScheduleSheet />;
  return null;
}

// ── Command bar — underline-tab segmented control + help popover ─────────

function CommandBar({
  scope,
  onScopeChange,
}: {
  scope: Scope;
  onScopeChange: (s: Scope) => void;
}) {
  return (
    <div className="border-b border-border flex items-end gap-1 -mx-1 overflow-x-auto">
      <div className="flex items-end gap-1 flex-1 min-w-0">
        {TABS.map(({ id, label, Icon }) => {
          const active = scope === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onScopeChange(id)}
              className={cn(
                "relative inline-flex items-center gap-2 h-10 px-4 text-sm font-medium transition-colors -mb-px border-b-2 whitespace-nowrap",
                active
                  ? "text-foreground border-foreground"
                  : "text-muted-foreground hover:text-foreground border-transparent",
              )}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="size-4" />
              {label}
            </button>
          );
        })}
      </div>
      <HelpPopover scope={scope} />
    </div>
  );
}

function HelpPopover({ scope }: { scope: Scope }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-9 px-3 text-sm text-muted-foreground gap-1.5 -mb-px"
        >
          <HelpCircle className="size-4" /> Help
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[380px] text-sm leading-relaxed space-y-2"
      >
        {scope === "runs" && (
          <>
            <p>
              <strong>Runs</strong> try thousands of filter and sizing
              combinations against your bet history to find the highest, most
              consistent ROI.
            </p>
            <p>
              Click <em>Run now</em> for sensible defaults (ensemble search,
              2000 trials, CPCV testing, all bets, Telegram pings on) or
              <em> New run…</em> to tweak.
            </p>
            <p className="text-amber-600 dark:text-amber-400 text-xs">
              With ~1k bets, even the best strategies have a believable range of
              about ±2–4% — trust the range, not the headline number.
            </p>
          </>
        )}
        {scope === "schedules" && (
          <>
            <p>
              <strong>Schedules</strong> fire a saved run configuration on a
              cadence (e.g. <em>daily 03:00</em>) — useful for tracking how the
              optimal config drifts as new bets settle.
            </p>
            <p>
              <em>Run now</em> on any schedule fires once without touching the
              next-fire timer. Toggle the checkbox to pause/resume.
            </p>
          </>
        )}
        {scope === "strategies" && (
          <>
            <p>
              <strong>Strategies</strong> are saved filter + sizing
              recommendations, promoted from trials. Use them as a quick filter
              on <em>/value-bets</em> and <em>/bets</em>, or designate them as
              auto-place gates from <em>Settings → Active strategies</em>.
            </p>
            <p>
              <strong>Drift</strong> flags strategies whose recent live ROI has
              fallen outside the expected range from when they were promoted —
              worth investigating before relying on the strategy further.
            </p>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
