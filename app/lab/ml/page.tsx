"use client";

import { AppShell } from "@/components/nav/AppShell";
import { MLPipelineDashboard } from "@/components/lab/ml/MLPipelineDashboard";

export default function MLLabPage() {
  return (
    <AppShell title="Bet Optimizer" edgeToEdge>
      <MLPipelineDashboard />
    </AppShell>
  );
}
