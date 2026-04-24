"use client";

/**
 * AlphaSearch workbench — Runs list view.
 *
 * Each row links into `/lab/alphasearch/[id]` for the per-run detail with
 * Pareto scatter + trial table.
 */

import { AppShell } from "@/components/nav/AppShell";
import { Badge } from "@/components/ui/badge";
import { HelpBanner } from "@/components/lab/HelpBanner";
import { RunsTable } from "@/components/lab/alphasearch/RunsTable";
import { SubmitRunSheet } from "@/components/lab/alphasearch/SubmitRunSheet";

export default function AlphaSearchPage() {
  return (
    <AppShell
      title="AlphaSearch"
      titleBadge={
        <Badge
          variant="outline"
          className="ml-2 text-[10px] uppercase tracking-wide"
        >
          Lab · Phase 1
        </Badge>
      }
      actions={<SubmitRunSheet />}
    >
      <div className="max-w-[1200px] space-y-4">
        <HelpBanner id="alphasearch-runs" title="How to use AlphaSearch">
          <p>
            <strong>What it does:</strong> sweeps through configurations of
            filters + sizing rules and tells you which would have produced the
            highest, most consistent ROI on your historical bets.
          </p>
          <p>
            <strong>How to use:</strong> click <em>New run</em> to submit a
            sweep. Default settings (2,000 trials, ensemble sampler, CPCV) are
            sensible — just hit <em>Start</em>. The Python sidecar runs in the
            background; this page polls every 5 seconds for progress.
          </p>
          <p>
            <strong>What you get:</strong> after the run completes, click into
            it to see the Pareto frontier (best trade-offs of ROI vs drawdown)
            and inspect each trial&apos;s exact configuration. In Phase 3 you
            can promote a winning config to a live strategy.
          </p>
          <p className="text-amber-600 dark:text-amber-400">
            <strong>Honesty note:</strong> with ~1k bets, even the best
            configurations have ±2-4% confidence intervals. Trust the
            confidence-interval band, not the point estimate.
          </p>
        </HelpBanner>

        <RunsTable />
      </div>
    </AppShell>
  );
}
