import type { MatcherDecisionRow, MatcherManualDecision } from "./types";

export interface MatcherManualDecisionOverride {
  decisionId: string;
  decision: MatcherManualDecision;
  reason: string;
}

export function buildManualDecisionOverrides(
  rows: MatcherDecisionRow[],
  decisions: Record<string, MatcherManualDecision>,
  labels: Record<MatcherManualDecision, string>,
): MatcherManualDecisionOverride[] {
  return rows.flatMap((row) => {
    const decision = decisions[row.decisionId] ?? row.decision;
    if (decision === row.decision) return [];
    return [
      {
        decisionId: row.decisionId,
        decision,
        reason: `Operator changed this selected result to ${labels[decision]}.`,
      },
    ];
  });
}
