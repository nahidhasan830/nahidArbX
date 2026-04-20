"use client";

import { Toaster } from "sonner";
import { BacktestSpreadsheet } from "@/components/backtest/BacktestSpreadsheet";
import { AppShell } from "@/components/nav/AppShell";

export default function BacktestPage() {
  return (
    <AppShell
      title="Backtest"
      titleBadge={
        <span className="text-[10px] text-muted-foreground ml-2">
          Value-bet spreadsheet · inline outcomes · automatic settlement
        </span>
      }
      edgeToEdge
    >
      <Toaster theme="dark" position="bottom-right" />
      <div className="flex flex-col" style={{ height: "calc(100vh - 3rem)" }}>
        <main className="flex-1 min-h-0 p-2 flex flex-col">
          <BacktestSpreadsheet />
        </main>
      </div>
    </AppShell>
  );
}
