/**
 * Vitest setup — runs before any test file.
 *
 * Initializes the DB pool so every test that imports DB repos
 * gets a ready connection.
 */

import "dotenv/config";

import { ensureDbReady } from "@/lib/db/client";

// HTTP-only e2e specs talk to the running Next.js server and do not need a
// second test-process DB pool.
if (process.env.SKIP_VITEST_DB !== "1") {
  await ensureDbReady();
}
