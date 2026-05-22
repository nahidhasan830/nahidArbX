import "dotenv/config";

import { ensureDbReady } from "../lib/db/client";
import {
  listHistoricalBackfillBets,
  updateHistoricalMlFeatures,
} from "../lib/db/repositories/bets";
import {
  extractHistoricalFeatures,
  FEATURE_COUNT,
  FEATURE_NAMES_HASH,
  FEATURE_VERSION,
  type HistoricalFeatureSkipReason,
} from "../lib/ml/features";

const EXECUTE = process.argv.includes("--execute");
const BATCH_SIZE = 500;

type SkipCounts = Partial<
  Record<HistoricalFeatureSkipReason | "already_current_contract", number>
>;

function bump(
  map: SkipCounts,
  key: HistoricalFeatureSkipReason | "already_current_contract",
) {
  map[key] = (map[key] ?? 0) + 1;
}

async function main(): Promise<void> {
  await ensureDbReady();

  console.log(
    `[ml-backfill-historical-features] mode=${EXECUTE ? "EXECUTE" : "DRY-RUN"}`,
  );

  let afterId: string | undefined;
  let processed = 0;
  let reconstructed = 0;
  let updated = 0;
  const skipCounts: SkipCounts = {};

  while (true) {
    const rows = await listHistoricalBackfillBets({
      afterId,
      limit: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    const staged: Array<{
      id: string;
      features: number[];
      featureVersion: number;
      featureCount: number;
      featureNamesHash: string;
    }> = [];

    for (const row of rows) {
      processed++;
      const alreadyCurrent =
        Array.isArray(row.mlFeatures) &&
        row.mlFeatures.length === FEATURE_COUNT &&
        row.mlFeatureVersion === FEATURE_VERSION &&
        row.mlFeatureCount === FEATURE_COUNT &&
        row.mlFeatureNamesHash === FEATURE_NAMES_HASH;

      if (alreadyCurrent) {
        bump(skipCounts, "already_current_contract");
        continue;
      }

      const result = extractHistoricalFeatures({
        eventStartTime: row.eventStartTime,
        firstSeenAt: row.firstSeenAt,
        competition: row.competition,
        marketType: row.marketType,
        familyLine: row.familyLine,
        sharpProvider: row.sharpProvider,
        sharpOdds: Number(row.sharpOdds),
        sharpTrueProb: Number(row.sharpTrueProb),
        softProvider: row.softProvider,
        softCommissionPct: Number(row.softCommissionPct),
        softOdds: Number(row.softOdds),
        oddsMovement: row.oddsMovement,
      });

      if (!result.ok) {
        for (const reason of result.reasons) bump(skipCounts, reason);
        continue;
      }

      reconstructed++;
      staged.push({
        id: row.id,
        features: result.features,
        featureVersion: FEATURE_VERSION,
        featureCount: FEATURE_COUNT,
        featureNamesHash: FEATURE_NAMES_HASH,
      });
    }

    if (EXECUTE && staged.length > 0) {
      updated += await updateHistoricalMlFeatures(staged);
    }

    afterId = rows[rows.length - 1]?.id;
    if (processed % 2000 === 0) {
      console.log(
        `[ml-backfill-historical-features] progress=${processed} reconstructed=${reconstructed} updated=${updated}`,
      );
    }
  }

  console.log(`\n[ml-backfill-historical-features] processed=${processed}`);
  console.log(
    `[ml-backfill-historical-features] reconstructed=${reconstructed}`,
  );
  console.log(`[ml-backfill-historical-features] updated=${updated}`);
  console.log("[ml-backfill-historical-features] skip counts:");
  for (const [reason, count] of Object.entries(skipCounts).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${reason}: ${count}`);
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(
      `[ml-backfill-historical-features] failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
