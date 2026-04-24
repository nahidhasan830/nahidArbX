"use client";

/**
 * AlphaSearch workbench — Runs / Schedules / Strategies tabs.
 *
 * Runs:        list of optimization runs; each row links into per-run detail
 *              with Pareto scatter + trial table.
 * Schedules:   recurring runs (cron-style, preset frequencies).
 * Strategies:  configurations promoted from trials → live in the value detector.
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
import { StrategiesTable } from "@/components/lab/alphasearch/StrategiesTable";

type TabKey = "runs" | "schedules" | "strategies";

export default function AlphaSearchPage() {
  const [tab, setTab] = React.useState<TabKey>("runs");

  return (
    <AppShell
      title="AlphaSearch"
      titleBadge={
        <Badge
          variant="outline"
          className="ml-2 text-[10px] uppercase tracking-wide"
        >
          Lab · Phase 3
        </Badge>
      }
      actions={
        tab === "runs" ? (
          <SubmitRunSheet />
        ) : tab === "schedules" ? (
          <CreateScheduleSheet />
        ) : null
      }
    >
      <div className="max-w-[1200px] space-y-4">
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
          <TabsList className="h-8">
            <TabsTrigger value="runs" className="text-[11px]">
              Runs
            </TabsTrigger>
            <TabsTrigger value="schedules" className="text-[11px]">
              Schedules
            </TabsTrigger>
            <TabsTrigger value="strategies" className="text-[11px]">
              Strategies
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

          <TabsContent value="strategies" className="space-y-4 mt-4">
            <HelpBanner id="alphasearch-strategies" title="How strategies work">
              <p>
                A strategy is a configuration promoted from an optimizer trial.
                Open any completed run, click into a trial, and use{" "}
                <strong>Promote to strategy</strong>. It starts as a{" "}
                <em>candidate</em>; activate it from this tab to make it live.
              </p>
              <p>
                Once <em>live</em>, the value detector checks every detected bet
                against the strategy&apos;s filters. Matching bets are tagged
                with the strategy id so the live ROI / win rate / CLV are
                tracked separately and shown next to the OOS estimate.
              </p>
              <p>
                The <strong>Drift</strong> column flags strategies whose live
                ROI has fallen outside the OOS confidence band — a signal the
                edge has decayed and you should investigate or pause.
              </p>
            </HelpBanner>

            <StrategiesTable />
          </TabsContent>
        </Tabs>
      </div>
    </AppShell>
  );
}
