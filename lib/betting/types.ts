/**
 * Shared types for the bet-placement subsystem.
 *
 * Each betting provider (9W Sportsbook, 9W Exchange, Betjili, …) implements
 * {@link BettingProviderAdapter} and registers itself in
 * `lib/betting/registry.ts`. The generic placer in `lib/betting/placer.ts`
 * uses only this interface — adding a new provider is a matter of:
 *   1. Writing an adapter that conforms to BettingProviderAdapter
 *   2. Adding it to BETTING_PROVIDERS in the registry
 *   3. (Optional) adding its default auto-place config
 */

/** Provider-agnostic account snapshot. */
export interface AccountInfo {
  balance: number;
  exposure: number;
  minBet: number;
  suspended: boolean;
  currency: string;
}

/** Stake limits for a specific market/selection, as imposed by the book. */
export interface MarketLimits {
  minBetAmount: number;
  maxBetAmount: number;
}

/** A single bet the placer wants to submit to a provider. */
export interface PlaceBetRequest {
  /**
   * All the provider-specific ids the adapter needs to build its payload.
   * The placer gets these from the value-bet's atom mapping for the
   * chosen provider. Everything under `providerRefs` is opaque to the
   * generic placer — the adapter interprets it.
   */
  providerRefs: Record<string, string | number>;
  stake: number;
  odds: number;
  currency: string;
}

/**
 * Result of submitting a bet.
 *   placed   — book acknowledged + returned a ticket id. Persist to DB.
 *   pending  — book acknowledged but is processing in the background (no
 *              ticket yet). Persist to DB at outcome='pending'; a later
 *              reconciliation job resolves it to placed/void via myBets.
 *   rejected — book rejected on a business rule (min stake, price drift,
 *              insufficient balance, suspended market…). Do NOT persist.
 *   error    — transport/auth/parse failure. Do NOT persist.
 */
export type PlaceBetStatus = "placed" | "pending" | "rejected" | "error";

/** Normalized result after submitting a bet. */
export interface PlaceBetResult {
  status: PlaceBetStatus;
  /** Book's receipt id, if the placement succeeded. */
  ticketId?: string;
  /** The actual odds the bet was booked at (may differ from request.odds). */
  bookedOdds?: number;
  /** Raw request and response for audit. */
  request: unknown;
  response: unknown;
  /** Human-readable failure reason when status !== 'placed'. */
  error?: string;
}

/**
 * Input required to resolve book-native ids for a detected value bet.
 * The values come from the value_bet row + the event in the events
 * store; the resolver is responsible for turning them into whatever
 * the book's placement endpoint wants.
 */
export interface ResolveRefsInput {
  normalizedEventId: string;
  familyId: string;
  atomId: string;
  homeTeam: string;
  awayTeam: string;
  /** Sport slug from the normalized event — used by books that key on it. */
  sport?: string;
}

/**
 * The contract every betting provider must implement. Keep it minimal —
 * everything provider-specific (auth, URL routing, payload shape) lives
 * inside the adapter.
 */
export interface BettingProviderAdapter {
  readonly providerId: string;
  readonly providerDisplayName: string;
  /** Currency code accounts in this book are denominated in (e.g. 'BDT'). */
  readonly currency: string;

  /** Current balance / exposure / suspended flag. */
  getAccountInfo(): Promise<AccountInfo>;

  /**
   * Book-imposed stake limits for a specific market/selection. Return
   * `null` if the book doesn't expose them — the placer falls back to
   * the account's global `minBet` from {@link getAccountInfo}.
   */
  getMarketLimits(
    providerRefs: Record<string, string | number>,
  ): Promise<MarketLimits | null>;

  /**
   * Translate a normalized value-bet reference into the book-native
   * ids the placement endpoint needs. Returns `null` if the bet can't
   * be resolved (e.g. market closed, catalog out of date). Generic
   * callers then skip placement with a clear log message instead of
   * submitting malformed requests.
   */
  resolveProviderRefs(
    input: ResolveRefsInput,
  ): Promise<Record<string, string | number> | null>;

  /** Submit the bet. The adapter is responsible for retries/timeouts. */
  placeBet(request: PlaceBetRequest): Promise<PlaceBetResult>;
}
