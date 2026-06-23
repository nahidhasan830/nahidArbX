
export interface MatchingConfig {
  scoring: {
    teamWeight: number;
    competitionWeight: number;
    matchThreshold: number;
    timeBucketMs: number;
  };

  competitionHardGate: {
    enabled: boolean;
    minCompetitionScore: number;
  };

  aliasHarvesting: {
    enabled: boolean;
    minOccurrences: number;
    maxDiceDistance: number;
  };

  aiSearchEscalation: {
    enabled: boolean;
    confidenceThreshold: number;
    maxBatchSize: number;
  };
}


export type MatchSource =
  | "tier1-auto"
  | "tier1-alias"
  | "ai-confirmed"
  | "ai-search-confirmed"
  | "manual";


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
