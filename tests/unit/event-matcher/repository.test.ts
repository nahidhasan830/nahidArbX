import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = vi.fn();
const select = vi.fn(() => query);
const query = {
  from: vi.fn(() => query),
  where: vi.fn(async () => rows()),
  orderBy: vi.fn(() => query),
  limit: vi.fn(async () => rows()),
};

vi.mock("../../../lib/db/client", () => ({
  db: {
    select,
  },
}));

const { filterNewCandidateKeys, readReliabilityStats } =
  await import("../../../lib/event-matcher/repository");

describe("event matcher repository", () => {
  beforeEach(() => {
    rows.mockReset();
    select.mockClear();
    query.from.mockClear();
    query.where.mockClear();
    query.orderBy.mockClear();
    query.limit.mockClear();
  });

  it("skips unchanged candidate shapes and replays changed shapes", async () => {
    rows.mockResolvedValue([
      { candidateKey: "unchanged", shapeFingerprint: "shape-a" },
      { candidateKey: "changed", shapeFingerprint: "old-shape" },
    ]);

    const keys = await filterNewCandidateKeys([
      { candidateKey: "unchanged", shapeFingerprint: "shape-a" },
      { candidateKey: "changed", shapeFingerprint: "shape-b" },
      { candidateKey: "new", shapeFingerprint: "shape-c" },
    ]);

    expect(keys).toEqual(new Set(["changed", "new"]));
  });

  it("includes existing keys when explicitly replaying selected decisions", async () => {
    const keys = await filterNewCandidateKeys(
      [{ candidateKey: "existing", shapeFingerprint: "shape-a" }],
      { includeExisting: true },
    );

    expect(keys).toEqual(new Set(["existing"]));
    expect(rows).not.toHaveBeenCalled();
  });

  it("marks reliability degraded when DeepSeek conflict rates are high", async () => {
    rows.mockResolvedValue([
      {
        decision: "human_review",
        decisionStage: "human_review",
        reasonCode: "llm_evidence_conflict",
      },
      {
        decision: "human_review",
        decisionStage: "deepseek",
        reasonCode: "llm_evidence_conflict",
      },
      {
        decision: "human_review",
        decisionStage: "deepseek",
        reasonCode: "llm_evidence_conflict",
      },
      {
        decision: "human_review",
        decisionStage: "human_review",
        reasonCode: "llm_uncertain",
      },
      {
        decision: "human_review",
        decisionStage: "human_review",
        reasonCode: "llm_uncertain",
      },
    ]);

    const stats = await readReliabilityStats();

    expect(stats.deepseekReviewed).toBe(5);
    expect(stats.contradictorySourceRate).toBe(0.6);
    expect(stats.healthy).toBe(false);
    expect(stats.degradationReason).toContain("conflicts");
  });

  it("counts grounded-review skips separately from attempted reviews", async () => {
    rows.mockResolvedValue([
      {
        decision: "human_review",
        decisionStage: "human_review",
        reasonCode: "grounded_review_disabled",
      },
      {
        decision: "human_review",
        decisionStage: "human_review",
        reasonCode: "grounded_review_degraded",
      },
      {
        decision: "human_review",
        decisionStage: "human_review",
        reasonCode: "grounded_review_cap_reached",
      },
    ]);

    const stats = await readReliabilityStats();

    expect(stats.deepseekReviewed).toBe(0);
    expect(stats.groundedReviewSkipped).toBe(3);
    expect(stats.groundedReviewDisabled).toBe(1);
    expect(stats.groundedReviewDegraded).toBe(1);
    expect(stats.groundedReviewCapReached).toBe(1);
    expect(stats.humanFallback).toBe(3);
  });

  it("counts no-source and search-failure DeepSeek fallbacks explicitly", async () => {
    rows.mockResolvedValue([
      {
        decision: "human_review",
        decisionStage: "human_review",
        reasonCode: "llm_no_source",
      },
      {
        decision: "human_review",
        decisionStage: "human_review",
        reasonCode: "llm_search_failure",
      },
      {
        decision: "human_review",
        decisionStage: "human_review",
        reasonCode: "llm_uncertain",
      },
    ]);

    const stats = await readReliabilityStats();

    expect(stats.deepseekReviewed).toBe(3);
    expect(stats.noSource).toBe(1);
    expect(stats.searchFailure).toBe(1);
    expect(stats.noSourceRate).toBeCloseTo(0.333, 3);
    expect(stats.searchFailureRate).toBeCloseTo(0.333, 3);
  });

  it("marks reliability degraded when grounded search failures are high", async () => {
    rows.mockResolvedValue(
      Array.from({ length: 5 }, () => ({
        decision: "human_review",
        decisionStage: "human_review",
        reasonCode: "llm_search_failure",
      })),
    );

    const stats = await readReliabilityStats();

    expect(stats.healthy).toBe(false);
    expect(stats.degradationReason).toContain("Search failure");
  });
});
