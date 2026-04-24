/**
 * One-off migration runner — executes pending .sql files under
 * lib/db/migrations. Dev-only. Idempotent (uses CREATE IF NOT EXISTS).
 *
 * POST /api/bets-history/migrate
 *
 * Delete this file once Drizzle-kit proper is wired up for the Cloud SQL
 * connector.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  apiError,
  apiServerError,
  apiSuccess,
} from "@/lib/shared/api-response";

export async function POST() {
  if (process.env.NODE_ENV !== "development") {
    return apiError("dev-only endpoint", 403);
  }

  try {
    const dir = path.join(process.cwd(), "lib/db/migrations");
    const entries = await readdir(dir);
    // Skip auto-generated drizzle migrations (0000, 0001) — those are already
    // applied. Run only the hand-written ones we name with a suffix tag.
    const sqlFiles = entries
      .filter((f) => f.endsWith(".sql") && /^\d{4}_[a-z_]+\.sql$/.test(f))
      .filter(
        (f) =>
          f === "0002_strategies.sql" ||
          f === "0003_strategy_executions.sql" ||
          f === "0004_merge_push_into_void.sql",
      )
      .sort();

    const applied: string[] = [];
    for (const file of sqlFiles) {
      const source = await readFile(path.join(dir, file), "utf8");
      await db.execute(sql.raw(source));
      applied.push(file);
    }

    return apiSuccess({ applied });
  } catch (err) {
    return apiServerError(err, "Backtest:migrate");
  }
}
