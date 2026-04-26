"use client";

import { Toaster } from "sonner";
import { BetsHistorySpreadsheet } from "@/components/bets-history/BetsHistorySpreadsheet";
import { BetsHistoryHeader } from "@/components/bets-history/BetsHistoryHeader";
import { AppShell } from "@/components/nav/AppShell";

export default function BetsPage() {
  return (
    <AppShell title="Bets" titleBadge={<BetsHistoryHeader />} edgeToEdge>
      <Toaster theme="dark" position="bottom-right" />
      <div
        className="flex flex-col overflow-hidden"
        style={{ height: "calc(100vh - 3rem)" }}
      >
        <main className="flex-1 p-2 min-h-0 flex flex-col overflow-auto">
          <BetsHistorySpreadsheet />
        </main>
      </div>
    </AppShell>
  );
}
