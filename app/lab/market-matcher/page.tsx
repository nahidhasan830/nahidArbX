"use client";

/**
 * Market Matcher — unified diagnostics spreadsheet.
 *
 * Single-table view showing all diagnostic signals (unmapped markets +
 * IP-deviation anomalies) in one place. Replaces the previous 3-tab
 * layout (X-Ray / Unmapped / Anomalies) with a BetsHistory-style
 * spreadsheet: health stats in the header, filters in the toolbar,
 * and a unified DataTable with expandable detail panels.
 */

import { AppShell } from "@/components/nav/AppShell";
import { MarketDiagnosticsSpreadsheet } from "@/components/lab/market-matcher/MarketDiagnosticsSpreadsheet";

export default function MarketMatcherPage() {
  return (
    <AppShell title="Market Diagnostics" edgeToEdge>
      <div className="flex flex-col flex-1 min-h-0 p-4 lg:p-6">
        <MarketDiagnosticsSpreadsheet />
      </div>
    </AppShell>
  );
}
