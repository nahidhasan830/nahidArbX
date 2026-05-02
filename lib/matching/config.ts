/**
 * Matching Feature Configuration
 */

export interface MatchingConfig {
  /** Scoring weights and thresholds */
  scoring: {
    teamWeight: number;
    competitionWeight: number;
    matchThreshold: number;
    /** Time bucket size in ms for Tier 1 grouping (60000 = 1 minute = exact time) */
    timeBucketMs: number;
  };

  /** Reject pairs with very different competition names */
  competitionHardGate: {
    enabled: boolean;
    /** Minimum competition Dice score to proceed (default 0.3) */
    minCompetitionScore: number;
  };

  /** Learn aliases from high-confidence auto-matches */
  aliasHarvesting: {
    enabled: boolean;
    /** Occurrences needed before promoting a candidate to real alias */
    minOccurrences: number;
    /** Max Dice distance — reject if names are TOO different (0-1, default 0.5) */
    maxDiceDistance: number;
  };

  /** Escalate uncertain ML pairs to local AI Search (Groq + web grounding)
   *  before routing to human_review. Tier 2.5 in the matching pipeline. */
  aiSearchEscalation: {
    enabled: boolean;
    /** Minimum AI Search confidence to auto-decide (0-100, default 70) */
    confidenceThreshold: number;
    /** Max pairs per AI Search batch request (hard max 20) */
    maxBatchSize: number;
  };
}

// ============================================
// Match Source Tracking
// ============================================

export type MatchSource =
  | "tier1-auto" // Tier 1 auto-match (score >= threshold)
  | "tier1-alias" // Tier 1 match that benefited from a learned alias
  | "ai-confirmed" // Gemini confirmed a near-match
  | "ai-search-confirmed" // AI Search (Groq + web) confirmed a near-match
  | "manual"; // Human manually approved

// ============================================
// Defaults
// ============================================

const DEFAULT_CONFIG: MatchingConfig = {
  scoring: {
    teamWeight: 0.7,
    competitionWeight: 0.3,
    matchThreshold: 0.85,
    timeBucketMs: 60_000, // 1 minute — events must start at the same minute
  },

  competitionHardGate: {
    enabled: true,
    minCompetitionScore: 0.3,
  },

  aliasHarvesting: {
    enabled: true,
    minOccurrences: 3,
    maxDiceDistance: 0.5,
  },

  aiSearchEscalation: {
    enabled: true,
    confidenceThreshold: 70,
    maxBatchSize: 20,
  },
};

// ============================================
// Singleton
// ============================================

let currentConfig: MatchingConfig = { ...DEFAULT_CONFIG };

export function getMatchingConfig(): MatchingConfig {
  return currentConfig;
}

export function updateMatchingConfig(
  partial: Partial<MatchingConfig>,
): MatchingConfig {
  currentConfig = {
    ...currentConfig,
    ...partial,
    scoring: { ...currentConfig.scoring, ...partial.scoring },
    competitionHardGate: {
      ...currentConfig.competitionHardGate,
      ...partial.competitionHardGate,
    },
    aliasHarvesting: {
      ...currentConfig.aliasHarvesting,
      ...partial.aliasHarvesting,
    },
    aiSearchEscalation: {
      ...currentConfig.aiSearchEscalation,
      ...partial.aiSearchEscalation,
    },
  };
  return currentConfig;
}

export function resetMatchingConfig(): void {
  currentConfig = { ...DEFAULT_CONFIG };
}
