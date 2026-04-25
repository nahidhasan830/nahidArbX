"use client";

/**
 * Optimisation unified workbench.
 *
 * Single-page scope-switched layout replacing the old Tabs shell:
 *   - Runs       — list of optimization runs with live progress
 *   - Schedules  — recurring runs
 *   - Strategies — configurations promoted from trials → live in the detector
 *
 * Scope is URL-driven (`?scope=schedules`) so deep-links / back button work.
 * The top command bar reuses the `h-7 / px-3 py-1.5 / bg-muted/40 / text-[11px]`
 * vocabulary from components/spreadsheet/SpreadsheetToolbar.tsx.
 */

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { HelpCircle, List, Repeat, Target } from "lucide-react";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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

type Scope = "runs" | "schedules" | "strategies";
const SCOPES: Scope[] = ["runs", "schedules", "strategies"];

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

  // Keyboard scope switcher: ⌘1 / ⌘2 / ⌘3
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "1") {
        e.preventDefault();
        setScope("runs");
      } else if (e.key === "2") {
        e.preventDefault();
        setScope("schedules");
      } else if (e.key === "3") {
        e.preventDefault();
        setScope("strategies");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  return (
    <AppShell
      title="Optimisation"
      edgeToEdge
      actions={<TopActions scope={scope} />}
    >
      <div className="flex flex-col gap-4 p-4 lg:p-6">
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

// ── Command bar (scope switcher + help popover) ──────────────────────────

function CommandBar({
  scope,
  onScopeChange,
}: {
  scope: Scope;
  onScopeChange: (s: Scope) => void;
}) {
  return (
    <div className="border border-border rounded-md bg-muted/40 px-3 py-1.5 flex items-center gap-1.5 overflow-x-auto">
      <ToggleGroup
        type="single"
        value={scope}
        onValueChange={(v) => {
          if (v && SCOPES.includes(v as Scope)) onScopeChange(v as Scope);
        }}
        className="flex items-center gap-1"
      >
        <ToggleGroupItem
          value="runs"
          className="h-7 px-3 text-[11px] gap-1.5 data-[state=on]:bg-background data-[state=on]:shadow-sm"
        >
          <List className="size-3" /> Runs
          <kbd className="ml-1 text-[10px] text-muted-foreground">⌘1</kbd>
        </ToggleGroupItem>
        <ToggleGroupItem
          value="schedules"
          className="h-7 px-3 text-[11px] gap-1.5 data-[state=on]:bg-background data-[state=on]:shadow-sm"
        >
          <Repeat className="size-3" /> Schedules
          <kbd className="ml-1 text-[10px] text-muted-foreground">⌘2</kbd>
        </ToggleGroupItem>
        <ToggleGroupItem
          value="strategies"
          className="h-7 px-3 text-[11px] gap-1.5 data-[state=on]:bg-background data-[state=on]:shadow-sm"
        >
          <Target className="size-3" /> Strategies
          <kbd className="ml-1 text-[10px] text-muted-foreground">⌘3</kbd>
        </ToggleGroupItem>
      </ToggleGroup>

      <div className="flex-1" />

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
          className="h-7 px-2 text-[11px] text-muted-foreground gap-1.5"
        >
          <HelpCircle className="size-3" /> Help
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[360px] text-[11px] leading-relaxed space-y-2"
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
              <em>New run…</em> to tweak.
            </p>
            <p className="text-amber-600 dark:text-amber-400 text-[10px]">
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
              <strong>Strategies</strong> are trial configurations promoted from
              runs. They start as <em>candidate</em>; activate to make live —
              the value detector consults them on every tick.
            </p>
            <p>
              <strong>Drift</strong> flags strategies whose live ROI has fallen
              outside the expected range from when they were promoted —
              investigate or pause.
            </p>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
