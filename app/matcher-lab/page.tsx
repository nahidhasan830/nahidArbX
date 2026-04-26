"use client";

import { AppShell } from "@/components/nav/AppShell";
import { MatcherLab } from "@/components/matcher-lab";

export default function MatcherLabPage() {
  return (
    <AppShell title="Matcher Lab" edgeToEdge>
      <div className="flex-1 min-h-0 p-2">
        <MatcherLab />
      </div>
    </AppShell>
  );
}
