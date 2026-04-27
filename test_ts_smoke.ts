import { computeFlatMetrics, computeKellyQMetrics } from "./lib/bets-history/metrics";
import { settlementPnl } from "./lib/bets-history/derive";
import { ValueBetRow } from "./lib/bets-history/types";

const mockRows = [
  { outcome: "won", softOdds: 2.0, softCommissionPct: 2.0 },
  { outcome: "half_won", softOdds: 2.0, softCommissionPct: 2.0 },
  { outcome: "lost", softOdds: 2.0, softCommissionPct: 2.0 },
  { outcome: "half_lost", softOdds: 2.0, softCommissionPct: 2.0 },
  { outcome: "void", softOdds: 2.0, softCommissionPct: 2.0 },
] as unknown as ValueBetRow[];

console.log("TypeScript PNLs:");
const pnls = mockRows.map(r => settlementPnl(r, 100));
console.log(pnls);

const totalPnl = pnls.reduce((a,b) => a+b, 0);
console.log("TypeScript Total PNL:", totalPnl);

const flat = computeFlatMetrics(mockRows);
console.log("TypeScript Win Rate:", flat.winRate * 100, "%");

