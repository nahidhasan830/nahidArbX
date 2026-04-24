/**
 * Deduplicate the `bets` table.
 *
 * Problem: Migration 0016 (merge value_bets + placed_bets → bets) preserved
 * the legacy `vb-${eventId}-${familyId}-${atomId}-${softProvider}-${timestamp}`
 * IDs from the old value_bets table. Post-migration, the detector emits the
 * deterministic ID `${eventId}|${familyId}|${atomId}`, creating new rows that
 * don't collide with the legacy ones. Result: the same selection has 1..N
 * `vb-*` rows + (possibly) 1 deterministic row.
 *
 * This script groups ALL rows by (event_id, family_id, atom_id) and:
 *   1. Picks a survivor per group.
 *        - If any row in the group is placed (placed_at IS NOT NULL), prefer
 *          it (preserves placed_at, provider, stake, odds, provider_ticket_id,
 *          mode, outcome, pnl, settled_*). If multiple placed rows exist,
 *          prefer non-cancelled, then earliest placed_at.
 *        - Otherwise pick the row with the highest effective payout
 *          (1 + (softOdds-1) * (1-commission/100)) * sharpTrueProb.
 *   2. Aggregates onto the survivor:
 *        - first_seen_at = MIN(first_seen_at)
 *        - last_seen_at  = MAX(last_seen_at)
 *        - tick_count    = SUM(tick_count)
 *        - created_at    = MIN(created_at)
 *        - Soft side (soft_provider, soft_odds, soft_commission_pct) upgraded
 *          to the group's best-payout values if better than the survivor's.
 *   3. Rekeys the survivor's `id` to `${eventId}|${familyId}|${atomId}` via
 *      raw SQL (Drizzle's update helper won't touch the PK).
 *   4. Deletes the other rows in the group.
 *
 * Uses a standalone pg Pool (mirrors client.ts connection logic) to avoid the
 * top-level await incompatibility when run under tsx/CJS.
 *
 * Run: DATABASE_URL=... npx tsx scripts/dedupe-value-bets.ts [--dry-run]
 */

import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import { bets } from "../lib/db/schema";
import { inArray, sql } from "drizzle-orm";

const dryRun = process.argv.includes("--dry-run");

interface BetRowFull {
  id: string;
  eventId: string;
  familyId: string;
  atomId: string;
  softProvider: string;
  softCommissionPct: number;
  softOdds: number;
  sharpTrueProb: number;
  firstSeenAt: string;
  lastSeenAt: string;
  tickCount: number;
  createdAt: string;
  placedAt: string | null;
  outcome: string;
}

function effectivePayout(
  softOdds: number,
  commissionPct: number,
  sharpTrueProb: number,
): number {
  const payout = 1 + (softOdds - 1) * (1 - commissionPct / 100);
  return payout * sharpTrueProb;
}

function deterministicId(
  eventId: string,
  familyId: string,
  atomId: string,
): string {
  return `${eventId}|${familyId}|${atomId}`;
}

/**
 * Pick the survivor row from a duplicate group.
 *   - Prefer placed rows (placed_at IS NOT NULL); tiebreak non-cancelled then earliest placed_at.
 *   - Otherwise pick the row with highest effective payout.
 */
function pickSurvivor(group: BetRowFull[]): {
  survivor: BetRowFull;
  kind: "placed" | "unplaced";
} {
  const placed = group.filter((r) => r.placedAt != null);
  if (placed.length > 0) {
    const sorted = [...placed].sort((a, b) => {
      const aCancelled = a.outcome === "cancelled" ? 1 : 0;
      const bCancelled = b.outcome === "cancelled" ? 1 : 0;
      if (aCancelled !== bCancelled) return aCancelled - bCancelled;
      return (a.placedAt ?? "").localeCompare(b.placedAt ?? "");
    });
    return { survivor: sorted[0]!, kind: "placed" };
  }
  const best = group.reduce((a, b) =>
    effectivePayout(a.softOdds, a.softCommissionPct, a.sharpTrueProb) >
    effectivePayout(b.softOdds, b.softCommissionPct, b.sharpTrueProb)
      ? a
      : b,
  );
  return { survivor: best, kind: "unplaced" };
}

function pickBestByPayout(group: BetRowFull[]): BetRowFull {
  return group.reduce((a, b) =>
    effectivePayout(a.softOdds, a.softCommissionPct, a.sharpTrueProb) >
    effectivePayout(b.softOdds, b.softCommissionPct, b.sharpTrueProb)
      ? a
      : b,
  );
}

async function buildPool(): Promise<Pool> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  const instance = process.env.CLOUD_SQL_INSTANCE;
  if (!instance) {
    return new Pool({ connectionString: databaseUrl, max: 5 });
  }

  const url = new URL(databaseUrl);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const database = url.pathname.slice(1);

  const connector = new Connector();
  const clientOpts = await connector.getOptions({
    instanceConnectionName: instance,
    ipType: IpAddressTypes.PUBLIC,
  });
  return new Pool({ ...clientOpts, user, password, database, max: 5 });
}

async function main(): Promise<void> {
  const pool = await buildPool();
  const db = drizzle(pool, { schema: { bets }, casing: "snake_case" });

  console.log(dryRun ? "=== DRY RUN ===" : "=== LIVE RUN ===");

  console.log("Fetching all bets...");
  const rows = (await db
    .select({
      id: bets.id,
      eventId: bets.eventId,
      familyId: bets.familyId,
      atomId: bets.atomId,
      softProvider: bets.softProvider,
      softCommissionPct: bets.softCommissionPct,
      softOdds: bets.softOdds,
      sharpTrueProb: bets.sharpTrueProb,
      firstSeenAt: bets.firstSeenAt,
      lastSeenAt: bets.lastSeenAt,
      tickCount: bets.tickCount,
      createdAt: bets.createdAt,
      placedAt: bets.placedAt,
      outcome: bets.outcome,
    })
    .from(bets)) as BetRowFull[];

  console.log(`Total bets rows: ${rows.length}`);

  const groups = new Map<string, BetRowFull[]>();
  for (const row of rows) {
    const key = deterministicId(row.eventId, row.familyId, row.atomId);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  let duplicateGroups = 0;
  let placedSurvivors = 0;
  let unplacedSurvivors = 0;
  let rowsDeleted = 0;
  let idsRekeyed = 0;
  let skippedInConflict = 0;

  for (const [key, group] of groups) {
    const needsWork =
      group.length > 1 || (group.length === 1 && group[0]!.id !== key);

    if (!needsWork) continue;

    if (group.length > 1) duplicateGroups++;

    const { survivor, kind } = pickSurvivor(group);
    if (kind === "placed") placedSurvivors++;
    else unplacedSurvivors++;

    const bestByPayout = pickBestByPayout(group);
    const survivorPayout = effectivePayout(
      survivor.softOdds,
      survivor.softCommissionPct,
      survivor.sharpTrueProb,
    );
    const bestPayout = effectivePayout(
      bestByPayout.softOdds,
      bestByPayout.softCommissionPct,
      bestByPayout.sharpTrueProb,
    );
    const upgradeSoft = bestPayout > survivorPayout;

    const firstSeenAt = group.map((r) => r.firstSeenAt).sort()[0]!;
    const lastSeenAt = group
      .map((r) => r.lastSeenAt)
      .sort()
      .at(-1)!;
    const createdAt = group.map((r) => r.createdAt).sort()[0]!;
    const tickCount = group.reduce((sum, r) => sum + (r.tickCount || 1), 0);

    const idsToDelete = group
      .filter((r) => r.id !== survivor.id)
      .map((r) => r.id);

    if (dryRun) {
      const rekey = survivor.id !== key ? " (rekey)" : "";
      const upgrade = upgradeSoft ? " (upgrade-soft)" : "";
      console.log(
        `[DRY] ${key}: keep=${survivor.id} kind=${kind}${rekey}${upgrade}, ` +
          `delete=${idsToDelete.length}, tickCount=${tickCount}`,
      );
      if (survivor.id !== key) idsRekeyed++;
      rowsDeleted += idsToDelete.length;
      continue;
    }

    try {
      await db.transaction(async (tx) => {
        // 1. Delete the non-survivor rows FIRST. This frees up the
        //    deterministic id slot if one of them happens to hold it, letting
        //    us rekey the survivor without a PK collision.
        if (idsToDelete.length > 0) {
          await tx.delete(bets).where(inArray(bets.id, idsToDelete));
        }

        // 2. Update aggregates + optional soft-side upgrade.
        const setClauses: string[] = [
          `first_seen_at = ${escapeIso(firstSeenAt)}`,
          `last_seen_at = ${escapeIso(lastSeenAt)}`,
          `created_at = ${escapeIso(createdAt)}`,
          `tick_count = ${Number(tickCount)}`,
          `updated_at = NOW()`,
        ];
        if (upgradeSoft) {
          setClauses.push(
            `soft_provider = ${escapeText(bestByPayout.softProvider)}`,
            `soft_odds = ${Number(bestByPayout.softOdds)}`,
            `soft_commission_pct = ${Number(bestByPayout.softCommissionPct)}`,
          );
        }
        await tx.execute(
          sql.raw(
            `UPDATE bets SET ${setClauses.join(", ")} WHERE id = ${escapeText(survivor.id)}`,
          ),
        );

        // 3. Rekey the survivor to the deterministic id (if not already).
        if (survivor.id !== key) {
          await tx.execute(
            sql.raw(
              `UPDATE bets SET id = ${escapeText(key)}, updated_at = NOW() WHERE id = ${escapeText(survivor.id)}`,
            ),
          );
          idsRekeyed++;
        }
      });
      rowsDeleted += idsToDelete.length;
    } catch (err) {
      skippedInConflict++;
      console.error(
        `[ERR] ${key}: ${(err as Error).message}. Skipping this group.`,
      );
    }
  }

  console.log("\n=== Summary ===");
  console.log(`Duplicate groups processed: ${duplicateGroups}`);
  console.log(`  - placed survivors:      ${placedSurvivors}`);
  console.log(`  - unplaced survivors:    ${unplacedSurvivors}`);
  console.log(`Rows deleted:              ${rowsDeleted}`);
  console.log(`Survivor IDs rekeyed:      ${idsRekeyed}`);
  if (skippedInConflict > 0) {
    console.log(`Groups skipped (errors):   ${skippedInConflict}`);
  }

  await pool.end();
  process.exit(0);
}

// ─── Tiny SQL escape helpers (survivor/group ids come from our own DB, so these
//     are defensive rather than critical, but we still escape properly) ───────

function escapeText(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function escapeIso(s: string): string {
  return `${escapeText(s)}::timestamptz`;
}

main().catch((err) => {
  console.error(`Fatal error: ${(err as Error).message}`);
  process.exit(1);
});
