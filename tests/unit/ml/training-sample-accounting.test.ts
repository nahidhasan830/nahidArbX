import { describe, expect, it } from "vitest";

import { getCurrentCorpusAccounting } from "@/lib/ml/training-sample-accounting";
import { reconcileMissingSettledExamples } from "@/lib/ml/training-example-writer";
import {
  ML_COLD_START_THRESHOLD,
  ML_COLLECTION_TARGET,
} from "@/lib/shared/constants";

type BetFixture = {
  outcome: "pending" | "void" | "won" | "half_won" | "lost" | "half_lost";
  featureVersion: number | null;
  day: string;
};

function makeAccountingDb(
  bets: BetFixture[],
  summary: Partial<Record<string, number>> = {},
) {
  return {
    execute: async (query: {
      toQuery: (config: unknown) => { sql: string };
    }) => {
      const sqlText = query.toQuery({
        escapeName: (name: string) => `"${name}"`,
        escapeParam: (index: number) => `$${index + 1}`,
        escapeString: (value: string) => `'${value}'`,
        casing: { getColumnCasing: (column: { name: string }) => column.name },
      }).sql;

      if (sqlText.includes("GROUP BY day")) {
        const rows = Array.from(
          bets
            .filter(
              (bet) => bet.outcome !== "pending" && bet.outcome !== "void",
            )
            .reduce((byDay, bet) => {
              const current = byDay.get(bet.day) ?? {
                day: bet.day,
                total_settled: 0,
                current_contract_features: 0,
                wins: 0,
                losses: 0,
              };
              current.total_settled += 1;
              if (bet.featureVersion === 1)
                current.current_contract_features += 1;
              if (bet.outcome === "won" || bet.outcome === "half_won") {
                current.wins += 1;
              }
              if (bet.outcome === "lost" || bet.outcome === "half_lost") {
                current.losses += 1;
              }
              byDay.set(bet.day, current);
              return byDay;
            }, new Map<string, Record<string, number | string>>())
            .values(),
        ).sort((a, b) => String(a.day).localeCompare(String(b.day)));

        return { rows };
      }

      const settled = bets.filter(
        (bet) => bet.outcome !== "pending" && bet.outcome !== "void",
      );
      return {
        rows: [
          {
            total_settled: settled.length,
            current_contract_features: settled.filter(
              (bet) => bet.featureVersion === 1,
            ).length,
            wins: settled.filter(
              (bet) => bet.outcome === "won" || bet.outcome === "half_won",
            ).length,
            losses: settled.filter(
              (bet) => bet.outcome === "lost" || bet.outcome === "half_lost",
            ).length,
            qualified_bets: summary.qualified_bets ?? 2,
            raw_labeled_examples: summary.raw_labeled_examples ?? 4,
            canonical_examples: summary.canonical_examples ?? 0,
            canonical_examples_with_source_bet:
              summary.canonical_examples_with_source_bet ?? 0,
            uncovered_qualified_bets: summary.uncovered_qualified_bets ?? 2,
          },
        ],
      };
    },
  };
}

describe("getCurrentCorpusAccounting", () => {
  it("keeps current-contract counts separate from trainer readiness", async () => {
    const accounting = await getCurrentCorpusAccounting(
      makeAccountingDb([
        { outcome: "pending", featureVersion: 1, day: "2026-05-19" },
        { outcome: "void", featureVersion: 1, day: "2026-05-19" },
        { outcome: "won", featureVersion: 1, day: "2026-05-20" },
        { outcome: "half_won", featureVersion: 1, day: "2026-05-20" },
        { outcome: "lost", featureVersion: 2, day: "2026-05-21" },
        { outcome: "half_lost", featureVersion: null, day: "2026-05-21" },
      ]) as never,
    );

    expect(accounting).toMatchObject({
      totalSettled: 4,
      currentContractFeatures: 2,
      wins: 2,
      losses: 2,
      coldStartThreshold: ML_COLD_START_THRESHOLD,
      collectionTarget: ML_COLLECTION_TARGET,
      remainingToColdStart: ML_COLD_START_THRESHOLD - 2,
      remainingToTarget: ML_COLLECTION_TARGET - 2,
      qualifiedBets: 2,
      trainerExpectedSamples: 2,
    });
  });

  it("adds canonical and uncovered samples when the corpus is partially hydrated", async () => {
    const accounting = await getCurrentCorpusAccounting(
      makeAccountingDb(
        [
          { outcome: "won", featureVersion: 1, day: "2026-05-19" },
          { outcome: "lost", featureVersion: 1, day: "2026-05-20" },
        ],
        {
          qualified_bets: 5,
          raw_labeled_examples: 3,
          canonical_examples: 2,
          canonical_examples_with_source_bet: 2,
          uncovered_qualified_bets: 3,
        },
      ) as never,
    );

    expect(accounting.canonicalExamples).toBe(2);
    expect(accounting.uncoveredQualifiedBets).toBe(3);
    expect(accounting.trainerExpectedSamples).toBe(5);
  });

  it("groups short daily history by settled day", async () => {
    const accounting = await getCurrentCorpusAccounting(
      makeAccountingDb([
        { outcome: "won", featureVersion: 1, day: "2026-05-19" },
        { outcome: "half_lost", featureVersion: 1, day: "2026-05-19" },
        { outcome: "half_won", featureVersion: 2, day: "2026-05-20" },
        { outcome: "lost", featureVersion: 1, day: "2026-05-21" },
        { outcome: "pending", featureVersion: 1, day: "2026-05-21" },
      ]) as never,
    );

    expect(accounting.dailyHistory).toEqual([
      {
        day: "2026-05-19",
        totalSettled: 2,
        currentContractFeatures: 2,
        wins: 1,
        losses: 1,
      },
      {
        day: "2026-05-20",
        totalSettled: 1,
        currentContractFeatures: 0,
        wins: 1,
        losses: 0,
      },
      {
        day: "2026-05-21",
        totalSettled: 1,
        currentContractFeatures: 1,
        wins: 0,
        losses: 1,
      },
    ]);
  });
});

describe("reconcileMissingSettledExamples", () => {
  it("keeps calling write batches until none remain", async () => {
    const batches = [3, 2, 0];
    let calls = 0;

    const total = await reconcileMissingSettledExamples(
      500,
      async () => batches[calls++] ?? 0,
    );

    expect(total).toBe(5);
    expect(calls).toBe(3);
  });
});
