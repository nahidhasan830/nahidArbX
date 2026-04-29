/**
 * Shared types for the ML-Enhanced Market Diagnostics UI.
 */

export interface DiscoveryCluster {
  id: string;
  clusterName: string;
  totalOccurrences: number;
  providersCount: number;
  markets: Array<{
    provider: string;
    marketKey: string;
    marketName: string;
    occurrenceCount: number;
    samplePayload: unknown;
    prediction?: {
      targetAtom: string;
      probability: number;
    };
  }>;
}

export interface InspectorRawMarket {
  id: string;
  provider: string;
  marketKey: string;
  marketName: string;
  status: "mapped" | "unmapped";
  mappedAtomId?: string;
  samplePayload: unknown;
}

export interface AnomalyRow {
  id: string;
  eventId: string;
  familyId: string;
  atomId: string;
  softProvider: string;
  sharpProvider: string;
  softOdds: number;
  sharpOdds: number;
  ipSoft: number;
  ipSharp: number;
  deviationPct: number;
  anomalyType: "participant_reversal" | "extreme_deviation";
  timestamp: string;
}

export type UnifiedDiagnosticRow =
  | (InspectorRawMarket & {
      rowType: "unmapped";
      occurrenceCount?: number;
      deviationPct?: undefined;
      anomalyType?: undefined;
      softProvider?: undefined;
      sharpProvider?: undefined;
      softOdds?: undefined;
      sharpOdds?: undefined;
      eventId?: undefined;
      familyId?: undefined;
      atomId?: undefined;
      ipSoft?: undefined;
      ipSharp?: undefined;
      timestamp: string;
    })
  | (AnomalyRow & {
      rowType: "anomaly";
      occurrenceCount?: undefined;
      marketName?: undefined;
      marketKey?: undefined;
      provider?: undefined;
      samplePayload?: undefined;
    });

export interface HealthStats {
  matchedMarkets: number;
  totalAtoms: number;
  totalOddsRecords: number;
  activeEvents: number;
  unmappedCount: number;
  anomalyTotal: number;
  reversalCount: number;
  anomalyByType: Array<{
    anomalyType: string;
    count: number;
    avgDeviation: number;
  }>;
}

export type DiagnosticTypeFilter = "all" | "unmapped" | "anomaly";
export type SeverityFilter = "all" | "participant_reversal" | "extreme_deviation";
