import { NextRequest, NextResponse } from "next/server";
import {
  countDecisions,
  decisionCountsByDecision,
  getEventMatcherConfig,
  readCanonicalClusters,
  readImpact,
  readReliabilityStats,
} from "@/lib/event-matcher";
import { logger } from "@/lib/shared/logger";

export async function GET(_request: NextRequest) {
  try {
    const [impact, decisionCounts, reviewCount, reliability, clusters] =
      await Promise.all([
        readImpact(50),
        decisionCountsByDecision(),
        countDecisions({ decision: "human_review" }),
        readReliabilityStats(),
        readCanonicalClusters(),
      ]);

    return NextResponse.json({
      config: getEventMatcherConfig(),
      impact,
      decisionCounts,
      reviewCount,
      reliability,
      clusters,
    });
  } catch (err) {
    logger.error("MatcherLabStats", `GET failed: ${(err as Error).message}`);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
