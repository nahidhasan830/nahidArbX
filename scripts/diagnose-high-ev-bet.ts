/**
 * Diagnostic: Investigate extremely high EV bets
 *
 * Usage: npx tsx scripts/diagnose-high-ev-bet.ts [betId]
 *   - Without argument: Finds the top 10 highest EV bets in the DB
 *   - With betId: Deep-dives into a specific bet, showing:
 *       1. Full EV calculation breakdown
 *       2. Commission adjustment trace
 *       3. Devig method cross-check
 *       4. Per-provider odds snapshot (from oddsMovement JSONB)
 *       5. Timing analysis for staleness
 */

import { desc, eq, sql } from "drizzle-orm";
import { ensureDbReady, db } from "../lib/db/client";
import { bets } from "../lib/db/schema";
import { adjustOddsForCommission } from "../lib/shared/commission";
import { PROVIDER_REGISTRY } from "../lib/providers/registry";

const EV_CALC_SQL = sql`
  ((("soft_odds" - 1) * (1 - "soft_commission_pct" / 100) + 1) * "sharp_true_prob" - 1) * 100
`;

async function main() {
  await ensureDbReady();

  const betIdArg = process.argv[2];

  if (betIdArg) {
    await diagnoseOne(betIdArg);
  } else {
    await listTop();
  }

  process.exit(0);
}

async function listTop() {
  const top = await db
    .select({
      id: bets.id,
      eventId: bets.eventId,
      homeTeam: bets.homeTeam,
      awayTeam: bets.awayTeam,
      atomLabel: bets.atomLabel,
      sharpProvider: bets.sharpProvider,
      sharpOdds: bets.sharpOdds,
      sharpTrueProb: bets.sharpTrueProb,
      softProvider: bets.softProvider,
      softCommissionPct: bets.softCommissionPct,
      softOdds: bets.softOdds,
      evPct: EV_CALC_SQL.mapWith(Number),
      firstSeenAt: bets.firstSeenAt,
      lastSeenAt: bets.lastSeenAt,
      tickCount: bets.tickCount,
      placedAt: bets.placedAt,
    })
    .from(bets)
    .orderBy(desc(EV_CALC_SQL))
    .limit(10);

  if (top.length === 0) {
    console.log("No bets found in the database.");
    return;
  }

  console.log("Top 10 bets by EV%:\n");
  for (const [i, b] of top.entries()) {
    console.log(
      `#${i + 1} EV=${b.evPct.toFixed(2)}% | ${b.homeTeam} vs ${b.awayTeam} | ${b.atomLabel}`,
    );
    console.log(
      `    sharp: ${b.sharpProvider} @ ${b.sharpOdds} (trueProb=${(b.sharpTrueProb * 100).toFixed(3)}%)`,
    );
    console.log(
      `    soft:  ${b.softProvider} @ ${b.softOdds} (comm=${b.softCommissionPct}%)`,
    );
    console.log(
      `    id: ${b.id} | ticks: ${b.tickCount} | firstSeen: ${b.firstSeenAt} | placed: ${b.placedAt ?? "no"}`,
    );
    console.log();
  }

  console.log(
    "To deep-dive a specific bet: npx tsx scripts/diagnose-high-ev-bet.ts <id>",
  );
}

async function diagnoseOne(betId: string) {
  const [bet] = await db.select().from(bets).where(eq(bets.id, betId)).limit(1);

  if (!bet) {
    console.log(`Bet not found: ${betId}`);
    return;
  }

  console.log("══════════════════════════════════════════════════════════");
  console.log("  HIGH EV BET DIAGNOSTIC");
  console.log("══════════════════════════════════════════════════════════\n");

  // ── 1. Basic info ──
  console.log("── 1. Bet Identity ──");
  console.log(`  ID:            ${bet.id}`);
  console.log(`  Match:         ${bet.homeTeam} vs ${bet.awayTeam}`);
  console.log(`  Market:        ${bet.familyId} · ${bet.atomLabel}`);
  console.log(`  Competition:   ${bet.competition ?? "N/A"}`);
  console.log(`  Start Time:    ${bet.eventStartTime}`);
  console.log(`  First Seen:    ${bet.firstSeenAt}`);
  console.log(`  Last Seen:     ${bet.lastSeenAt}`);
  console.log(`  Tick Count:    ${bet.tickCount}`);
  console.log(`  Placed:        ${bet.placedAt ?? "NO"}`);
  console.log();

  // ── 2. EV Calculation Breakdown ──
  console.log("── 2. EV Calculation Breakdown ──");

  const commissionRate = bet.softCommissionPct / 100;
  const adjustedSoftOdds = adjustOddsForCommission(
    bet.softOdds,
    bet.softCommissionPct,
  );
  const impliedProb = 1 / adjustedSoftOdds;
  const edge = adjustedSoftOdds * bet.sharpTrueProb - 1;
  const evPct = edge * 100;

  console.log(`  Raw soft odds:        ${bet.softOdds}`);
  console.log(`  Commission:           ${bet.softCommissionPct}%`);
  console.log(`  Commission rate:      ${commissionRate}`);
  console.log(
    `  Adjusted soft odds:   ${adjustedSoftOdds.toFixed(4)}  (= 1 + (${bet.softOdds} - 1) * (1 - ${commissionRate}))`,
  );
  console.log(`  Implied prob (soft):  ${(impliedProb * 100).toFixed(4)}%`);
  console.log();
  console.log(`  Sharp provider:       ${bet.sharpProvider}`);
  console.log(`  Raw sharp odds:       ${bet.sharpOdds}`);
  console.log(
    `  Sharp trueProb:       ${bet.sharpTrueProb}  (${(bet.sharpTrueProb * 100).toFixed(3)}%)`,
  );
  console.log(`  True odds (1/tp):     ${(1 / bet.sharpTrueProb).toFixed(4)}`);
  console.log();
  console.log(`  EV = adjSoftOdds * trueProb - 1`);
  console.log(
    `     = ${adjustedSoftOdds.toFixed(4)} * ${bet.sharpTrueProb} - 1`,
  );
  console.log(
    `     = ${(adjustedSoftOdds * bet.sharpTrueProb).toFixed(4)} - 1`,
  );
  console.log(`     = ${edge.toFixed(6)}`);
  console.log(`  EV%                   = ${evPct.toFixed(2)}%`);
  console.log();

  // ── 3. Commission sanity check ──
  console.log("── 3. Commission Sanity Check ──");
  const registryCommission =
    PROVIDER_REGISTRY[bet.softProvider as keyof typeof PROVIDER_REGISTRY]
      ?.commissionPct ?? null;
  console.log(`  Provider:                ${bet.softProvider}`);
  console.log(
    `  Registry commission%:    ${registryCommission ?? "UNKNOWN PROVIDER"}`,
  );
  console.log(`  DB commission%:           ${bet.softCommissionPct}`);
  if (
    registryCommission !== null &&
    registryCommission !== bet.softCommissionPct
  ) {
    console.log(
      `  ⚠️  MISMATCH! Registry says ${registryCommission}%, DB has ${bet.softCommissionPct}%`,
    );
  } else if (registryCommission !== null) {
    console.log(`  ✅ Registry and DB match`);
  }
  console.log();

  // ── 4. Vig-removal manual cross-check ──
  console.log("── 4. Vig-Removal Cross-Check ──");
  const rawSharpProb = 1 / bet.sharpOdds;
  const vigRatio = bet.sharpTrueProb / rawSharpProb;
  const _totalImplied = 1 / bet.sharpOdds; // We don't have all atoms' odds, approximate
  console.log(
    `  Raw sharp implied prob:  ${(rawSharpProb * 100).toFixed(4)}%  (1 / ${bet.sharpOdds})`,
  );
  console.log(
    `  Stored trueProb:         ${(bet.sharpTrueProb * 100).toFixed(4)}%`,
  );
  console.log(
    `  De-vig ratio:            ${vigRatio.toFixed(4)}  (>1 means vig was removed, increasing prob)`,
  );
  console.log(
    `  Implied vig (approx):    ${(((1 / rawSharpProb - bet.sharpTrueProb) / (1 / rawSharpProb)) * 100).toFixed(2)}%`,
  );
  console.log(
    `  Interpretation: The trueProb is the WORST-CASE (highest prob) across`,
  );
  console.log(
    `  4 devig methods (Multiplicative, Additive, Power, Shin). If trueProb`,
  );
  console.log(
    `  is much higher than raw implied, one of these methods diverged.`,
  );
  console.log();

  // ── 5. OddsMovement snapshot ──
  console.log("── 5. Per-Provider Odds Snapshot (oddsMovement JSONB) ──");
  const movement = bet.oddsMovement;
  if (!movement) {
    console.log("  (no oddsMovement data for this bet)");
  } else if (typeof movement === "object" && !Array.isArray(movement)) {
    const movementObj = movement as Record<string, unknown>;
    const keys = Object.keys(movementObj);
    if (keys.length === 0) {
      console.log("  (empty oddsMovement)");
    } else {
      const firstVal = movementObj[keys[0]];
      if (
        firstVal &&
        typeof firstVal === "object" &&
        "provider" in firstVal &&
        "troughOdds" in firstVal
      ) {
        // New format: Record<string, OddsMovementData>
        for (const [provider, data] of Object.entries(
          movementObj as Record<
            string,
            {
              provider: string;
              openingOdds: number | null;
              peakOdds: number;
              troughOdds: number;
              totalTicks: number;
              sparkline: [number, number][];
            }
          >,
        )) {
          console.log(`  [${provider}]`);
          console.log(`    Opening: ${data.openingOdds ?? "N/A"}`);
          console.log(`    Peak:    ${data.peakOdds}`);
          console.log(`    Trough:  ${data.troughOdds}`);
          console.log(`    Ticks:   ${data.totalTicks}`);
          console.log(
            `    Range:   ${data.troughOdds} - ${data.peakOdds}  (spread: ${(data.peakOdds - data.troughOdds).toFixed(2)})`,
          );
          if (data.sparkline?.length > 0) {
            const last = data.sparkline[data.sparkline.length - 1];
            const firstS = data.sparkline[0];
            const drift =
              last[1] !== firstS[1]
                ? `(${(((last[1] - firstS[1]) / firstS[1]) * 100).toFixed(2)}% from start)`
                : "(unchanged)";
            console.log(`    Last:    ${last[1]}  ${drift}`);
          }
        }
      } else {
        // Legacy format or unexpected - dump it
        console.log(`  (legacy/unexpected format with ${keys.length} keys)`);
        console.log(`  Keys: ${keys.join(", ")}`);
      }
    }
  }
  console.log();

  // ── 6. Staleness analysis ──
  console.log("── 6. Timing / Staleness Analysis ──");
  const firstSeen = new Date(bet.firstSeenAt).getTime();
  const lastSeen = new Date(bet.lastSeenAt).getTime();
  const lifespan = (lastSeen - firstSeen) / 1000;
  console.log(`  Detection lifespan:  ${lifespan.toFixed(0)}s`);
  console.log(`  Tick count:          ${bet.tickCount}`);
  console.log(
    `  Avg interval:        ${(lifespan / Math.max(bet.tickCount - 1, 1)).toFixed(0)}s between ticks`,
  );
  console.log(
    `  Active detection window: ${bet.firstSeenAt} → ${bet.lastSeenAt}`,
  );
  console.log();

  // ── 7. Root cause analysis ──
  console.log("── 7. Root Cause Analysis ──");
  const issues: string[] = [];

  // Check: Is sharp odds unusually close to 1.00 (almost certain)?
  if (bet.sharpOdds < 1.5) {
    issues.push(
      `Sharp odds very low (${bet.sharpOdds}) — heavy favorite, any soft mispricing is amplified`,
    );
  }

  // Check: Is sharp trueProb very different from raw sharp implied?
  const rawSharpImp = 1 / bet.sharpOdds;
  const trueProbDiff = Math.abs(bet.sharpTrueProb - rawSharpImp);
  if (trueProbDiff > 0.05) {
    issues.push(
      `Large devig adjustment: raw implied=${(rawSharpImp * 100).toFixed(2)}%, trueProb=${(bet.sharpTrueProb * 100).toFixed(2)}% (diff=${(trueProbDiff * 100).toFixed(2)}pp)`,
    );
  }

  // Check: Is soft odds very different from sharp odds?
  const oddsRatio = bet.softOdds / bet.sharpOdds;
  if (oddsRatio > 1.5) {
    issues.push(
      `Soft odds (${bet.softOdds}) are ${((oddsRatio - 1) * 100).toFixed(0)}% higher than sharp (${bet.sharpOdds}) — huge mispricing gap`,
    );
  }

  // Check: Is commission wrong for this provider?
  if (
    registryCommission !== null &&
    registryCommission !== bet.softCommissionPct
  ) {
    issues.push(
      `Commission mismatch: provider "${bet.softProvider}" has ${registryCommission}% in registry but ${bet.softCommissionPct}% on DB row`,
    );
  }

  // Check: High tick count with long lifespan = stale sharp?
  if (bet.tickCount > 20 && lifespan > 120) {
    issues.push(
      `Long detection lifespan (${lifespan.toFixed(0)}s) with ${bet.tickCount} ticks — sharp may have been stale`,
    );
  }

  // Check: EV what-if without commission
  const evNoCommBump =
    bet.softOdds * bet.sharpTrueProb > 1.5
      ? `Without commission adjustment, raw soft * trueProb = ${(bet.softOdds * bet.sharpTrueProb).toFixed(4)} (${((bet.softOdds * bet.sharpTrueProb - 1) * 100).toFixed(1)}% EV)`
      : null;
  if (evNoCommBump) {
    issues.push(evNoCommBump);
  }

  if (issues.length === 0) {
    console.log(
      "  No obvious anomalies detected. The bet may be genuinely high EV.",
    );
  } else {
    for (const issue of issues) {
      console.log(`  ${issue}`);
    }
  }
  console.log();

  console.log("══════════════════════════════════════════════════════════");
  console.log("  DIAGNOSTIC COMPLETE");
  console.log("══════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("Diagnostic failed:", err);
  process.exit(1);
});
