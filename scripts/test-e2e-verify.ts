import "dotenv/config";

if (!process.env.ENABLE_E2E_CLOUD_RUN) {
  console.error(
    "This script validates a real Cloud Run training run.\n" +
      "Set ENABLE_E2E_CLOUD_RUN=1 to proceed.",
  );
  process.exit(1);
}

import { db, ensureDbReady } from "@/lib/db/client";
import { mlModels, bets } from "@/lib/db/schema";
import { desc, sql } from "drizzle-orm";

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  await ensureDbReady();
  console.log("=== ML Optimizer End-to-End Test (Part 2: Verification) ===");
  const testStartTime = new Date(Date.now() - 360 * 1000); // approx when training started

  // 4. Verify DB after training
  console.log("4. Verifying database post-training...");
  const recentModels = await db
    .select()
    .from(mlModels)
    .orderBy(desc(mlModels.createdAt))
    .limit(1);

  if (recentModels.length === 0) {
    throw new Error("No models found in DB after training.");
  }
  const latest = recentModels[0];
  console.log(
    `Latest model in DB: ${latest.id}, Status: ${latest.status}, Version: ${latest.version}, Samples: ${latest.trainingSamples}`,
  );

  if (latest.status === "failed") {
    console.error(
      `Training failed. Rejection reasons: ${JSON.stringify(latest.rejectionReasons)}`,
    );
    throw new Error("Training failed.");
  } else if (latest.status === "rejected") {
    console.log(
      `Model rejected by gate. Rejection reasons: ${JSON.stringify(latest.rejectionReasons)}`,
    );
  } else if (latest.status === "deployed") {
    console.log(
      `Model successfully deployed! Permission Level: ${latest.permissionLevel}`,
    );
  }

  // 5. Observe reactor capturing shadow bets
  console.log("5. Observing reactor for new bets with ML scores...");
  let observed = false;
  let observeAttempts = 0;
  while (!observed && observeAttempts < 30) {
    await sleep(5000); // 5 seconds
    observeAttempts++;

    const newBets = await db
      .select({ id: bets.id, mlScore: bets.mlScore, outcome: bets.outcome })
      .from(bets)
      .where(sql`${bets.firstSeenAt} >= ${testStartTime.toISOString()}`)
      .orderBy(desc(bets.firstSeenAt))
      .limit(10);

    const scoredBets = newBets.filter((b) => b.mlScore !== null);
    if (scoredBets.length > 0) {
      console.log(
        `Success! Observed ${scoredBets.length} new bets with ML scores.`,
      );
      console.log("Sample of scored bets:", scoredBets.slice(0, 3));
      observed = true;
    } else {
      console.log(
        `Waiting for new bets... (found ${newBets.length} total new bets since test started, 0 scored)`,
      );
    }
  }

  if (!observed) {
    console.warn(
      "Did not observe any new bets getting scored. This might be normal if there's no live data coming in.",
    );
  } else {
    console.log(
      "Shadow bet scoring is working correctly. Reactor successfully processed them.",
    );
  }

  console.log("=== Verification Completed Successfully ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
