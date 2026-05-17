/**
 * Guarded ML optimization data purge.
 *
 * Dry run:
 *   npx tsx scripts/purge-ml-optimization-data.ts
 *
 * Execute:
 *   CONFIRM_PURGE_ML_DATA=YES npx tsx scripts/purge-ml-optimization-data.ts --execute
 *
 * This intentionally clears only ML optimizer artifacts and removes bets that
 * cannot produce valid ML training examples. It does not truncate auth,
 * settings, provider state, settlement audit, or entity-resolution data.
 */

import "dotenv/config";
import { ensureDbReady, db } from "@/lib/db/client";
import { bets, mlModels, mlTrainingExamples } from "@/lib/db/schema";
import { ML_FEATURE_COUNT, ML_FEATURE_VERSION } from "@/lib/shared/constants";
import { FEATURE_NAMES_HASH } from "@/lib/ml/features";
import { sql, type SQL } from "drizzle-orm";

const execute = process.argv.includes("--execute");

const unsuitableBetsWhere = sql`
  ${bets.mlFeatures} IS NULL
  OR ${bets.mlFeatureVersion} IS DISTINCT FROM ${ML_FEATURE_VERSION}
  OR ${bets.mlFeatureCount} IS DISTINCT FROM ${ML_FEATURE_COUNT}
  OR ${bets.mlFeatureNamesHash} IS DISTINCT FROM ${FEATURE_NAMES_HASH}
  OR array_length(${bets.mlFeatures}, 1) IS DISTINCT FROM ${ML_FEATURE_COUNT}
  OR ${bets.softOdds} <= 1.01
  OR ${bets.sharpTrueProb} <= 0
  OR ${bets.sharpTrueProb} >= 1
  OR (${bets.mlFeatures})[2] <= 0
  OR (${bets.mlFeatures})[2] >= 1
  OR (${bets.mlFeatures})[4] <= 1.01
  OR (${bets.mlFeatures})[22] NOT IN (1.0, 2.0, 3.0)
  OR ${bets.outcome} IN ('void', 'cancelled')
`;

async function count(query: SQL): Promise<number> {
  const result = await db.execute(query);
  return Number(result.rows[0]?.n ?? 0);
}

async function main() {
  await ensureDbReady();

  const identity = await db.execute(sql`
    SELECT current_database() AS db, current_user AS user
  `);
  const target = identity.rows[0] as { db?: string; user?: string };

  const counts = {
    mlModels: await count(sql`SELECT count(*)::int AS n FROM ${mlModels}`),
    mlTrainingExamples: await count(
      sql`SELECT count(*)::int AS n FROM ${mlTrainingExamples}`,
    ),
    betsWithMlScores: await count(sql`
      SELECT count(*)::int AS n
      FROM ${bets}
      WHERE ${bets.mlScore} IS NOT NULL OR ${bets.mlStakeFraction} IS NOT NULL
    `),
    unsuitableBets: await count(sql`
      SELECT count(*)::int AS n
      FROM ${bets}
      WHERE ${unsuitableBetsWhere}
    `),
  };

  console.log(
    JSON.stringify(
      {
        mode: execute ? "execute" : "dry-run",
        target,
        counts,
      },
      null,
      2,
    ),
  );

  if (!execute) {
    console.log("Dry run only. Add --execute and CONFIRM_PURGE_ML_DATA=YES.");
    return;
  }

  if (process.env.CONFIRM_PURGE_ML_DATA !== "YES") {
    throw new Error("Refusing purge: set CONFIRM_PURGE_ML_DATA=YES");
  }

  await db.transaction(async (tx) => {
    await tx.delete(mlTrainingExamples);
    await tx.delete(mlModels);
    await tx.execute(sql`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ml_model_version_seq') THEN
          PERFORM setval('ml_model_version_seq', 1, false);
        END IF;
      END $$;
    `);
    await tx.execute(sql`
      UPDATE ${bets}
      SET ml_score = NULL,
          ml_stake_fraction = NULL
      WHERE ${bets.mlScore} IS NOT NULL
         OR ${bets.mlStakeFraction} IS NOT NULL
    `);
    await tx.execute(sql`DELETE FROM ${bets} WHERE ${unsuitableBetsWhere}`);
  });

  console.log("ML optimization data purge complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
