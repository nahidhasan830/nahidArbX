/**
 * Betting-settings repository — singleton row (id=1).
 *
 * Read path is memoized in-process with a short TTL so the auto-placer
 * doesn't round-trip to Postgres on every placement. Writes go through
 * `updateBettingSettings` which invalidates the memo atomically.
 */
import { eq } from "drizzle-orm";
import { db } from "../client";
import {
  bettingSettings,
  type BettingSettingsRow,
  type NewBettingSettingsRow,
} from "../schema";

const SINGLETON_ID = 1;

/**
 * Default values matched to the SQL migration — if for any reason the
 * seed row is missing we still return coherent settings and the next
 * upsert will persist them.
 */
const DEFAULTS: BettingSettingsRow = {
  id: SINGLETON_ID,
  useLiveBalance: true,
  manualBankrollBdt: 1000,
  unitSizeBdt: 200,
  kellyCapPct: 10,
  kellyFraction: 0.25,
  minStakeBdt: 200,
  stakeBucketBdt: 100,
  minEvPct: 2,

  activeStrategyIds: [],
  updatedAt: new Date().toISOString(),
};

const MEMO_TTL_MS = 30_000;

// Pin to globalThis so Turbopack / HMR module-duplication can't give us
// a stale memo. Same idiom used elsewhere for cross-module in-memory
// state in this codebase.
declare global {
  var __nahidArbX_bettingSettingsMemo__:
    | { row: BettingSettingsRow; fetchedAt: number }
    | undefined;
}

function readMemo() {
  return globalThis.__nahidArbX_bettingSettingsMemo__;
}

function writeMemo(row: BettingSettingsRow) {
  globalThis.__nahidArbX_bettingSettingsMemo__ = {
    row,
    fetchedAt: Date.now(),
  };
}

function clearMemo() {
  globalThis.__nahidArbX_bettingSettingsMemo__ = undefined;
}

export interface BettingSettingsReadResult {
  row: BettingSettingsRow;
  /**
   * True when the row came from the `betting_settings` table. False
   * when we fell back to defaults because the table is missing (e.g.
   * migration 0015 hasn't been run yet) or the connection failed.
   * The API exposes this so the dashboard can tell the operator to
   * run the migration instead of silently swallowing writes.
   */
  ready: boolean;
  error?: string;
}

export async function getBettingSettings(): Promise<BettingSettingsReadResult> {
  const memo = readMemo();
  if (memo && Date.now() - memo.fetchedAt < MEMO_TTL_MS) {
    return { row: memo.row, ready: true };
  }
  try {
    const rows = await db
      .select()
      .from(bettingSettings)
      .where(eq(bettingSettings.id, SINGLETON_ID))
      .limit(1);
    const row = rows[0] ?? DEFAULTS;
    writeMemo(row);
    return { row, ready: true };
  } catch (err) {
    // Table missing (migration 0015 pending) or connection down. Return
    // DEFAULTS so the dashboard and placer still have a coherent view;
    // the `ready: false` flag lets the API surface the problem.
    const message = err instanceof Error ? err.message : String(err);
    return { row: DEFAULTS, ready: false, error: message };
  }
}

export type BettingSettingsUpdate = Partial<
  Omit<NewBettingSettingsRow, "id" | "updatedAt">
>;

export async function updateBettingSettings(
  patch: BettingSettingsUpdate,
): Promise<BettingSettingsRow> {
  const nowIso = new Date().toISOString();
  const [row] = await db
    .insert(bettingSettings)
    .values({
      id: SINGLETON_ID,
      ...patch,
      updatedAt: nowIso,
    })
    .onConflictDoUpdate({
      target: bettingSettings.id,
      set: {
        ...patch,
        updatedAt: nowIso,
      },
    })
    .returning();
  clearMemo();
  writeMemo(row);
  return row;
}
