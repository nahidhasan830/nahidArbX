# CPU & Memory Hotspots (Consolidated)

This document consolidates all identified high-impact CPU and memory issues.

## A) Original critical findings

### 1) Genius Sports Sync Service: unbounded per-event polling loops (biggest CPU culprit)

- **File:** `lib/services/genius-sports-sync-service.ts` (approx. lines 170-439)
- **Issue:** A separate long-running loop is spawned per matched event; each polls roughly every 1.5s.
- **Impact:** Large event counts create massive concurrent polling, HTTP fanout, and continuous CPU load.
- **Detail:** Recursive restarts keep loops effectively perpetual.

### 2) Odds history ring buffer memory explosion

- **File:** `lib/atoms/odds-history.ts`
- **Issue:** Keyed by `eventId|familyId|atomId|provider`; each entry pre-allocates ~200 ticks.
- **Impact:** Matchday scale can create millions of `OddsTick` objects and very high heap usage.
- **Detail:** Cleanup cadence is relatively infrequent.

### 3) Reactive detector full recompute every pass

- **File:** `lib/background/reactive-detector.ts` (approx. lines 269-366)
- **Issue:** Re-extracts features and re-scores broad sets on frequent passes, not just changed bets.
- **Impact:** High CPU plus allocation churn (feature arrays, snapshots).
- **Detail:** Dirty checks gate persistence more than compute.

### 4) Many overlapping interval/timer loops

- **Files:** multiple background modules
- **Issue:** 10s/30s/60s loops overlap across sync, health, scoring, heartbeat, model watcher, etc.
- **Impact:** Persistent baseline CPU wakeups and contention.

### 5) Closing capture high-frequency DB workload

- **File:** `lib/background/closing-capture.ts`
- **Issue:** Runs from heartbeat cadence; scans many rows and performs per-row lookups/updates.
- **Impact:** Large DB operation volume and app-side processing overhead.

### 6) Unbounded in-memory stores

- **Files:** `atoms/store.ts`, `scores/store.ts`, `scores/multi-source-store.ts`, `reactive-detector.ts`, `value-detector.ts`
- **Issue:** Multiple maps/caches can grow with weak bounds.
- **Impact:** Long-lived heap growth and slower GC.

### 7) ONNX runtime memory churn

- **File:** `lib/ml/scorer.ts`
- **Issue:** Multiple large ONNX sessions in memory; frequent new `Float32Array` allocations in batch scoring.
- **Impact:** GC pressure and memory churn during hot scoring paths.

### 8) Genius sync recursive restart behavior on error

- **File:** `lib/services/genius-sports-sync-service.ts` (approx. lines 329-338)
- **Issue:** Error path recursively restarts loop logic.
- **Impact:** Under persistent failures, loop lifecycle can thrash and duplicate work risk increases.

---

## B) Additional CPU hotspots found in independent audit

### 9) Repeated full in-memory analytics on tight dashboard polling

- **File:** `app/api/accounts/stats/route.ts` (approx. lines 35-328)
- **Issue:** Endpoint performs many full-array scans/sorts/reductions per request.
- **Impact:** CPU-heavy recomputation on each poll.

### 10) Client polling amplifies server compute fanout

- **File:** `app/dashboard/page.tsx` (approx. lines 205, 226-311, 349-353)
- **Issue:** Polls every ~15s and fetches multiple endpoints in parallel.
- **Impact:** Sustained periodic server load, especially combined with heavy stats endpoint.

### 11) BetConstruct score poller periodic per-event fanout

- **File:** `lib/scores/bc-poller.ts` (approx. lines 22, 44-58, 120-172)
- **Issue:** Every cycle iterates active events and fetches per-event markets.
- **Impact:** CPU/network/JSON parse overhead scales with live event count.

### 12) Matcher reconciliation path with poor scaling characteristics

- **Files:** `lib/matching/matcher.ts` (approx. lines 181-221), `lib/matching/locate.ts` (approx. lines 21-39)
- **Issue:** Repeated scans + normalization + array ops during decision-cache reconciliation.
- **Impact:** Can approach O(decisions × events) behavior under load.

### 13) Connection contention uses frequent wait polling

- **File:** `lib/adapters/betconstruct/client.ts` (approx. lines 103-124)
- **Issue:** 100ms interval-based waiting while connection is in progress.
- **Impact:** Extra timer wakeups/CPU under concurrent callers.

### 14) Pre-resolve path does many sequential resolver operations

- **File:** `lib/matching/normalize.ts` (approx. lines 147-214)
- **Issue:** Large per-sync normalization/resolution workload.
- **Impact:** CPU overhead from repeated transforms/object churn.

### 15) UI deep-equality via repeated JSON serialization

- **File:** `components/spreadsheet/ValueBetSpreadsheet.tsx` (approx. lines 617-671)
- **Issue:** `JSON.stringify` used for equality checks in refresh path.
- **Impact:** avoidable client CPU churn on frequent updates.

---

## C) Additional memory hotspots found in independent audit

### 16) Unbounded provider diagnostics history

- **File:** `lib/shared/session-diagnostics.ts` (approx. lines 40-57, 70-101, 133-143)
- **Issue:** Provider map and per-provider step arrays append over time without hard caps/TTL.
- **Impact:** Long-lived memory growth.

### 17) Circuit-breaker provider registry growth without lifecycle bounds

- **File:** `lib/shared/circuit-breaker.ts` (approx. lines 69, 95-123, 163-170)
- **Issue:** Provider tracking map grows as new IDs appear; no explicit eviction.
- **Impact:** Retained policy/handler state for process lifetime.

### 18) Competition enrichment cache unbounded and stores bulky payloads

- **File:** `lib/ml/competition-enrichment.ts` (approx. lines 39-44, 56-64, 221-240, 355-412, 421-446)
- **Issue:** Cache map has no size/TTL; entries can include raw AI response payloads.
- **Impact:** Significant heap growth risk over long runtimes.

### 19) Event-bus connection bookkeeping may retain closures/listeners

- **File:** `lib/events/event-bus.ts` (approx. lines 96, 131-153, 161-167)
- **Issue:** Unsubscribe closures stored in map until explicitly removed.
- **Impact:** If unsubscribe paths are missed, listener/closure retention can accumulate.

### 20) SSE serialization creates sustained allocation pressure

- **File:** `lib/shared/engine-http.ts` (approx. lines 225-230, 243-257)
- **Issue:** Frequent `JSON.stringify` for stream messages.
- **Impact:** Not a strict leak, but high allocation churn and GC pressure.

### 21) Match/fingerprint caches depend on perfect prune cadence

- **File:** `lib/matching/match-cache.ts` (approx. lines 25-27, 80-99, 104-116)
- **Issue:** Long-lived maps rely on prune calls; no TTL/size backstop.
- **Impact:** Retention risk when prune conditions are imperfect.

### 22) Settlement alias canonical cache is grow-only unless cleared

- **File:** `lib/settle/aliases.ts` (approx. lines 177, 188-225, 246-251)
- **Issue:** Module-level canonical map can keep growing.
- **Impact:** Memory growth risk if lifecycle cleanup is incomplete.

### 23) Market limits store is grow-only across provider/event/atom keys

- **File:** `lib/atoms/market-limits-store.ts` (lines 27-63)
- **Issue:** Global `Map` keyed by `provider|eventId|atomId` is written continuously and only ever cleared manually.
- **Impact:** Stale market-limit entries for finished/rotated events can accumulate for the lifetime of the process.

### 24) SofaScore day-events cache keeps full daily event arrays without size backstop

- **File:** `lib/settle/sources/sofascore.ts` (lines 153-214)
- **Issue:** `eventsByDate` caches entire `SofaEvent[]` payloads per date with TTL-based freshness, but no max entry count or background eviction.
- **Impact:** Settlement across many unique historical dates can retain many large day-level arrays simultaneously.

### 25) Dashboard delta snapshot duplicates the full live value-bet set in memory

- **File:** `lib/cache/delta.ts` (lines 59-88, 100-171)
- **Issue:** `lastSnapshot` holds a full `Map` and `Set` copy of all current value bets between delta computations.
- **Impact:** This is not a leak in the classic sense, but it doubles retention for the active value-bet working set and increases heap pressure when the set is large.

### 26) AI decision cache is effectively grow-only unless manually cleared

- **File:** `lib/matching/ai-decision-cache.ts` (lines 77-127, 228-269)
- **Issue:** Cached decisions are loaded into a process-global `Map`, persisted to disk, and never evicted by age or size.
- **Impact:** Long-running operator review history can permanently grow resident memory and on-disk cache size.

### 27) Pinnacle score WebSocket subscriptions are added from a read path without stale unsubscribe

- **Files:** `lib/shared/engine-value-bets.ts` (lines 294-303), `lib/scores/websocket.ts` (lines 34-43, 363-421)
- **Issue:** Building the value-bets response calls `subscribeToScores(liveEventIds)`, which appends to the singleton `subscribed` set. There is no corresponding diff/unsubscribe in this path when events leave the 3h live window.
- **Impact:** The score WebSocket can keep subscriptions, subscription IDs, socket listeners, and score-store writes alive for old events until an explicit disconnect or process restart.
- **Detail:** `unsubscribeFromScore()` exists, but no call path was found that reconciles the subscribed set against the current live roster.

### 28) Multi-source score provider index grows with every matched provider event id

- **Files:** `lib/scores/multi-source-store.ts` (lines 28-42, 122-170, 444-464), `lib/background/fetcher.ts` (lines 786-834)
- **Issue:** `providerIdIndex` is populated for every matched event on each fixture sync. Cleanup only removes index entries whose normalized event has an old `multiScoreStore` entry removed by age; events that are registered but never receive a source score never enter `multiScoreStore`, so their provider-index entries are not pruned by `cleanupOldMultiScores()`.
- **Impact:** Provider event id mappings can grow for every rotated/expired fixture, especially for pre-match events that never go live or never produce score messages.
- **Detail:** `persistedTerminalIds` is coupled to `multiScoreStore` cleanup too, so terminal-event retention depends on score entries aging out successfully.

### 29) Pinnacle odds STOMP resubscribe can duplicate underlying broker subscriptions

- **Files:** `lib/adapters/pinnacle/ws-client.ts` (lines 17-35, 76-93, 102-132, 146-148), `lib/services/pinnacle-sync-service.ts` (lines 103-118)
- **Issue:** `activeSubscriptions` is bounded by cleanup, but `resubscribeAll()` calls `doSubscribe(ctx)` on reconnect without first unsubscribing or clearing `ctx.stompSub`. If the STOMP client reconnects/re-activates more than once, old subscription objects can be overwritten and become impossible to unsubscribe by handle.
- **Impact:** Duplicate broker subscriptions can retain callbacks and process the same odds updates multiple times after reconnect churn.
- **Detail:** `deactivate()` also only deactivates the client and does not clear `activeSubscriptions`, so provider-disable paths rely on later roster cleanup rather than immediate local state release.

### 30) Sportsbook pending-confirmation maps have no hard cap during provider/feed outages

- **Files:** `lib/betting/ninewickets/placement-confirmation.ts` (lines 126-202), `lib/betting/velki/placement-confirmation.ts` (lines 65-128)
- **Issue:** Both trackers keep provider-specific global pending maps and remove entries only from the poll tick. Under feed outages or stuck poller failures, registrations can continue to accumulate without a max pending count.
- **Impact:** Auto-place bursts during a provider incident can retain full bet context, dashboard URLs, and notification payload data until ticks recover and time out.
- **Detail:** The normal deadline path is bounded, but there is no backpressure when `pending.size` is already high.

### 31) Auth rate limiter has no hard cardinality cap

- **File:** `lib/auth/rate-limit/index.ts` (lines 30-210)
- **Issue:** `rateLimitStore` is an in-process singleton map keyed by arbitrary identifier. Cleanup runs every 10 minutes and removes old unblocked entries, but there is no maximum key count or early cleanup on insert.
- **Impact:** A burst of unique identifiers can retain many entries for up to an hour and can exhaust memory before the periodic cleanup catches up.
- **Detail:** This is low risk for trusted localhost usage, higher risk if auth endpoints become internet-facing.

### 32) Client-side ETag cache retains full value-bets responses per URL variant

- **File:** `components/hooks/useInfiniteEvents.ts` (lines 95-184)
- **Issue:** Module-level `etagCache` stores `{ etag, data }` keyed by full `/api/value-bets?...` URL and has no max size, TTL, or cleanup on filter/search churn.
- **Impact:** Each distinct search/filter/page URL can retain a full `DashboardApiResponse` payload in browser memory even after React Query's own `gcTime` would release query data.
- **Detail:** This duplicates TanStack Query caching rather than integrating ETags into the query cache lifecycle.

### 33) Telegram destructive-confirmation store only garbage-collects on interaction

- **File:** `lib/telegram/confirm.ts` (lines 14-41)
- **Issue:** `pending` has a 2-minute TTL, but expired entries are removed only when `createConfirm()` or `takeConfirm()` calls `gc()`. There is no background cleanup and no max pending count.
- **Impact:** If users create many confirmation prompts and then stop interacting, closures captured in `run()` remain retained until the next confirmation/callback.
- **Detail:** Individual entries are short-lived in intent, but `run()` closures may capture command context and provider/client state.

### 34) Unmapped sportsbook market observability can spike between log intervals

- **File:** `lib/atoms/mappings/ninewickets-sportsbook.ts` (lines 73-94)
- **Issue:** `unmappedCounts` accumulates distinct raw market names until the periodic top-10 debug log clears it; there is no max key count between log windows.
- **Impact:** Unexpected provider payloads with many unique market names can create a short-lived but avoidable memory spike.
- **Detail:** This is not a long-run leak because the map clears after logging, but it is still a burst-retention risk in malformed-feed scenarios.

---

## D) Phased priority plan

### Phase 1 — Immediate containment: biggest heap and timer offenders

1. **Per-event Genius loops + recursive restart behavior** (`lib/services/genius-sports-sync-service.ts`)
   - Highest combined CPU + lifecycle risk.
   - Fix first because loop multiplication can amplify several downstream memory/queue problems.

2. **Odds history ring buffer explosion** (`lib/atoms/odds-history.ts`)
   - Highest direct heap-growth risk from sheer object count.
   - Add hard caps and lifecycle pruning before tuning lower-impact caches.

3. **Core unbounded stores** (`lib/atoms/store.ts`, `lib/scores/store.ts`, `lib/scores/multi-source-store.ts`, `lib/background/reactive-detector.ts`, `lib/atoms/value-detector.ts`)
   - Central long-lived stores shape overall heap size.
   - Put explicit eviction, TTL, or event-lifecycle cleanup here early.

4. **Competition enrichment cache** (`lib/ml/competition-enrichment.ts`)
   - Stores bulky AI-enrichment payloads with no bounds.
   - High memory-per-entry makes this an early containment target.

### Phase 2 — High-value structural cleanup: prevent long-run retention drift

5. **Reactive detector recomputation + ML scorer churn** (`lib/background/reactive-detector.ts`, `lib/ml/scorer.ts`)
   - Mostly CPU/allocation churn rather than classic leaks, but it drives GC pressure and heap instability.

6. **Session diagnostics history** (`lib/shared/session-diagnostics.ts`)
   - Easy source of silent long-run growth.

7. **Market limits store** (`lib/atoms/market-limits-store.ts`)
   - Straightforward grow-only map tied to event churn.

8. **AI decision cache** (`lib/matching/ai-decision-cache.ts`)
   - Useful persistence, but it needs retention policy because operator review history can grow forever.

9. **SofaScore day-events cache** (`lib/settle/sources/sofascore.ts`)
   - Large payload retention risk when many historical settlement dates are touched.

10. **Pinnacle score subscriptions + multi-source score provider index** (`lib/scores/websocket.ts`, `lib/shared/engine-value-bets.ts`, `lib/scores/multi-source-store.ts`)
    - Score tracking can retain event ids and subscriptions beyond event lifecycle.
    - Add active-roster diffing for subscriptions and prune provider-index entries by current fixture ids, not only by scored-entry age.

11. **Circuit-breaker registry + settlement alias cache + match cache** (`lib/shared/circuit-breaker.ts`, `lib/settle/aliases.ts`, `lib/matching/match-cache.ts`)
    - Each item is smaller individually, but together they create process-lifetime retention drift.

### Phase 3 — Secondary retention and bookkeeping hardening

12. **Pinnacle odds STOMP reconnect lifecycle** (`lib/adapters/pinnacle/ws-client.ts`, `lib/services/pinnacle-sync-service.ts`)
    - Prevent duplicate subscription handles on reconnect/deactivate.

13. **Event-bus listener bookkeeping** (`lib/events/event-bus.ts`)
    - Important correctness/lifecycle hardening, especially if subscriber cleanup is imperfect.

14. **Dashboard delta snapshot duplication** (`lib/cache/delta.ts`)
    - More of a resident-memory multiplier than a leak, but worth tightening once bigger stores are capped.

15. **Auth and Telegram pending maps** (`lib/auth/rate-limit/index.ts`, `lib/telegram/confirm.ts`, `lib/betting/*/placement-confirmation.ts`)
    - Add max cardinality/backpressure and periodic cleanup so incident bursts cannot retain unlimited pending state.

16. **Client-side value-bets ETag cache** (`components/hooks/useInfiniteEvents.ts`)
    - Add small LRU/TTL or rely on TanStack Query data instead of a second unbounded response cache.

17. **Closing capture workload side-effects** (`lib/background/closing-capture.ts`)
    - Primarily CPU/DB-heavy, but it can indirectly increase allocation and transient memory pressure under load.

### Phase 4 — Allocation churn and poll-amplification follow-up

18. **Dashboard polling + heavy stats recompute** (`app/dashboard/page.tsx`, `app/api/accounts/stats/route.ts`)
19. **BetConstruct score poller fanout** (`lib/scores/bc-poller.ts`)
20. **Matcher reconciliation / normalization hot paths** (`lib/matching/matcher.ts`, `lib/matching/locate.ts`, `lib/matching/normalize.ts`)
21. **SSE serialization churn** (`lib/shared/engine-http.ts`)
22. **Connection wait polling** (`lib/adapters/betconstruct/client.ts`)
23. **UI JSON serialization equality checks** (`components/spreadsheet/ValueBetSpreadsheet.tsx`)
24. **Unmapped-market debug counter burst retention** (`lib/atoms/mappings/ninewickets-sportsbook.ts`)

These are worth fixing, but they should come after the clear heap-retention issues above because they are mostly CPU/allocation amplifiers rather than the primary sources of memory growth.

---

## E) Recommended execution order by work type

### Pass 1 — Add hard bounds everywhere memory can grow forever

- Introduce size caps / TTL / event-lifecycle pruning for:
  - `odds-history.ts`
  - core stores in `atoms/store.ts`, `scores/store.ts`, `scores/multi-source-store.ts`, `value-detector.ts`
  - `competition-enrichment.ts`
  - `session-diagnostics.ts`
  - `market-limits-store.ts`
  - `ai-decision-cache.ts`
  - `sofascore.ts`
  - `scores/websocket.ts`
  - `scores/multi-source-store.ts`
  - `match-cache.ts`
  - `aliases.ts`
  - `circuit-breaker.ts`
  - `auth/rate-limit/index.ts`
  - `telegram/confirm.ts`
  - `betting/*/placement-confirmation.ts`
  - `components/hooks/useInfiniteEvents.ts`

### Pass 2 — Collapse or centralize runaway polling/loop lifecycles

- Rework `genius-sports-sync-service.ts` to avoid one perpetual loop per event and remove recursive restart patterns.
- Review overlapping timers so idle/background work shares cadence where possible.

### Pass 3 — Reduce duplicated snapshots and allocation churn

- Tighten `reactive-detector.ts`, `ml/scorer.ts`, `cache/delta.ts`, and SSE payload generation.
- Replace full-copy/snapshot patterns where incremental state is enough.

### Pass 4 — Trim compute fanout that keeps re-triggering memory pressure

- Reduce dashboard polling and heavy stats recomputation.
- Reduce per-event score polling and repeated reconciliation/normalization work.
