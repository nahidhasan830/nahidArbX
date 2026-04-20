# 9W Sportsbook — Bet-placement & Reconciliation Notes

This document records the hard-won findings from reverse-engineering 9W's
bet-placement and reporting surface. It exists so future debugging doesn't
have to re-discover the same pitfalls.

## 1. Two tokens, two API surfaces

9W has **two distinct token systems** and corresponding API surfaces:

| Surface                 | Host                                                              | Auth                                                                                                 | What it's for                                                  |
| ----------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Main site**           | `9wktsbest.com/api/bt/...`                                        | `Authorization: Bearer <JWT>` + `X-Internal-Request: 61405202`                                       | Account-level data: wallet, KYC, turnover, bet-report history  |
| **Provider (exchange)** | `gakqv.seofmi.live`, `gakvx.seofmi.live`, `apiplayer.seofmi.live` | `Authorization: <jsessionid>` (raw, **no "Bearer"**); URL path also needs `;jsessionid=<JSESSIONID>` | Live odds feed, placement, unmatched-tickets, provider balance |

Both are minted at the same `/api/bt/v2_1/user/login` call. After login:

- The **JWT** is in the login response body (`data.accessToken`) and can be
  re-used until it expires (~6h).
- The **jsessionid** (`queryPass`) is minted on the first exchange-API call,
  with a `.vkplayerNN` suffix (e.g. `.vkplayer01`, `.vkplayer03`). The suffix
  is the load-balancer node; the session is sticky to that node.

Our `captureSession()` captures both — JWT from the login response body and
jsessionid from the Authorization header of a subsequent XHR. localStorage is
NOT reliable (`accessToken` is sometimes empty on recent UI versions).

## 2. Single-session enforcement (IMPORTANT)

**9W allows only ONE active session per account.** When a second session
logs in, the first is terminated server-side. The server responds to
already-authenticated requests on the killed session with:

```json
{
  "status": "1001",
  "message": "You have been logged off because you have logged on at another location."
}
```

Consequence: running our Playwright auto-login while the user is manually
signed in will silently kick them off. To prevent this, we have a kill
switch in `auto-login-config.ts`. The dashboard toggles it before the user
does manual work.

## 3. Three endpoint layers for bet history

| Layer               | Endpoint                                                     | Latency | Use                                                  |
| ------------------- | ------------------------------------------------------------ | ------- | ---------------------------------------------------- |
| Provider-unmatched  | `gakqv/queryUnMatchTicketsAndTxns`                           | seconds | Find ticket id + match status of a just-placed bet   |
| Main-site-unsettled | `9wktsbest.com/api/bt/v1/report/generateUnsettledBetsDetail` | minutes | Operator view of in-flight bets across all providers |
| Main-site-settled   | `9wktsbest.com/api/bt/v1/report/generateSettledBetsSummary`  | minutes | Final profit/loss after the book settles             |

Key delay: the main-site reports lag the provider's unmatched list by
several minutes. For our DB reconciliation we primarily use the provider
endpoint (fast) and fall back to main-site-settled for PnL.

## 4. Placement payload — field mapping (learned the hard way)

We originally sent the wrong IDs and got silent rejections shaped as
`{"result":[{"status":"FAILURE","error":"Selection X is Close!"}]}`. The
correct mapping is:

| Payload field    | Source                                                                                                                                                                                            | Example      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `apiSiteType`    | constant `5` for sportsbook                                                                                                                                                                       | `5`          |
| `eventType`      | sport code, `"1"` for soccer                                                                                                                                                                      | `"1"`        |
| `eventId`        | **`catalog.eventId`** — Genius Sports internal id (from the `queryGeniusSportsEvent` response, NOT the query param)                                                                               | `"521408"`   |
| `marketId`       | `market.id` from the same catalog                                                                                                                                                                 | `"60749920"` |
| `selectionId`    | **`selection.id`**, NOT `selection.apiSiteSelectionId` — 9W silently rejects the apiSite variant with "Selection is Close!"                                                                       | `236315087`  |
| `odds`           | Client's price guard — server rejects if current market is worse than this                                                                                                                        | `2.3`        |
| `stake`          | Amount in account currency (BDT)                                                                                                                                                                  | `300`        |
| `betfairEventId` | The **exchange/betfair** event id we originally looked up with. Our ingest stores this as `event.providers["ninewickets-sportsbook"].eventId`. **Must be non-zero** or the book silently rejects. | `35486183`   |
| `handicap`       | Line for AH/O-U markets, `0` for head-to-head                                                                                                                                                     | `0`          |

Form-encoded request body:

```
apiSiteType=5
geniusSportsBets=<JSON.stringify([payload])>   (URL-encoded)
voucherId=
isOneClickBet=0
```

## 5. Response shapes from `geniusSportsBet`

Three observed outcomes (maps to our `PlaceBetStatus` union):

1. **Placed** — `result[0] = { status: "SUCCESS", ticketId: "..." }`
   → DB write at `outcome='pending'`, `providerTicketId` set.
2. **Pending (processing)** — `result[0] = { status: "SUCCESS" }` with no
   ticket id, or `status: "PENDING"/"PROCESSING"`.
   → DB write at `outcome='pending'`, `providerTicketId = null`.
   Reconciliation attaches the ticket later (see section 6).
3. **Rejected** — `result[0] = { status: "FAILURE", error: "..." }`
   → NO DB write. Notify only. Common error strings:
   - "below the minimum" → stake below book minimum
   - "The stake you have entered ..." — variant of above
   - "Insufficient" / "balance" → insufficient bet credit
   - "Bet Rejected" → generic; usually price drift
   - "Selection X is Close!" → wrong selectionId (we now send
     `selection.id`, so this should not happen)

## 6. Pending-bet reconciliation plan (DB ↔ provider)

Each placement writes a row with:

- `providerTicketId = null` (for pending) or `ticketId` (for placed)
- `providerRefs` JSON containing `eventId`, `marketId`, `selectionId`,
  `betfairEventId`
- `stake`, `odds`, `placedAt`

A **reconciliation poller** (proposed — not yet implemented):

1. Every ~30s (or when `/dashboard` loads), call
   `queryUnMatchTicketsAndTxns` for our logged-in account.
2. For each `placed_bets` row where `providerTicketId IS NULL`:
   - Match against `geniusSportsUnMatchTickets[]` by
     `(eventId, marketId, selectionId, initPrice === stake, odds)`.
   - If found → UPDATE the row to set `providerTicketId = ticket.id`.
3. For each row where `outcome = 'pending'`:
   - If the ticket is no longer in unmatched AND a corresponding entry
     appears in `geniusSportsTxns[]` with a matched status → the bet
     matched; leave `outcome='pending'` until settled.
4. For settlement, poll `generateSettledBetsSummary`:
   - Match by `ticketId` or `(eventId, marketId, selectionId, stake)`.
   - Set `outcome = 'won' | 'lost' | 'void' | 'half_won' | 'half_lost'`,
     set `settledAt`, `pnl`, `settledBySource = 'main-site-report'`.

**Reference response shapes** (see `types.ts` for the full TS interfaces):

- `GeniusSportsUnMatchTicket.id` is the ticket id we persist as
  `providerTicketId`.
- `GeniusSportsUnMatchTicket.initPrice` = stake; `lastPrice` = matched
  amount so far; `status: 9` = unmatched/pending.
- `GeniusSportsTxn.betId` joins back to the ticket.

## 7. Known WAF / anti-automation quirks

- **Missing Origin/Referer headers** → write host returns 200 with an
  empty body and a `Set-Cookie: JSESSIONID=` that wipes the session.
  Fix: always send `Origin: https://9wktsbest.com` + matching
  `sec-ch-ua-*` headers. See `BROWSER_HEADERS` in `adapter.ts`.
- **Main-site endpoints from Node curl** → Cloudflare challenge page
  (HTTP 403 with 200KB+ HTML). Works fine from inside Playwright
  because browser TLS fingerprint passes. For server-side calls we
  either (a) route through Playwright, or (b) accept the flakiness.

## 8. Test harness

`scripts/test-place-bet.ts` exercises the placement path end-to-end
against the real 9W API. Supports `--dry-run`, `--skip-real`,
`--only=<case>`, and `--event=<exchangeId>` to force a specific event.
It bypasses the placer (does NOT write to DB) so it can be run any
time without side effects on the bet log.

Verified pass (2026-04-20): all 4 cases return clean book errors,
including a real 300 BDT placement that went pending (ticket 11032510).
