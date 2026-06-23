
import "dotenv/config";

import { ensureDbReady } from "@/lib/db/client";

if (process.env.SKIP_VITEST_DB !== "1") {
  await ensureDbReady();
}
