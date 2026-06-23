import { db } from "@/lib/db/client";
import { telegramCommandHistory } from "@/lib/db/schema";
import { count, desc } from "drizzle-orm";

export interface CommandHistoryEntry {
  at: string;
  command: string;
  text: string;
  fromUserId: number | null;
  outcome: "ok" | "denied" | "unknown" | "error";
  durationMs: number;
  error?: string | null;
}

export async function recordCommandHistory(
  entry: CommandHistoryEntry,
): Promise<void> {
  await db
    .insert(telegramCommandHistory)
    .values({
      at: entry.at,
      command: entry.command,
      text: entry.text,
      fromUserId: entry.fromUserId,
      outcome: entry.outcome,
      durationMs: entry.durationMs,
      error: entry.error ?? null,
    })
    .catch((err) => {
      console.error(
        "[history] Failed to write command history ERROR DETAIL:",
        err,
      );
    });
}

export async function getCommandCounts(): Promise<Record<string, number>> {
  const rows = await db
    .select({ command: telegramCommandHistory.command, count: count() })
    .from(telegramCommandHistory)
    .groupBy(telegramCommandHistory.command);

  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.command] = row.count;
  }
  return result;
}

export async function getCommandHistory(
  n = 50,
): Promise<CommandHistoryEntry[]> {
  const rows = await db
    .select()
    .from(telegramCommandHistory)
    .orderBy(desc(telegramCommandHistory.at))
    .limit(n);

  return rows.map((r) => ({
    at: r.at,
    command: r.command,
    text: r.text,
    fromUserId: r.fromUserId,
    outcome: r.outcome as CommandHistoryEntry["outcome"],
    durationMs: r.durationMs,
    error: r.error,
  }));
}

export async function getCommandHistoryStats(): Promise<{
  total: number;
  ok: number;
  denied: number;
  unknown: number;
  error: number;
  topCommands: Array<{ name: string; count: number }>;
}> {
  const outcomeCounts = await db
    .select({ outcome: telegramCommandHistory.outcome, count: count() })
    .from(telegramCommandHistory)
    .groupBy(telegramCommandHistory.outcome);

  let total = 0;
  const outcomes = { ok: 0, denied: 0, unknown: 0, error: 0 };

  for (const row of outcomeCounts) {
    if (row.outcome in outcomes) {
      outcomes[row.outcome as keyof typeof outcomes] = row.count;
      total += row.count;
    }
  }

  const topRows = await db
    .select({ name: telegramCommandHistory.command, count: count() })
    .from(telegramCommandHistory)
    .groupBy(telegramCommandHistory.command)
    .orderBy(desc(count()))
    .limit(10);

  return {
    total,
    ...outcomes,
    topCommands: topRows,
  };
}
