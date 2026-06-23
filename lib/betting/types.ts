
export interface AccountInfo {
  balance: number;
  exposure: number;
  minBet: number;
  suspended: boolean;
  currency: string;
}

export interface MarketLimits {
  minBetAmount: number;
  maxBetAmount: number;
}

export interface PlaceBetRequest {
  providerRefs: Record<string, string | number>;
  stake: number;
  odds: number;
  currency: string;
}

export type PlaceBetStatus = "placed" | "pending" | "rejected" | "error";

export interface PlaceBetResult {
  status: PlaceBetStatus;
  ticketId?: string;
  bookedOdds?: number;
  request: unknown;
  response: unknown;
  error?: string;
}

export interface ResolveRefsInput {
  normalizedEventId: string;
  familyId: string;
  atomId: string;
  homeTeam: string;
  awayTeam: string;
  sport?: string;
}

export interface BettingProviderAdapter {
  readonly providerId: string;
  readonly providerDisplayName: string;
  readonly currency: string;

  getAccountInfo(): Promise<AccountInfo>;

  getMarketLimits(
    providerRefs: Record<string, string | number>,
  ): Promise<MarketLimits | null>;

  resolveProviderRefs(
    input: ResolveRefsInput,
  ): Promise<Record<string, string | number> | null>;

  placeBet(request: PlaceBetRequest): Promise<PlaceBetResult>;
}
