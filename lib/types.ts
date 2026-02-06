// Extensible types - add new values as needed
export type Sport = "football";
export type Provider = "pslive" | "ninewickets";
export type MarketType = "match_winner" | "totals" | "btts";

export interface NormalizedEvent {
  id: string;
  sport: Sport;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  startTime: Date;
  providers: Partial<Record<Provider, { eventId: string; fetchedAt: Date }>>;
}

export interface Outcome {
  label: string; // 'home' | 'draw' | 'away' | 'over' | 'under' | 'yes' | 'no'
  odds: number;
  provider: Provider;
}

export interface NormalizedMarket {
  eventId: string;
  type: MarketType;
  param?: string; // e.g., "2.5" for totals
  outcomes: Outcome[];
}

export interface Stake {
  provider: Provider;
  outcome: string;
  amount: number;
  return: number;
}

export interface Arbitrage {
  id: string;
  event: NormalizedEvent;
  market: { type: MarketType; param?: string };
  outcomes: Outcome[];
  profitPct: number;
  stakes: Stake[];
  detectedAt: Date;
}

export interface ArbsResponse {
  arbs: Arbitrage[];
  count: number;
  lastUpdate: string;
}

export interface HealthResponse {
  status: "ok" | "error";
  providers: Record<Provider, { status: "ok" | "error"; lastFetch: string }>;
}

// Provider adapter contract
export interface ProviderAdapter {
  name: Provider;
  fetchEvents(): Promise<NormalizedEvent[]>;
  fetchMarkets(eventId: string): Promise<NormalizedMarket[]>;
}
