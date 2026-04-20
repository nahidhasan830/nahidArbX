/**
 * Types for the 9wktsbest.com main-site API (NOT the gakvx/gakqv
 * provider-level exchange host).
 *
 * Authoritative samples captured on 2026-04-20 from real user
 * responses — fields + types here reflect what the server actually
 * returned, not docs.
 *
 * Auth model:
 *   - Main site uses a JWT in `Authorization: Bearer <jwt>`.
 *   - JWT claims: { ty: 1 | 0, un: string, exp: number, iat: number, uc: number }
 *     ty=1 is the access token (~6h), ty=0 is the refresh token (~4h).
 *     uc is the currency type id (8 = BDT).
 *   - Every main-site request also needs `X-Internal-Request: 61405202`.
 *
 * Endpoints covered:
 *   - GET /api/bt/v1/user/getPlayerInfo
 *   - GET /api/bt/v1/bonus/getTurnoverList
 */

// --------------------------------------------------------------------
// Common envelope
// --------------------------------------------------------------------

/** Wrapped response shape used by every main-site /api/bt/... endpoint. */
export interface MainSiteEnvelope<T> {
  /** Business status code. "000000" = success. Non-"000000" means error. */
  status: string;
  message: string;
  messageKey: string;
  data: T;
}

/**
 * Helper: a response is successful when status is exactly "000000".
 * Anything else should be surfaced as an error; the `message` field is
 * human-readable.
 */
export function isMainSiteOk<T>(
  env: MainSiteEnvelope<T> | null | undefined,
): env is MainSiteEnvelope<T> {
  return env !== null && env !== undefined && env.status === "000000";
}

// --------------------------------------------------------------------
// GET /api/bt/v1/user/getPlayerInfo
//   ?isLogin=true&currencyTypeId=8&languageTypeId=1
//
// Returns the main-site account snapshot. Two crucial fields for us:
//   - totalMainProviderBalance — the WITHDRAWABLE balance. Aggregated
//     across providers. Lags behind provider-level betCredit (sync is
//     eventual; the user confirmed there is a delay between bet
//     settlement on the provider and the main wallet ticking up).
//   - balance — the cash wallet (separate from provider balances).
//   - providerExtraData[] — per-provider status + exposure snapshot.
//     `Cricket` / `SBOv2` / `MG` etc. Status 1 = active, 0 = disabled.
// --------------------------------------------------------------------

export interface MainSitePlayerInfo {
  userId: string; // login name, e.g. "nahidhasan"
  userName: string; // display name
  email: string | null;
  telegram: string | null;
  /** 8 = BDT. Use your own lookup table if you need the symbol. */
  currencyTypeId: number;
  /** "YYYY/MM/DD" */
  birthdayStr: string;
  accountGroupNames: string[];
  /** Cash wallet balance (separate from provider balances). */
  balance: number;
  /** 1 = active. */
  accountStatus: number;
  isResetPassword: boolean;
  signUpTimestamp: number;
  updateTimestamp: number;
  lastDepositTimestamp: number | null;
  lastWithdrawalTimestamp: number | null;
  lastLoginTimestamp: number;
  firstDepositTimestamp: number | null;
  alreadyUseKycBonusDocument: boolean;
  friendReferCode: string;
  affiliateId: number;
  affiliateCode: string;
  vipInfo: VipInfo;
  vipExInfo: VipExInfo;
  providerExtraData: ProviderExtraData[];
  /**
   * THE withdrawable balance — aggregated across the user's provider
   * wallets. Updates asynchronously after provider settlements, so
   * treat it as eventually-consistent (NOT a real-time "you can bet
   * this much" number).
   */
  totalMainProviderBalance: number;
  pendingOrdersExist: boolean;
  approvedOrdersExist: boolean;
  unreadMessageCount: number;
  isAvailableClaimRafCommission: boolean;
  isEnabledAchievementBonus: boolean;
  callingCode: string;
  phoneNumber: string;
  userHash: string;
  totalAwcBonusWalletAmount: number;
  awcBonusWalletCount: number;
  /** Active promo payload — opaque, null when none. */
  activePromotion: unknown | null;
}

export interface VipInfo {
  nextVipName: string;
  nextVipRequire: number;
  nowVipPercent: number;
  nowVipEx: number;
  nowVipRequire: number;
  nowVipName: string;
  nowVipLV: number;
  points: number;
  showUpgradeInfo: boolean;
}

/** VipInfo plus an upgradeInfo prose string. */
export interface VipExInfo extends VipInfo {
  upgradeInfo?: string;
}

export interface ProviderExtraData {
  /** Provider numeric id. Sample: 10=Saba, 28=EVO, 49=SBO, 98=Cricket, 133=AWC, 1=Microgaming. */
  providerId: number;
  /** Human label. Matches what the UI shows. */
  providerName: string;
  /** API-side code. Null for providers that don't expose one (e.g. AWC). Examples: "CRICKETV2", "SBOv2", "MG", "Saba". */
  vendorCode: string | null;
  /** 1 = active, 0 = disabled for this account. */
  status: 0 | 1;
  /**
   * Currently-held exposure on the provider, as a string. Non-zero
   * here means bets are in-flight and the provider balance is locked.
   */
  exposure: string;
}

export type MainSitePlayerInfoResponse = MainSiteEnvelope<MainSitePlayerInfo>;

// --------------------------------------------------------------------
// GET /api/bt/v1/bonus/getTurnoverList
//   ?isLogin=true&currencyTypeId=8&languageTypeId=1
//   &bonusTurnoverStats=1&pageSize=20&currentPage=1
//
// Returns the list of outstanding turnover requirements (wager
// amounts still needed before a bonus/deposit is unlocked for
// withdrawal). An EMPTY `records` array means the user can withdraw —
// there's nothing to complete.
//
// When the account has a live bonus, each record describes:
//   - total requirement
//   - amount already contributed
//   - how much remains
// The exact per-record shape isn't nailed down yet — this user's
// list is empty. Once we see a response with records, refine
// `TurnoverRecord` from the real payload. Until then it's a loose
// placeholder so callers don't crash.
// --------------------------------------------------------------------

export interface PageInfo {
  totalPage: number;
  currentPage: number;
  totalRecords: number;
  perPageSize: number;
}

/**
 * Placeholder — refine when we observe a real record. The fields
 * below are educated guesses based on common 9W bonus payloads (and
 * should NOT be relied on without verification).
 */
export interface TurnoverRecord {
  /** Human label of the bonus/deposit the turnover applies to. */
  bonusName?: string;
  /** ISO / epoch-ms timestamp the requirement was created. */
  startTimestamp?: number;
  /** Deadline (if any). */
  endTimestamp?: number;
  /** Total wager required to unlock. */
  totalTurnoverRequired?: number;
  /** Already-wagered amount that counts. */
  turnoverCompleted?: number;
  /** Outstanding amount. */
  turnoverRemaining?: number;
  /** Catch-all so unknown fields don't break parse. */
  [extra: string]: unknown;
}

export interface TurnoverListData {
  pageInfo: PageInfo;
  records: TurnoverRecord[];
}

export type TurnoverListResponse = MainSiteEnvelope<TurnoverListData>;

/**
 * User-visible rule: records empty → withdraw unlocked.
 * Exported as a helper so UI code reads naturally.
 */
export function canWithdraw(resp: TurnoverListResponse | null): boolean {
  return isMainSiteOk(resp) && resp.data.records.length === 0;
}

// --------------------------------------------------------------------
// POST /api/bt/v1/report/generateSettledBetsSummary
//   — per-day / per-vendor aggregates over a rolling window.
//     Request: { ..., queryDay: 7, pageSize: <=20, ... }
//     Records: { summaryDate, vendorId, vendorName, gameTypeId,
//                profit, turnover }
//
// POST /api/bt/v1/report/generateSettledBetsDetail
//   — individual settled bet rows for ONE (vendor, date) tuple.
//     Request: { ..., vendorId, gameTypeId, queryDate: "YYYY/MM/DD",
//                currentPage, pageSize }
//     Records: { txnTimestamp, settleTimestamp, createTimestamp,
//                settleDate, vendorName, gameName, gameNameEn,
//                gameTypeId, vendorId, betAmount, profit, turnover,
//                transactionId, vendorTxnId, txnStatusTypeId,
//                odds, betType, betResult: "win" | "lose" }
//
// POST /api/bt/v1/report/generateUnsettledBetsDetail
//   — in-flight (not-yet-settled) bets. Same window/pagination shape
//     as the summary. Records shape mirrors settled-detail minus
//     `settleTimestamp`, `settleDate`, `betResult`, `profit`.
//
// The main-site reports lag the provider's queryUnMatchTicketsAndTxns
// by some minutes (confirmed experimentally).
// --------------------------------------------------------------------

export interface SummaryBetReportQuery {
  languageTypeId: number;
  currencyTypeId: number;
  vendorIds: number[];
  gameTypeIds: number[];
  queryDay: number;
  currentPage: number;
  pageSize: number;
}

export interface DetailBetReportQuery {
  languageTypeId: number;
  currencyTypeId: number;
  vendorId: number;
  gameTypeId: number;
  /** Format "YYYY/MM/DD". */
  queryDate: string;
  currentPage: number;
  pageSize: number;
}

export interface BetReportTotals {
  totalProfitLoss: number | null;
  totalTurnover: number | null;
  totalBetAmount: number | null;
}

/** One row from the per-day / per-vendor settled summary endpoint. */
export interface SettledBetSummaryRecord {
  summaryDate: string; // "YYYY/MM/DD"
  vendorId: number;
  vendorName: string;
  gameTypeId: number;
  profit: number;
  turnover: number;
}

/** One fully-settled bet row from generateSettledBetsDetail. */
export interface SettledBetDetailRecord {
  txnTimestamp: number;
  settleTimestamp: number;
  createTimestamp: number;
  settleDate: string;
  vendorName: string;
  gameName: string;
  gameNameEn?: string;
  gameTypeId: number;
  vendorId: number;
  betAmount: number;
  profit: number;
  turnover: number;
  transactionId: number;
  vendorTxnId: string;
  txnStatusTypeId: string;
  odds: number;
  betType: string;
  betResult: "win" | "lose" | string;
}

/** One live/unsettled bet row — shares most fields with settled-detail. */
export interface UnsettledBetDetailRecord {
  txnTimestamp: number;
  createTimestamp: number;
  vendorName: string;
  gameName: string;
  gameNameEn?: string;
  gameTypeId: number;
  vendorId: number;
  betAmount: number;
  turnover?: number;
  transactionId: number;
  vendorTxnId: string;
  txnStatusTypeId: string;
  odds: number;
  betType: string;
}

export interface SettledBetsSummaryData {
  pageInfo: PageInfo;
  records: SettledBetSummaryRecord[];
  totalAmount: BetReportTotals;
}

export interface SettledBetsDetailData {
  pageInfo: PageInfo;
  records: SettledBetDetailRecord[];
  totalAmount: BetReportTotals;
}

export interface UnsettledBetsDetailData {
  pageInfo: PageInfo;
  records: UnsettledBetDetailRecord[];
  totalAmount: BetReportTotals;
}

export type SettledBetsSummaryResponse =
  MainSiteEnvelope<SettledBetsSummaryData>;
export type SettledBetsDetailResponse = MainSiteEnvelope<SettledBetsDetailData>;
export type UnsettledBetsDetailResponse =
  MainSiteEnvelope<UnsettledBetsDetailData>;
