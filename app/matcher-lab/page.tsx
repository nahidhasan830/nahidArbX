"use client";

import { AppShell } from "@/components/nav/AppShell";
import { DiagnosticsTab } from "@/components/diagnostics";

export default function MatcherLabPage() {
  return (
    <AppShell title="Matcher Lab" edgeToEdge>
      <div className="flex-1 min-h-0 p-2">
        <DiagnosticsTab />
      </div>
    </AppShell>
  );
}
