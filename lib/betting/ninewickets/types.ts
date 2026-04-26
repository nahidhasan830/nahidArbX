/**
 * Types for the 9wkts (NineWickets) bet-placement surface.
 */

/**
 * Session captured via Playwright login; used by Node to call the
 * exchange API directly from then on. `queryPass` is the jsessionid
 * used BOTH in the URL path (`;jsessionid=...`) and as the
 * Authorization header value.
 */
export interface NineWicketsSession {
  username: string;
  queryPass: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExp: number; // unix seconds
  capturedAt: string; // ISO8601
}

/**
 * Response from POST https://gakqv.seofmi.live/exchange/member/
 *   playerService/queryPlayerInfo;jsessionid=<JSESSIONID>
 *
 * This is the PROVIDER-LEVEL player info (9W Sportsbook / Genius
 * Sports).
 *
 *   - `betCredit` here = BETTABLE balance. This is what we spend
 *     placing bets.
 *
 * Auth: Authorization header is the raw jsessionid (no "Bearer"),
 * and the URL itself ends with `;jsessionid=<JSESSIONID>`. The
 * jsessionid carries a `.vkplayer0N` suffix identifying the
 * load-balancer backend node.
 *
 * Amounts are in account currency (BDT).
 */
export interface PlayerInfoResponse {
  creditAllocated: number;
  /** Bettable balance — what placeBet spends. */
  betCredit: number;
  coinPreference: string;
  accountSuspended: 0 | 1;
  accountSysSuspended: 0 | 1;
  accountVoidSuspended: 0 | 1;
  minBet: number;
  totalExposure: number;
  vendorQuantity: number;
  s: number;
  nt: number;
  isStreamingDisable: 0 | 1;
}

/**
 * Error envelope returned by any exchange-host endpoint when the
 * session is dead (e.g. single-session enforcement kicked the user
 * off). Real-world example:
 *   { "status": "1001",
 *     "message": "You have been logged off because you have logged
 *                 on at another location." }
 * `status: "1001"` + non-empty `message` is the signal; surface the
 * message verbatim to the user, and treat it as session-expired so
 * the retry path can re-login.
 */
export interface ExchangeHostErrorEnvelope {
  status: string;
  message?: string;
  desc?: string;
}

// --------------------------------------------------------------------
// Bet placement
//
// Endpoint:
//   POST https://gakqv.seofmi.live/exchange/member/playerService/
//     geniusSportsBet;jsessionid=<JSESSIONID>
//
// Headers:
//   Authorization: <JSESSIONID>            (raw, no "Bearer")
//   Content-Type:  application/x-www-form-urlencoded
//
// Body fields (form-encoded):
//   apiSiteType=5
//   geniusSportsBets=<JSON.stringify([GeniusSportsBetPayload])>  (URL-encoded)
//   voucherId=
//   isOneClickBet=0
//
// CRITICAL field-mapping notes — this is where our adapter is
// currently wrong:
//
//   1. `eventId` in the payload is the **Genius Sports internal
//      eventId** (e.g. "521408"), NOT the betfair/exchange event id.
//      In the queryGeniusSportsEvent catalog response this field is
//      just called `eventId` (with `apiSiteEventId` being the
//      betfair id), and it's what gets echoed into the placement.
//
//   2. `betfairEventId` is the **betfair/exchange event id** (e.g.
//      35486183 for a real Juventus fixture). It MUST be populated
//      with the real exchange id, NOT zero. Our resolveProviderRefs
//      in [adapter.ts](./adapter.ts) currently hard-codes 0 — that
//      is almost certainly why placements silently fail.
// --------------------------------------------------------------------

export interface GeniusSportsBetPayload {
  /** Always 5 for the sportsbook surface. */
  apiSiteType: 5;
  /** Sport code as a numeric string. "1" = soccer. */
  eventType: string;
  /** Genius Sports internal event id. Numeric string, e.g. "521408". */
  eventId: string;
  /** Genius Sports market id. Numeric string. */
  marketId: string;
  /** Numeric selection id. */
  selectionId: number;
  /** Decimal odds the user is willing to accept (price-guard). */
  odds: number;
  /** Stake amount in account currency (BDT). */
  stake: number;
  /**
   * Betfair/exchange event id. REQUIRED for the placement to be
   * accepted — must be the real id, never zero. See field-mapping
   * note above.
   */
  betfairEventId: number;
  /** Asian-handicap / line, or 0 for head-to-head markets. */
  handicap: number;
}

/**
 * One entry of the `result` array in a successful geniusSportsBet
 * response. Observed variants:
 *
 *   placed (confirmed immediately):
 *     { status: "SUCCESS", ticketId: "...", odds: 2.3, ... }
 *
 *   pending (book acknowledged, still processing — ticket arrives
 *   later via myBets polling):
 *     { status: "SUCCESS" }   // no ticket
 *     { status: "PENDING" }   // or isPending:true / "PROCESSING"
 *
 *   rejected (business rule):
 *     { status: "FAIL", error: "BELOW_MIN_STAKE" | "PRICE_CHANGED" | ... }
 */
export interface GeniusSportsBetResult {
  status?: string;
  error?: string;
  errorCode?: string;
  message?: string;
  ticketId?: string | number;
  orderId?: string | number;
  betId?: string | number;
  id?: string | number;
  odds?: number;
  isPending?: boolean;
  pending?: boolean;
}

export interface GeniusSportsBetResponse {
  result?: GeniusSportsBetResult[];
  /** Envelope-level error shape (used when the whole request was rejected). */
  status?: string;
  error?: string;
  message?: string;
}

// --------------------------------------------------------------------
// Bet reconciliation — queryUnMatchTicketsAndTxns
//
// Endpoint:
//   POST https://gakqv.seofmi.live/exchange/member/playerService/
//     queryUnMatchTicketsAndTxns;jsessionid=<JSESSIONID>
//
// Returns the user's CURRENTLY-PENDING exchange/sportsbook/etc bets
// grouped by engine. Confirmed shape (2026-04-20 probe): top-level
// keys are pairs of `<engine>Tickets` / `<engine>TicketVersion` (and
// some have matching `<engine>Txns` / `<engine>TxnDetails` too).
//
// Engine groups, best-known mapping:
//   unMatchTickets / txns                    — exchange (betfair-style)
//   sportsBookTxns                           — 9W "SBO" sportsbook
//   geniusSportsUnMatchTickets / Txns        — 9W Sportsbook (what we place to)
//   geniusSportsVouchers                     — free-bet tokens for 9W-SB
//   fancyBetTxns / dmFancyBetTxns            — fancy-bet engine
//   bookMakerTxns / dmBookMakerTxns          — book-maker engine
//   sbMultiBetTxns / sbMultiBetTxnDetails    — SBO multi/parlay
//   geMultiBetUnMatchTickets / ...Details    — GS multi/parlay
//   geMultiBetTxns / geMultiBetTxnDetails    — GS multi/parlay (matched)
//   sportsBookVouchers                       — SBO free-bet tokens
//
// For our purposes, the GS ("geniusSports*") entries are what matter —
// those are 9W Sportsbook bets.
//
// The `*Version` numbers are delta-sync cursors: pass the last-seen
// value as the request param of the same name to get only changes
// since then.
// --------------------------------------------------------------------

/**
 * One unmatched sportsbook ticket (Genius Sports engine). Captured
 * from a real placed-but-still-processing bet on 2026-04-20.
 */
export interface GeniusSportsUnMatchTicket {
  /** Unique ticket id — persist this for reconciliation. */
  id: number;
  eventType: number;
  /** Genius Sports internal event id (same as placement payload). */
  eventId: number;
  eventName: string;
  /** 1 = BACK, 2 = LAY (exchange-semantics, but sportsbook is always 1). */
  sideType: number;
  marketId: string;
  apiSiteMarketId: string;
  marketName: string;
  selectionId: number;
  selectionName: string;
  /** Requested odds. */
  odds: number;
  /** Stake (in account currency). */
  initPrice: number;
  /** Matched stake so far; 0 until the bet is matched. */
  lastPrice: number;
  /** Cancelled stake. */
  cancelPrice: number;
  /**
   * Lifecycle status code. Observed:
   *   9  — pending match / processing (fresh placement)
   * Other codes are undocumented; update as we see them.
   */
  status: number;
  taxRatio: number;
  voucherId: number;
  voucherData: unknown | null;
  createDate: number; // unix ms
  updateDate: number; // unix ms
  /** Human-readable timestamp in DD-MM-YYYY HH:MM format. */
  createDateStr: string;
  persistenceEnabled: number;
  inPlay: number;
  bspMarket: number;
  turnInPlayEnabled: number;
  marketType: string;
  persistenceType: number;
  categoryType: number;
}

/**
 * A Genius Sports transaction — richer than an unmatched ticket.
 * Contains `betId` linking back to the ticket, and `mappingEventId`
 * (the exchange/betfair event id).
 */
export interface GeniusSportsTxn {
  id: number;
  /** Ties this txn back to a {@link GeniusSportsUnMatchTicket.id}. */
  betId: number;
  eventType: number;
  eventId: number;
  /** The exchange/betfair event id (same as placement payload's betfairEventId). */
  mappingEventId: number;
  eventName: string;
  sideType: number;
  marketId: number;
  apiSiteMarketId: string;
  marketName: string;
  marketType: string;
  categoryType: number;
  selectionId: number;
  selectionName: string;
  odds: number;
  [extra: string]: unknown;
}

/** Response shape of queryUnMatchTicketsAndTxns. */
export interface QueryUnMatchTicketsResponse {
  // Exchange engine
  unMatchTickets: unknown[];
  unMatchTicketVersion: number;
  txns: unknown[];
  txnVersion: number;

  // 9W SBO sportsbook
  sportsBookTxns: unknown[];
  sportsBookTxnVersion: number;
  sportsBookVouchers: unknown[];
  sportsBookVoucherVersion: number;

  // 9W Sportsbook (Genius Sports) — what we care about most
  geniusSportsUnMatchTickets: GeniusSportsUnMatchTicket[];
  geniusSportsUnMatchTicketVersion: number;
  geniusSportsTxns: GeniusSportsTxn[];
  geniusSportsTxnVersion: number;
  geniusSportsVouchers: unknown[];
  geniusSportsVoucherVersion: number;

  // Fancy-bet engine
  fancyBetTxns: unknown[];
  fancyBetTxnVersion: number;
  dmFancyBetTxns: unknown[];
  dmFancyBetTxnVersion: number;

  // Book-maker engine
  bookMakerTxns: unknown[];
  bookMakerTxnVersion: number;
  dmBookMakerTxns: unknown[];
  dmBookMakerTxnVersion: number;

  // Multi-bet / parlay
  sbMultiBetTxns: unknown[];
  sbMultiBetTxnVersion: number;
  sbMultiBetTxnDetails: unknown[];
  sbMultiBetTxnDetailVersion: number;
  geMultiBetUnMatchTickets: unknown[];
  geMultiBetUnMatchTicketVersion: number;
  geMultiBetUnMatchTicketDetails: unknown[];
  geMultiBetUnMatchTicketDetailVersion: number;
  geMultiBetTxns: unknown[];
  geMultiBetTxnVersion: number;
  geMultiBetTxnDetails: unknown[];
  geMultiBetTxnDetailVersion: number;
}
