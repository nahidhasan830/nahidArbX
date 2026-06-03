import { describe, expect, it } from "vitest";
import { buildManualDecisionOverrides } from "../../../components/matcher-lab/manual-overrides";
import type {
  MatcherDecisionRow,
  MatcherManualDecision,
} from "../../../components/matcher-lab/types";

const labels: Record<MatcherManualDecision, string> = {
  auto_merge: "Match",
  auto_reject: "Reject",
  human_review: "Needs review",
};

function row(
  decisionId: string,
  decision: MatcherManualDecision,
): MatcherDecisionRow {
  return {
    decisionId,
    decision,
  } as MatcherDecisionRow;
}

describe("buildManualDecisionOverrides", () => {
  it("does not save unchanged needs-review rows as manual overrides", () => {
    const items = buildManualDecisionOverrides(
      [row("decision-1", "human_review")],
      { "decision-1": "human_review" },
      labels,
    );

    expect(items).toEqual([]);
  });

  it("only includes rows changed by the operator", () => {
    const items = buildManualDecisionOverrides(
      [
        row("decision-1", "human_review"),
        row("decision-2", "auto_merge"),
        row("decision-3", "auto_reject"),
      ],
      {
        "decision-1": "auto_merge",
        "decision-2": "auto_merge",
        "decision-3": "human_review",
      },
      labels,
    );

    expect(items).toEqual([
      {
        decisionId: "decision-1",
        decision: "auto_merge",
        reason: "Operator changed this selected result to Match.",
      },
      {
        decisionId: "decision-3",
        decision: "human_review",
        reason: "Operator changed this selected result to Needs review.",
      },
    ]);
  });
});
