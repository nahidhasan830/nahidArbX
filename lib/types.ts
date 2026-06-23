export type Sport = "football";
export type OddsSource = "exchange" | "sportsbook";

export type { ProviderKey as Provider } from "./providers/registry";
import type { ProviderKey as Provider } from "./providers/registry";

import type { MatchSource } from "./matching/config";

export interface NormalizedEvent {
  id: string;
  sport: Sport;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  startTime: Date;
  providers: Partial<Record<Provider, { eventId: string; fetchedAt: Date }>>;
  suspended?: boolean;
  matchSource?: MatchSource;
  matchConfidence?: number;
}

export interface HealthResponse {
  status: "ok" | "error";
  providers: Record<Provider, { status: "ok" | "error"; lastFetch: string }>;
}

export interface ProviderAdapter {
  name: Provider;
  fetchEvents(): Promise<NormalizedEvent[]>;
}
