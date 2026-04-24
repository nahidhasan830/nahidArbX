"use client";

/**
 * AlphaSearch workbench — Runs + Schedules tabs.
 *
 * Each Runs row links into `/lab/alphasearch/[id]` for the per-run detail
 * with Pareto scatter + trial table.
 */

import * as React from "react";
import { AppShell } from "@/components/nav/AppShell";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HelpBanner } from "@/components/lab/HelpBanner";
import { RunsTable } from "@/components/lab/alphasearch/RunsTable";
import { SubmitRunSheet } from "@/components/lab/alphasearch/SubmitRunSheet";
import { SchedulesTable } from "@/components/lab/alphasearch/SchedulesTable";
import { CreateScheduleSheet } from "@/components/lab/alphasearch/CreateScheduleSheet";

export default function AlphaSearchPage() {
  const [tab, setTab] = React.useState<"runs" | "schedules">("runs");

  return (
    <AppShell
      title="AlphaSearch"
      titleBadge={
        <Badge
          variant="outline"
          className="ml-2 text-[10px] uppercase tracking-wide"
        >
          Lab · Phase 2
        </Badge>
      }
      actions={tab === "runs" ? <SubmitRunSheet /> : <CreateScheduleSheet />}
    >
      <div className="max-w-[1200px] space-y-4">
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as "runs" | "schedules")}
        >
          <TabsList className="h-8">
            <TabsTrigger value="runs" className="text-[11px]">
              Runs
            </TabsTrigger>
            <TabsTrigger value="schedules" className="text-[11px]">
              Schedules
            </TabsTrigger>
          </TabsList>

          <TabsContent value="runs" className="space-y-4 mt-4">
            <HelpBanner id="alphasearch-runs" title="How to use AlphaSearch">
              <p>
                <strong>What it does:</strong> sweeps through configurations of
                filters + sizing rules and tells you which would have produced
                the highest, most consistent ROI on your historical bets.
              </p>
              <p>
                <strong>How to use:</strong> click <em>New run</em> to submit a
                sweep. Default settings (2,000 trials, ensemble sampler, CPCV)
                are sensible — just hit <em>Start</em>. The Python sidecar runs
                in the background; this page polls every 5 seconds for progress.
              </p>
              <p>
                <strong>What you get:</strong> after the run completes, click
                into it to see the Pareto frontier and inspect each trial&apos;s
                exact configuration.
              </p>
              <p className="text-amber-600 dark:text-amber-400">
                <strong>Honesty note:</strong> with ~1k bets, even the best
                configurations have ±2-4% confidence intervals. Trust the
                confidence-interval band, not the point estimate.
              </p>
            </HelpBanner>

            <RunsTable />
          </TabsContent>

          <TabsContent value="schedules" className="space-y-4 mt-4">
            <HelpBanner id="alphasearch-schedules" title="How schedules work">
              <p>
                A schedule is a saved configuration that fires on its own
                cadence (e.g. <em>daily at 03:00</em>). Each fire creates a
                fresh run on the latest bet data — useful for tracking how the
                optimal config evolves as new bets settle.
              </p>
              <p>
                <strong>Run now</strong> on any schedule = manual fire using
                that schedule&apos;s exact config, without affecting the
                next-fire time. Useful for testing.
              </p>
              <p>
                Toggle the checkbox to pause/resume a schedule without losing
                its history. Re-enabling recomputes the next fire so no
                immediate flood after long pauses.
              </p>
            </HelpBanner>

            <SchedulesTable />
          </TabsContent>
        </Tabs>
      </div>
    </AppShell>
  );
}
