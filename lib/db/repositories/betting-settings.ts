import { eq } from "drizzle-orm";
import { db } from "../client";
import {
  bettingSettings,
  type BettingSettingsRow,
  type NewBettingSettingsRow,
} from "../schema";
import {
  DEFAULT_BET_PLACEMENT_PHASES,
  DEFAULT_VALUE_DETECTION_PHASES,
  normalizeMarketPhases,
} from "@/lib/betting/market-phase";

const SINGLETON_ID = 1;

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
  valueDetectionPhases: DEFAULT_VALUE_DETECTION_PHASES,
  betPlacementPhases: DEFAULT_BET_PLACEMENT_PHASES,

  mlMinScore: 0.4,
  updatedAt: new Date().toISOString(),
};

const MEMO_TTL_MS = 30_000;

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
    row: normalizeRow(row),
    fetchedAt: Date.now(),
  };
}

function clearMemo() {
  globalThis.__nahidArbX_bettingSettingsMemo__ = undefined;
}

export interface BettingSettingsReadResult {
  row: BettingSettingsRow;
  ready: boolean;
  error?: string;
}

function normalizeRow(row: BettingSettingsRow): BettingSettingsRow {
  return {
    ...row,
    valueDetectionPhases: normalizeMarketPhases(
      row.valueDetectionPhases,
      DEFAULT_VALUE_DETECTION_PHASES,
    ),
    betPlacementPhases: normalizeMarketPhases(
      row.betPlacementPhases,
      DEFAULT_BET_PLACEMENT_PHASES,
    ),
  };
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
    const row = normalizeRow(rows[0] ?? DEFAULTS);
    writeMemo(row);
    return { row, ready: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { row: normalizeRow(DEFAULTS), ready: false, error: message };
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
  const normalized = normalizeRow(row);
  writeMemo(normalized);
  return normalized;
}
