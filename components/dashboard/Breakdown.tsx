"use client";

import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export interface BreakdownRow {
  key: string;
  label: string;
  bets: number;
  stake: number;
  profit: number;
  roiPct: number;
  avgClvPct: number | null;
}

interface Tab {
  key: string;
  label: string;
  rows: BreakdownRow[];
}

export function Breakdown({
  tabs,
  currency = "BDT",
}: {
  tabs: Tab[];
  currency?: string;
}) {
  const [active, setActive] = useState(tabs[0]?.key ?? "");
  const rows = tabs.find((t) => t.key === active)?.rows ?? [];

  const maxStake = Math.max(1, ...rows.map((r) => r.stake));

  return (
    <div>
      <div className="flex items-center gap-1 mb-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActive(t.key)}
            className={cn(
              "px-2.5 py-1 text-xs rounded-md transition-colors",
              active === t.key
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto border border-border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Segment</TableHead>
              <TableHead className="text-right">Bets</TableHead>
              <TableHead className="text-right">Stake</TableHead>
              <TableHead className="text-right">Profit</TableHead>
              <TableHead className="text-right">ROI</TableHead>
              <TableHead className="text-right">Avg CLV</TableHead>
              <TableHead className="w-[180px]">Volume</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="text-center text-muted-foreground text-sm py-6"
                >
                  No bets in this segment yet.
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell className="font-medium text-sm">{r.label}</TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {r.bets}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {formatMoney(r.stake, currency)}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right text-sm tabular-nums",
                    r.profit > 0 && "text-emerald-500",
                    r.profit < 0 && "text-danger",
                  )}
                >
                  {formatSignedMoney(r.profit, currency)}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right text-sm tabular-nums font-medium",
                    r.roiPct > 0 && "text-emerald-500",
                    r.roiPct < 0 && "text-danger",
                  )}
                >
                  {r.roiPct.toFixed(2)}%
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right text-sm tabular-nums",
                    r.avgClvPct !== null &&
                      r.avgClvPct > 0 &&
                      "text-emerald-500",
                    r.avgClvPct !== null && r.avgClvPct < 0 && "text-danger",
                  )}
                >
                  {r.avgClvPct === null
                    ? "—"
                    : `${r.avgClvPct > 0 ? "+" : ""}${r.avgClvPct.toFixed(2)}%`}
                </TableCell>
                <TableCell>
                  <VolumeBar pct={(r.stake / maxStake) * 100} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function VolumeBar({ pct }: { pct: number }) {
  return (
    <div className="relative h-1.5 w-full bg-muted rounded-full overflow-hidden">
      <div
        className="absolute inset-y-0 left-0 bg-primary/70 rounded-full"
        style={{ width: `${Math.max(2, pct)}%` }}
      />
    </div>
  );
}

function formatMoney(v: number, currency: string): string {
  return `${currency} ${v.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

function formatSignedMoney(v: number, currency: string): string {
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  const abs = Math.abs(v).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return `${sign}${currency} ${abs}`;
}
