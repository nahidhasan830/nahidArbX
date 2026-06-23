
import { sql } from "drizzle-orm";
import { db } from "../db/client";

export async function atomicClaim(opts: {
  table: string;
  id: string;
  from?: string;
  to?: string;
  startedAtCol?: string;
}): Promise<boolean> {
  const from = opts.from ?? "queued";
  const to = opts.to ?? "running";
  const stamp = opts.startedAtCol ? `, ${opts.startedAtCol} = NOW()` : "";
  const result = await db.execute<{ id: string }>(
    sql.raw(
      `UPDATE ${opts.table}
        SET status = '${to}'${stamp}
      WHERE id = '${opts.id}'
        AND status = '${from}'
      RETURNING id`,
    ),
  );
  return ((result as unknown as { rowCount?: number }).rowCount ?? 0) > 0;
}

export async function unclaim(opts: {
  table: string;
  id: string;
  from?: string;
  to?: string;
}): Promise<void> {
  const from = opts.from ?? "running";
  const to = opts.to ?? "queued";
  await db.execute(
    sql.raw(
      `UPDATE ${opts.table} SET status = '${to}' WHERE id = '${opts.id}' AND status = '${from}'`,
    ),
  );
}

export async function reconcileStuck(opts: {
  table: string;
  startedAtCol?: string;
  maxRunningMinutes: number;
}): Promise<string[]> {
  const col = opts.startedAtCol ?? "started_at";
  const result = await db.execute<{ id: string }>(
    sql.raw(
      `UPDATE ${opts.table}
        SET status = 'queued'
      WHERE status = 'running'
        AND ${col} < NOW() - INTERVAL '${opts.maxRunningMinutes} minutes'
      RETURNING id`,
    ),
  );
  return (
    (result as unknown as { rows?: Array<{ id: string }> }).rows ?? []
  ).map((r) => r.id);
}
