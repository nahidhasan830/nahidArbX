
export interface NineWicketsSession {
  username: string;
  queryPass: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExp: number;
  capturedAt: string;
}

export interface PlayerInfoResponse {
  creditAllocated: number;
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

export interface ExchangeHostErrorEnvelope {
  status: string;
  message?: string;
  desc?: string;
}


export interface GeniusSportsBetPayload {
  apiSiteType: 5;
  eventType: string;
  eventId: string;
  marketId: string;
  selectionId: number;
  odds: number;
  stake: number;
  betfairEventId: number;
  handicap: number;
}

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
  status?: string;
  error?: string;
  message?: string;
}


export interface GeniusSportsUnMatchTicket {
  id: number;
  eventType: number;
  eventId: number;
  eventName: string;
  sideType: number;
  marketId: string;
  apiSiteMarketId: string;
  marketName: string;
  selectionId: number;
  selectionName: string;
  odds: number;
  initPrice: number;
  lastPrice: number;
  cancelPrice: number;
  status: number;
  taxRatio: number;
  voucherId: number;
  voucherData: unknown | null;
  createDate: number;
  updateDate: number;
  createDateStr: string;
  persistenceEnabled: number;
  inPlay: number;
  bspMarket: number;
  turnInPlayEnabled: number;
  marketType: string;
  persistenceType: number;
  categoryType: number;
}

export interface GeniusSportsTxn {
  id: number;
  betId: number;
  eventType: number;
  eventId: number;
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

export interface QueryUnMatchTicketsResponse {
  unMatchTickets: unknown[];
  unMatchTicketVersion: number;
  txns: unknown[];
  txnVersion: number;

  sportsBookTxns: unknown[];
  sportsBookTxnVersion: number;
  sportsBookVouchers: unknown[];
  sportsBookVoucherVersion: number;

  geniusSportsUnMatchTickets: GeniusSportsUnMatchTicket[];
  geniusSportsUnMatchTicketVersion: number;
  geniusSportsTxns: GeniusSportsTxn[];
  geniusSportsTxnVersion: number;
  geniusSportsVouchers: unknown[];
  geniusSportsVoucherVersion: number;

  fancyBetTxns: unknown[];
  fancyBetTxnVersion: number;
  dmFancyBetTxns: unknown[];
  dmFancyBetTxnVersion: number;

  bookMakerTxns: unknown[];
  bookMakerTxnVersion: number;
  dmBookMakerTxns: unknown[];
  dmBookMakerTxnVersion: number;

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
