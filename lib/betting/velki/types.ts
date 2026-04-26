/**
 * Types for the Velki Sportsbook (Velki-SB) account/auth/betting surface.
 *
 * ## Two-tier architecture (mirrors 9W's main-site / exchange-host split)
 *
 *   ┌───────────────────────────┐         ┌─────────────────────────────────┐
 *   │   MAIN TIER               │         │   PROVIDER TIER                 │
 *   │   velki.live (web)        │         │   www.fwick7ets.xyz (web)       │
 *   │   vk-sa.softtake.net (API)│  --SSO->│   saapipl.fwick7ets.xyz (API)   │
 *   │                           │ handoff │                                 │
 *   │   • DRF token auth        │         │   • JSESSIONID auth             │
 *   │     `Authorization: Token`│         │     `Authorization: <JSESSIONID>`│
 *   │   • Withdrawable wallet   │         │   • Bettable wallet (`betCredit`)│
 *   │   • Turnover history      │         │   • Fixtures + odds             │
 *   │   • User profile          │         │   • Bet placement               │
 *   └───────────────────────────┘         └─────────────────────────────────┘
 *
 * The MAIN tier is where the user logs in (plain JSON username/password
 * POST — no captcha, no Playwright). It exposes the withdrawable
 * wallet + account metadata.
 *
 * The PROVIDER tier is the actual betting backend. It looks structurally
 * identical to 9W's exchange host (gakvx.seofmi.live) — same endpoint
 * naming (queryPlayerInfo, queryGeniusSportsEvent, etc.), same
 * `;jsessionid=<...>` URL suffix, same raw-JSESSIONID-as-Authorization
 * header. Almost certainly the same upstream platform vendor.
 *
 * The "SSO handoff" — clicking the `#9wicket` button on velki.live —
 * is a 3-step dance, fully reproducible in Node (no browser needed):
 *
 *   1. GET  vk-sa.softtake.net/game/game-launch/WK/SB
 *           ?operator=gs&game_id=9weiket
 *        Headers: Authorization: Token <DRF token>
 *        → { success, data: { gameUrl: "https://saapipl.fwick7ets.xyz/
 *             apiWallet/player/YFG/login?cert=…&key=…&userId=…&
 *             eventType=9weiket&returnUrl=" } }
 *
 *   2. GET  <gameUrl>
 *        → 302 Set-Cookie: JSESSIONID=<...>.player<NN>
 *          Location: <sportsbook landing page on www.fwick7ets.xyz>
 *
 *   3. (optional) Follow the redirect to confirm the session is live
 *        — POST queryPlayerInfo at saapipl.fwick7ets.xyz with the
 *        captured JSESSIONID. If 200 + valid envelope, we're in.
 *
 * The `cert` + `key` querystring values in the gameUrl are short-lived
 * single-use tokens minted server-side; we never generate them
 * ourselves. Treat the gameUrl as opaque — just GET it with cookie-jar
 * support and capture whatever JSESSIONID lands.
 *
 * ## Why this split matters
 *
 * For value-detection (fixtures + odds reads) AND for bet placement we
 * hit the PROVIDER tier. The MAIN tier is only needed for:
 *   - Initial login (to get the DRF token)
 *   - The SSO handoff (token → JSESSIONID)
 *   - Wallet display on the dashboard (withdrawable balance)
 *   - Turnover history
 *
 * The session manager therefore needs to track BOTH layers:
 *   • token         (main, DRF, lifetime unverified)
 *   • jsessionid    (provider, set by SSO handoff, lifetime unverified)
 * On any provider-tier 401/403, retry the SSO handoff first; if that
 * fails too, re-login at the main tier and chain through. Mirror the
 * 9W SessionExpiredError pattern.
 *
 * ## Wallet drift between tiers — observed 2026-04-25
 *
 * Calling main-tier `/account/wallet` and `/turnover/list` does NOT
 * directly zero out provider-tier `betCredit` (verified in tight
 * sequence with scripts/test-velki-wallet-conflict.ts — both stayed at
 * 30.3 across all reads). However, after ~10–15 minutes of idle the
 * provider `betCredit` drifts back to 0 while the main-tier
 * withdrawable retains the full balance. A fresh SSO handoff
 * (re-running captureSession) transfers it back to the provider
 * tier. This appears to be a platform-side background rebalance
 * rather than something we trigger.
 *
 * Practical implication: the dashboard should always offer a
 * "re-login" affordance (which re-captures the JSESSIONID and pulls
 * the funds back into the provider tier), and surface BOTH balances
 * — the user wants to know that their money is intact in the main
 * wallet even when the bettable credit has drifted to 0.
 */

// ============================================================
// Session
// ============================================================

/**
 * Persisted Velki session. Tracks both tiers — the MAIN-tier DRF token
 * (from /account/login) and the PROVIDER-tier JSESSIONID (from the SSO
 * handoff after clicking `#9wicket`).
 */
export interface VelkiSession {
  username: string;
  /** Main-tier DRF token. Sent as `Authorization: Token <token>`. */
  token: string;
  /**
   * Provider-tier JSESSIONID. Sent BOTH in the URL path
   * (`;jsessionid=<JSESSIONID>`) AND as the raw Authorization header
   * value (no "Bearer", no "Token "). Mirrors 9W exactly.
   *
   * The suffix (`.player22` etc.) identifies the load-balancer node
   * — keep it intact when echoing back into Authorization / URL.
   */
  jsessionid: string;
  capturedAt: string; // ISO8601
}

// ============================================================
// MAIN tier — Auth — POST /account/login
// ============================================================

/**
 * Endpoint:
 *   POST https://vk-sa.softtake.net/account/login
 *
 * Headers:
 *   content-type: application/json
 *   origin:       https://velki.live
 *   referer:      https://velki.live/
 *
 * Body (JSON):
 *   { "username": "...", "password": "..." }
 *
 * No captcha required at the API layer (the `<span>` showing a code
 * on the velki.live login form is a client-side decoration only).
 */
export interface VelkiLoginRequest {
  username: string;
  password: string;
}

/**
 * Successful login response:
 *   {
 *     "success": true,
 *     "message": "Successfully logedin!",
 *     "data": { "token": "128598a28b340e38c58641b6a4c8fed06129e0e4" },
 *     "errcode": "0"
 *   }
 *
 * Failure responses come back with `success: false` and a non-"0"
 * `errcode`; treat any non-success as a hard auth failure (do not
 * retry blindly — wrong password should not loop).
 */
export interface VelkiLoginResponse {
  success: boolean;
  message: string;
  data: { token: string };
  errcode: string;
}

// ============================================================
// MAIN tier — SSO handoff — GET /game/game-launch/WK/SB
// ============================================================

/**
 * Endpoint:
 *   GET https://vk-sa.softtake.net/game/game-launch/WK/SB
 *       ?operator=gs&game_id=9weiket
 *
 * Headers:
 *   Authorization: Token <DRF token>
 *   Origin:        https://velki.live
 *   Referer:       https://velki.live/
 *
 * Returns the one-shot, signed gameUrl pointing at the provider-tier
 * login bridge. The browser then GETs that URL — the server replies
 * with `Set-Cookie: JSESSIONID=<...>.player<NN>` and a 302 redirect
 * into the sportsbook landing page. Capturing the JSESSIONID requires
 * a cookie jar; we DO NOT need a headless browser.
 *
 * NOTE: the `eventType` querystring on the returned gameUrl is the
 * literal string "9weiket" (sic — different from the `game_id`
 * "9weiket" path param). Don't try to "fix" the spelling.
 */
export interface VelkiGameLaunchResponse {
  success: boolean;
  message: string;
  data: {
    /**
     * Signed redirect URL into the provider-tier session bridge.
     * Single-use; expires quickly. Treat as opaque — just GET it.
     * Format observed:
     *   https://saapipl.fwick7ets.xyz/apiWallet/player/YFG/login
     *     ?cert=<short>&userId=<prefixed username>&key=<long sig>
     *     &extension1=&extension2=&extension3=&extensionJson=
     *     &eventType=9weiket&returnUrl=
     */
    gameUrl: string;
  };
  errcode: string;
}

// ============================================================
// MAIN tier — Profile — GET /account/profile
// ============================================================

/**
 * Endpoint:
 *   GET https://vk-sa.softtake.net/account/profile
 *
 * Headers:
 *   Authorization: Token <token>
 *   Referer:       https://velki.live/
 *
 * Returns the logged-in user's profile + a separate JWT for the
 * embedded live-chat widget (we do not use the live-chat JWT). The
 * `wallet` block here returns string amounts and is the snapshot at
 * profile-fetch time; for live balance use /account/wallet (numbers).
 *
 * Wallet semantics:
 *   - `credit_balance` here is the WITHDRAWABLE balance. This is the
 *     "main wallet" — it does NOT directly fund placeBet calls.
 *     Compare with `betCredit` on the provider tier (queryPlayerInfo)
 *     which is the BETTABLE balance.
 */
export interface VelkiProfileResponse {
  success: boolean;
  message: string;
  data: {
    user: {
      username: string;
      referral_code: string;
      email: string;
      wallet: {
        wallet_id: string;
        /** Amounts here are STRINGS (e.g. "0.00"). Parse before use. */
        credit_balance: string;
        available_credit_balance: string;
        coin_balance: string;
        exposure: string;
      };
      social_contact: string | null;
      upline_social_contact: string | null;
      upline_bank_book: unknown[];
      contact: string | null;
      first_name: string;
      last_name: string;
    };
    /** JWT used by the embedded live-chat widget. We do not consume this. */
    user_jwt_live_chat: string;
    user_status: {
      Locked: boolean;
      Suspend: boolean;
    };
  };
  errcode: string;
}

// ============================================================
// MAIN tier — Wallet — GET /account/wallet
// ============================================================

/**
 * Endpoint:
 *   GET https://vk-sa.softtake.net/account/wallet
 *
 * Headers:
 *   Authorization: Token <token>
 *   Referer:       https://velki.live/
 *
 * Live wallet snapshot for the WITHDRAWABLE balance. Use this (not
 * /account/profile) for the dashboard balance/exposure pill.
 */
export interface VelkiWalletResponse {
  success: boolean;
  message: string;
  data: {
    wallet: {
      /** Amounts here are NUMBERS (vs. strings in /account/profile). */
      credit_balance: number;
      available_credit_balance: number;
      coin_balance: number;
      exposure_limit: number;
    };
    user_status: {
      Locked: boolean;
      Suspend: boolean;
    };
  };
  errcode: string;
}

// ============================================================
// MAIN tier — Turnover — GET /turnover/list
// ============================================================

/**
 * Endpoint:
 *   GET https://vk-sa.softtake.net/turnover/list
 *
 * Headers:
 *   Authorization: Token <token>
 *   Referer:       https://velki.live/
 *
 * Returns the list of bonus/deposit "turnover requirements" — when
 * the agent grants a deposit bonus, it comes with a wagering
 * requirement (`required_turnover_amount`) that must be cleared
 * before the funds become withdrawable. `complete_turnover_amount`
 * tracks progress; `turnover_achieved` is a percentage string.
 *
 * Confirmed shape (sample observed 2026-04-25, two completed deposits):
 *   {
 *     "success": true,
 *     "data": { "tunovers": [ { ... } ] },   // <-- note: tunovers (sic)
 *     "errcode": "0"
 *   }
 *
 * NOTE the misspelled key `tunovers` (missing the 'r'). Do not
 * "correct" it — it's the literal wire format.
 */
export interface VelkiTurnoverEntry {
  user: string;
  /** "DEPOSIT" — likely also "BONUS", "WITHDRAWAL", etc. as variants. */
  name: string;
  title: string;
  ref_id: string;
  /** All amounts are STRINGS like "20.0000". Parse before use. */
  base_amount: string;
  required_turnover_amount: string;
  complete_turnover_amount: string;
  /** Percentage as string ("100.00", "50.00", etc.). */
  turnover_achieved: string;
  completed: boolean;
  /** ISO8601 with timezone offset (e.g. "...+06:00"). */
  end_at: string;
  created_at: string;
}

export interface VelkiTurnoverListResponse {
  success: boolean;
  message: string;
  data: {
    /** SIC: misspelled on the wire — "tunovers" without the 'r'. */
    tunovers: VelkiTurnoverEntry[];
  };
  errcode: string;
}

// ============================================================
// PROVIDER tier — queryPlayerInfo
// ============================================================

/**
 * Endpoint:
 *   POST https://saapipl.fwick7ets.xyz/member/playerService/
 *     queryPlayerInfo;jsessionid=<JSESSIONID>
 *
 * Headers:
 *   Authorization: <JSESSIONID>            (raw, no "Bearer" / "Token")
 *   Content-Type:  application/x-www-form-urlencoded
 *   Origin:        https://www.fwick7ets.xyz
 *   Referer:       https://www.fwick7ets.xyz/
 *   source:        1
 *
 * Body: empty (Content-Length: 0).
 *
 * This is the PROVIDER-LEVEL player info — NOT the main-site
 * /account/wallet. Critical fields:
 *
 *   - `betCredit`         → BETTABLE balance, what placeBet spends
 *   - `totalExposure`     → currently-exposed bettable amount
 *   - `minBet`            → server-enforced floor for placement
 *   - `accountSuspended`  → 1 = cannot place; surface error to user
 *
 * The MAIN-tier `credit_balance` is what's withdrawable; the two
 * sync with a known delay after deposit / settlement.
 *
 * Shape is structurally the same as NineWickets'
 * [PlayerInfoResponse](../ninewickets/types.ts) but with extras:
 * `customizeStake`, `oneClickBetStake`, `userCoin`,
 * `enableForecastWithCommission`. Schema below tolerates both
 * supersets — extra/missing fields don't break parsing.
 */
export interface VelkiPlayerInfoResponse {
  creditAllocated: number;
  /** Bettable balance — what placeBet spends. */
  betCredit: number;
  coinPreference: string;
  accountSuspended: 0 | 1;
  accountSysSuspended: 0 | 1;
  minBet: number;
  totalExposure: number;
  vendorQuantity: number;
  customizeStake: unknown | null;
  oneClickBetStake: unknown | null;
  userCoin: number;
  enableForecastWithCommission: 0 | 1;
  s: number;
}

// ============================================================
// Error envelopes
// ============================================================

/**
 * MAIN-tier error envelope. Confirmed shape:
 *   { success: false, message: "...", errcode: "<non-zero>" }
 *
 * On 401 / 403 the body may also be a different shape — treat HTTP
 * status as authoritative for "session expired" detection (mirror
 * the 9W SessionExpiredError pattern).
 */
export interface VelkiMainErrorEnvelope {
  success: false;
  message: string;
  errcode: string;
}

/**
 * PROVIDER-tier error envelope (mirrors 9W's
 * ExchangeHostErrorEnvelope). Returned by any saapipl.fwick7ets.xyz
 * endpoint when the JSESSIONID is dead. Real-world signal:
 *   { "status": "1001", "desc": "Not Authorized." }
 * On `status: "1001"` (or a `desc` containing "not authorized"),
 * treat as session-expired and run the SSO handoff again.
 */
export interface VelkiProviderErrorEnvelope {
  status: string;
  message?: string;
  desc?: string;
}
