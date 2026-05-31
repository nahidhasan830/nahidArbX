import { eq } from "drizzle-orm";
import { db } from "../client";
import {
  eventMatcherSchedulerSettings,
  type EventMatcherSchedulerSettingsRow,
  type NewEventMatcherSchedulerSettingsRow,
} from "../schema";

const SINGLETON_ID = 1;
const MIN_INTERVAL_SECONDS = 15;

const DEFAULTS: EventMatcherSchedulerSettingsRow = {
  id: SINGLETON_ID,
  enabled: true,
  intervalSeconds: 60,
  useDeepSeek: true,
  updatedAt: new Date().toISOString(),
};

declare global {
  var __nahidArbX_eventMatcherSchedulerSettingsMemo__:
    | { row: EventMatcherSchedulerSettingsRow; fetchedAt: number }
    | undefined;
}

const MEMO_TTL_MS = 10_000;

function normalizeRow(
  row: EventMatcherSchedulerSettingsRow,
): EventMatcherSchedulerSettingsRow {
  return {
    ...row,
    intervalSeconds: Math.max(
      MIN_INTERVAL_SECONDS,
      Math.round(row.intervalSeconds || DEFAULTS.intervalSeconds),
    ),
  };
}

function clearMemo() {
  globalThis.__nahidArbX_eventMatcherSchedulerSettingsMemo__ = undefined;
}

function writeMemo(row: EventMatcherSchedulerSettingsRow) {
  globalThis.__nahidArbX_eventMatcherSchedulerSettingsMemo__ = {
    row: normalizeRow(row),
    fetchedAt: Date.now(),
  };
}

export async function getEventMatcherSchedulerSettings(): Promise<{
  row: EventMatcherSchedulerSettingsRow;
  ready: boolean;
  error?: string;
}> {
  const memo = globalThis.__nahidArbX_eventMatcherSchedulerSettingsMemo__;
  if (memo && Date.now() - memo.fetchedAt < MEMO_TTL_MS) {
    return { row: memo.row, ready: true };
  }

  try {
    const rows = await db
      .select()
      .from(eventMatcherSchedulerSettings)
      .where(eq(eventMatcherSchedulerSettings.id, SINGLETON_ID))
      .limit(1);
    const row = normalizeRow(rows[0] ?? DEFAULTS);
    writeMemo(row);
    return { row, ready: true };
  } catch (err) {
    return {
      row: normalizeRow(DEFAULTS),
      ready: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export type EventMatcherSchedulerSettingsUpdate = Partial<
  Omit<NewEventMatcherSchedulerSettingsRow, "id" | "updatedAt">
>;

export async function updateEventMatcherSchedulerSettings(
  patch: EventMatcherSchedulerSettingsUpdate,
): Promise<EventMatcherSchedulerSettingsRow> {
  const nowIso = new Date().toISOString();
  const normalizedPatch = {
    ...patch,
    intervalSeconds:
      typeof patch.intervalSeconds === "number"
        ? Math.max(MIN_INTERVAL_SECONDS, Math.round(patch.intervalSeconds))
        : undefined,
  };
  const [row] = await db
    .insert(eventMatcherSchedulerSettings)
    .values({
      id: SINGLETON_ID,
      ...normalizedPatch,
      updatedAt: nowIso,
    })
    .onConflictDoUpdate({
      target: eventMatcherSchedulerSettings.id,
      set: {
        ...normalizedPatch,
        updatedAt: nowIso,
      },
    })
    .returning();

  clearMemo();
  const normalized = normalizeRow(row);
  writeMemo(normalized);
  return normalized;
}
