/**
 * Generic atomic-claim helper for queued-row scheduler patterns.
 *
 * Lifted out of `lib/optimizer/scheduler.ts` (the optimizer Job triggers
 * use this) so the same pattern can be reused by the entity-classifier
 * and entity-resolver Cloud Run Jobs without duplicating the SQL.
 *
 * The contract:
 *   • One UPDATE flips status='queued' → status='running' for one row.
 *   • Returns true iff this caller won the race; false if another
 *     concurrent caller already claimed it (the row's status was no
 *     longer 'queued' when the UPDATE ran).
 *   • `unclaim` reverts running → queued so the next tick will retry
 *     when the post-claim work fails.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client";

/**
 * Atomically claim a queued row of the given table by id.
 * The table must have a `status` column with values matching
 * `from`/`to` (e.g. 'queued', 'running').
 *
 * Returns true if this call performed the flip (i.e. the row was still
 * `queued` and is now `running`).
 */
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

/**
 * Revert a previously-claimed row back to its queued state. Used by the
 * scheduler when triggering the Job execution failed AFTER the claim
 * succeeded — without this the row would sit stuck forever.
 */
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

/**
 * Reconcile rows that have been stuck in `running` for longer than
 * `maxRunningMinutes` with no progress. The promoter / resolver Job
 * reset their `started_at` (or whatever progress timestamp the table
 * uses) on every iteration, so a stale `started_at` reliably indicates
 * a crashed/orphaned execution.
 *
 * Returns the IDs reverted to queued.
 */
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
