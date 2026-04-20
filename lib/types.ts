// Extensible types - add new values as needed
export type Sport = "football";
export type OddsSource = "exchange" | "sportsbook";

// Provider type derived from central registry
export { type ProviderKey as Provider } from "./providers/registry";
import type { ProviderKey } from "./providers/registry";
type Provider = ProviderKey; // Local alias for use in this file

import type { MatchSource } from "./matching/config";

export interface NormalizedEvent {
  id: string;
  sport: Sport;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  startTime: Date;
  providers: Partial<Record<Provider, { eventId: string; fetchedAt: Date }>>;
  /** Event-level suspension (all markets blocked) - e.g., BetConstruct is_blocked */
  suspended?: boolean;
  /** How this event was matched (tier1-auto, tier2-deep, ai-confirmed, etc.) */
  matchSource?: MatchSource;
  /** Match confidence score (0-100) */
  matchConfidence?: number;
}

export interface HealthResponse {
  status: "ok" | "error";
  providers: Record<Provider, { status: "ok" | "error"; lastFetch: string }>;
}

// Provider adapter contract
export interface ProviderAdapter {
  name: Provider;
  fetchEvents(): Promise<NormalizedEvent[]>;
}
