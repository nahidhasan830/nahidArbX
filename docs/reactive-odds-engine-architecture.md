# ⚡ Reactive Odds Engine — Architecture

> **Status:** Production (2026-04-30) · Replaces legacy 30s batch polling (`syncOddsOnly`)

Sub-second event-driven pipeline: WS/HTTP odds → in-memory atoms store → 500ms-debounced detection → DB persist + auto-place + SSE + Telegram.

---

## 1. Pipeline Overview

| Tier  | Name              | Components                                                 | Role                                                |
| :---: | ----------------- | ---------------------------------------------------------- | --------------------------------------------------- |
| **1** | Data Sources      | Pinnacle WS, BetConstruct WS, NineWickets HTTP, Velki HTTP | Raw odds ingestion (4 providers)                    |
| **2** | Atoms Store       | `store.ts`, `odds-history.ts`                              | In-memory state + dirty tracking + ring buffer      |
| **3** | Reactive Detector | `reactive-detector.ts`, `value-detector.ts`                | 500ms-debounced EV detection on dirty families only |
| **4** | Actions           | PostgreSQL, AutoPlacer, SSE, Telegram                      | Persist, place, notify                              |

---

## 2. Data Ingestion

All providers converge to `setOddsBatch(NormalizedOddsEntry[]) → Atoms Store → dirtyFamilies.add() → onDirtyCallback()`.

### 2.1 Pinnacle — WebSocket (sharp)

Foundation of value detection — defines true probability baseline.

| Property    | Value                                                           |
| ----------- | --------------------------------------------------------------- |
| Protocol    | STOMP over WS (`wss://www.ps388win.com/proteus-websocket/mews`) |
| Auth        | Bearer token (auto-refreshed via Cloudflare Bridge)             |
| Topic       | `/market/decimal/{eventId}/A`                                   |
| Update freq | Real-time push (~1-2s per event)                                |
| Reconnect   | Auto, 5s backoff + full re-subscribe                            |

Flow: STOMP frame → `PinnacleWsClient` → `parsePinnacleWsMessage()` → `extractPinnacleOdds()` (maps MONEYLINE/SPREAD/TOTAL_POINTS/TEAM_TOTAL → atom IDs) → `setOddsBatch()`.

**Files:** [ws-client.ts](file:///Users/nahidhasan/nahidArbX/lib/adapters/pinnacle/ws-client.ts), [ws-parser.ts](file:///Users/nahidhasan/nahidArbX/lib/adapters/pinnacle/ws-parser.ts), [pinnacle.ts](file:///Users/nahidhasan/nahidArbX/lib/atoms/mappings/pinnacle.ts)

### 2.2 NineWickets / Velki — HTTP Polling (soft)

|               |       NineWickets        |          Velki           |
| ------------- | :----------------------: | :----------------------: |
| Poll interval |        1.5s/event        |        1.5s/event        |
| Delta mode    | ✅ version + selectionTs | ✅ version + selectionTs |
| Auth overlay  | Every 60s (real account) |       None (guest)       |
| Concurrency   |   1 loop/matched event   |   1 loop/matched event   |

Flow: HTTP POST (delta) → `GeniusSportsSyncService` → `BaseAtomsAdapter.extractOdds()` → `setOddsBatch()`.

**Files:** [genius-sports-sync-service.ts](file:///Users/nahidhasan/nahidArbX/lib/services/genius-sports-sync-service.ts), [betconstruct.ts](file:///Users/nahidhasan/nahidArbX/lib/atoms/mappings/betconstruct.ts)

### 2.3 BetConstruct — Swarm WS (soft, disabled by default)

| Property    | Value                                                        |
| ----------- | ------------------------------------------------------------ |
| Protocol    | Swarm JSON over WS (`wss://eu-swarm-newm.betconstruct.com/`) |
| Auth        | Session-based (`request_session` → `sid`)                    |
| Update mode | Server pushes deltas on market/price change                  |
| Reconnect   | Auto, 2s backoff + full re-subscribe                         |

Flow: Swarm delta → `BetConstructSyncService` → `fetchGameMarkets(gameId)` → `BaseAtomsAdapter.processRawOdds()` → `setOddsBatch()`.

**Files:** [betconstruct-sync-service.ts](file:///Users/nahidhasan/nahidArbX/lib/services/betconstruct-sync-service.ts), [client.ts](file:///Users/nahidhasan/nahidArbX/lib/adapters/betconstruct/client.ts), [betconstruct.ts](file:///Users/nahidhasan/nahidArbX/lib/atoms/mappings/betconstruct.ts)

---

## 3. Atoms Store

4D in-memory map: `eventId → familyId → atomId → provider → { odds, timestamp, suspended }`.

**Write path (`setOdds`):** Upsert value → if changed: mark dirty, bump `storeVersion`, fire `onDirtyCallback()` → record tick in ring buffer. Unchanged odds are skipped (key optimization — Pinnacle sends full snapshots but most odds are stable).

**File:** [store.ts](file:///Users/nahidhasan/nahidArbX/lib/atoms/store.ts)

---

## 4. Odds History — Ring Buffer

Key: `"eventId|familyId|atomId|provider"` → `RingBuffer<{ timestamp, odds }>` (cap: 200 ticks).

**Computed metrics:** opening odds, peak, trough, movement%, steam move detection (3% in 60s = moderate, 5% in 30s = strong), sparkline (last 50 ticks).

**DB persistence:** Serialized as JSONB in `bets.odds_movement` — `{ opening, current, peak, trough, movementPct, tickCount, steamMove, sparkline[] }`.

**Memory:** ~16B/tick × 200 ticks × 200 buffers/event × 20 events ≈ **~13 MB** (bounded, never grows).

**File:** [odds-history.ts](file:///Users/nahidhasan/nahidArbX/lib/atoms/odds-history.ts)

### Odds Movement Visualization

Progressive disclosure: hover tooltip → full chart modal.

**Tooltip** (`OddsMovementTooltipContent`): Inline sparkline (SVG, 200×36px) with Open→Last, Peak/Trough, steam alerts, "Click for full chart" button. Soft provider tooltips overlay the **sharp provider's sparkline as a dashed reference line** for instant divergence visibility — the divergence IS the edge.

**Full Chart Modal** (`MovementDetailModal`, 680px): Interactive multi-provider chart via `lightweight-charts`. Clickable legend toggles per-provider visibility. Footer stats table shows per-provider Opening/Latest/Change%/Peak/Trough.

**Data flow:** `odds-history.ts` ring buffer → `AtomOddsData.movement` (per-provider) → `SpreadsheetRow.odds[provider].movement` → `OddsCell` → `Sparkline` + `OddsMovementTooltipContent`. Sharp ref computed once per row in `SpreadsheetRow`, passed only to non-sharp cells.

**Persistence:** Multi-provider movement snapshots stored as JSONB in `bets.odds_movement` keyed by provider ID. Legacy single-provider format auto-normalized on read.

**Files:** [sparkline.tsx](file:///Users/nahidhasan/nahidArbX/components/ui/sparkline.tsx), [OddsMovementTooltip.tsx](file:///Users/nahidhasan/nahidArbX/components/spreadsheet/OddsMovementTooltip.tsx), [OddsCell.tsx](file:///Users/nahidhasan/nahidArbX/components/spreadsheet/OddsCell.tsx), [MovementDetailModal.tsx](file:///Users/nahidhasan/nahidArbX/components/bets-history/MovementDetailModal.tsx)

---

## 5. Reactive Detector

Replaces the old 30s timer with event-driven 500ms detection.

1. `setOdds()` change → `onDirtyCallback()`
2. **500ms debounce** — coalesces burst of WS updates into one pass
3. **Mutex** — only one pass at a time; queues follow-up if needed
4. `consumeDirtyFamilies()` — atomic snapshot+clear of dirty set (~20-120 families, not all ~3,000+)
5. **Pre-match filter** — skip kicked-off events
6. **Value detection** — vig removal → true prob → EV% → Kelly stake
7. **Actions (parallel):** persist to PG, auto-place, SSE broadcast

### Safety Nets

| Mechanism       | Interval | Purpose                                       |
| --------------- | :------: | --------------------------------------------- |
| Heartbeat       |   30s    | Flush orphan dirty families                   |
| Stale cleanup   |  5 min   | Prune odds + history for inactive events      |
| Closing capture |   30s    | Snapshot closing odds within 5 min of kickoff |

**File:** [reactive-detector.ts](file:///Users/nahidhasan/nahidArbX/lib/background/reactive-detector.ts)

---

## 6. Value Detection Math

```
True Prob    = vig-removed Pinnacle odds (power method)
Eff. Odds    = 1 + (rawOdds - 1) * (1 - commission/100)
EV%          = (Eff. Soft Odds * True Prob - 1) * 100
Kelly Stake  = (EV / (odds - 1)) * fraction * bankroll
VALUE BET    = EV% > MIN_EV_PCT
```

**Caches:** `valueCache` (per family → `ValueBet[]`), `vigCache` (per family → `FamilyTrueOdds`). First pass warms all; subsequent passes recompute dirty families only. Evict on event removal.

**Staleness guards:** Sharp >180s → skip atom. Soft >180s → skip provider. Post-kickoff → skip event. Suspended → skip outcome.

**Files:** [value-detector.ts](file:///Users/nahidhasan/nahidArbX/lib/atoms/value-detector.ts), [vig-removal.ts](file:///Users/nahidhasan/nahidArbX/lib/atoms/vig-removal.ts)

---

## 7. Persistence

### `bets` Table (key columns)

| Column                                                | Type           | Description                                |
| ----------------------------------------------------- | -------------- | ------------------------------------------ |
| `id`                                                  | `text PK`      | Deterministic: `eventId\|familyId\|atomId` |
| `sharp_provider`                                      | `text`         | Always `"pinnacle"`                        |
| `sharp_odds` / `sharp_true_prob`                      | `numeric`      | Current Pinnacle price + vig-removed prob  |
| `soft_provider` / `soft_odds` / `soft_commission_pct` | `text/numeric` | Best soft book (by effective payout)       |
| `odds_movement`                                       | `jsonb`        | Movement snapshot                          |
| `closing_sharp_odds`                                  | `numeric`      | Pinnacle closing line (CLV baseline)       |
| `tick_count`                                          | `integer`      | Re-detection counter                       |
| `placed_at`                                           | `timestamp`    | Null until auto-placed                     |
| `outcome`                                             | `text`         | `pending/won/lost/void`                    |

> Schema cleanup (2026-04-30): Dropped `request_payload`, `response_payload`, `sharp_odds_age_ms`, `closing_soft_odds`.

### Upsert Strategy

Sharp side always updated. Soft side updated only if new `effective_payout > existing` (accounts for commission: `1 + (odds-1) * (1-comm/100)`). Movement snapshot always refreshed.

**Change detection (two tiers):** The reactive detector maintains a per-bet in-memory cache of `{sharpOdds, softOdds, softProvider}` last written to DB. Bets whose terms haven't changed are skipped entirely — no upsert, no auto-place, no snapshot computation. `tick_count` increments only when sharp odds differ or soft side is upgraded (SQL `CASE WHEN` as defense-in-depth).

**File:** [bets.ts](file:///Users/nahidhasan/nahidArbX/lib/db/repositories/bets.ts)

### Write-Performance Tuning (HOT optimization)

| Setting                           | Value | Purpose                                        |
| --------------------------------- | ----- | ---------------------------------------------- |
| `fillfactor`                      | 80    | 20% free space → HOT updates stay on same page |
| `autovacuum_vacuum_scale_factor`  | 0.02  | Vacuum at 2% dead tuples (vs default 20%)      |
| `autovacuum_vacuum_threshold`     | 50    | Or after 50 dead rows                          |
| `autovacuum_analyze_scale_factor` | 0.02  | Aggressive re-analyze                          |

**Dropped indexes** (blocked HOT): `bets_soft_provider_idx`, `bets_market_idx`, `bets_event_start_idx`. Remaining 7 indexes (PK + 6 functional) cover sort, settlement, placement dedup, provider reconciliation.

Monitor: `SELECT relname, n_tup_upd, n_tup_hot_upd, round((n_tup_hot_upd::numeric/n_tup_upd)*100,1) AS hot_pct FROM pg_stat_user_tables WHERE relname='bets';`

---

## 8. Event Lifecycle

|   Stage    | Trigger                          | Action                             |
| :--------: | -------------------------------- | ---------------------------------- |
| Discovered | `syncFixturesOnly()` every 2 min | Fetch raw fixtures                 |
|  Matched   | Entity Resolution                | Cross-provider name matching       |
| Subscribed | Sync services (60s check)        | WS subscribe or HTTP poll loop     |
|   Active   | Odds flowing                     | Dirty callbacks → detection        |
|   Stale    | Event ends/kickoff               | Removed from roster                |
|  Cleaned   | Multiple mechanisms              | Memory freed, subscriptions closed |

### Cleanup Responsibilities

| Component                 | Cleans                                       |  Cadence   |
| ------------------------- | -------------------------------------------- | :--------: |
| `PinnacleSyncService`     | WS subscriptions (diff active vs subscribed) |    60s     |
| `BetConstructSyncService` | Swarm WS subscriptions                       |    60s     |
| `GeniusSportsSyncService` | HTTP poll loops (`isRunning = false`)        |    60s     |
| `ReactiveDetector`        | Atoms store + history buffers                |   5 min    |
| `valueCache`              | Stale detection entries                      | Every pass |

---

## 9. Performance: Before vs After

| Metric              |   Batch (before)   |   Reactive (after)    |      Δ      |
| ------------------- | :----------------: | :-------------------: | :---------: |
| Detection latency   |     ~30,000 ms     |        ~500 ms        |   **60×**   |
| Pass duration       |       ~4-5s        |        ~0-2 ms        | **~2,500×** |
| Families/pass       |   ~3,000+ (all)    |    ~20-120 (dirty)    |  O(dirty)   |
| HTTP requests/cycle |       ~100+        |      0 (WS push)      | Eliminated  |
| Pinnacle API calls  | 100/cycle at 4/min |     0 (WebSocket)     | Eliminated  |
| Memory              |  Fetch cycle set   | Ring buffers (~13 MB) |   Bounded   |

---

## 10. Boot Sequence ([instrumentation.ts](file:///Users/nahidhasan/nahidArbX/instrumentation.ts))

1. Load `.env` → 2. Init Drizzle → 3. Fixture Scheduler (2 min) → 4. PinnacleSyncService (WS) → 5. GeniusSportsSyncService (HTTP) → 6. BetConstructSyncService (Swarm WS) → 7. **ReactiveDetector** (must be after sync services — needs `onDirtyCallback` registered after store is populated) → 8. Auto-Settle Scheduler → 9. Reconciler (30s)

---

## 11. System Timers

| Timer                 |   Interval   | Component                       |
| --------------------- | :----------: | ------------------------------- |
| Fixture sync          |    2 min     | `fetcher.ts`                    |
| Pinnacle WS check     |     60s      | `pinnacle-sync-service.ts`      |
| BetConstruct WS check |     60s      | `betconstruct-sync-service.ts`  |
| GeniusSports check    |     60s      | `genius-sports-sync-service.ts` |
| **Reactive debounce** |  **500ms**   | **`reactive-detector.ts`**      |
| Heartbeat             |     30s      | `reactive-detector.ts`          |
| Stale cleanup         |    5 min     | `reactive-detector.ts`          |
| Auto-settle           | configurable | `settle/scheduler.ts`           |
| Reconciler            |     30s      | `reconciler.ts`                 |
| NW auth overlay       |     60s      | `genius-sports-sync-service.ts` |

---

## 12. Telegram Commands

| Command                   | Action                                      |
| ------------------------- | ------------------------------------------- |
| `/sync fixtures`          | Immediate fixture sync                      |
| `/sync odds`              | Trigger detection pass                      |
| `/sync`                   | Full sync (fixtures + matching + detection) |
| `/scheduler pause/resume` | Pause/resume fixture timer                  |
| `/cache reset`            | Clear value + vig + response caches         |
| `/provider pinnacle off`  | Disable Pinnacle (stops WS + purge)         |

---

## 13. File Reference

### Core Pipeline

|  #  | File                                                                                                           | Role                             |
| :-: | -------------------------------------------------------------------------------------------------------------- | -------------------------------- |
|  1  | [ws-client.ts](file:///Users/nahidhasan/nahidArbX/lib/adapters/pinnacle/ws-client.ts)                          | STOMP WS client                  |
|  2  | [ws-parser.ts](file:///Users/nahidhasan/nahidArbX/lib/adapters/pinnacle/ws-parser.ts)                          | Parse WS → NormalizedOddsEntry[] |
|  3  | [genius-sports-sync-service.ts](file:///Users/nahidhasan/nahidArbX/lib/services/genius-sports-sync-service.ts) | HTTP polling for 9W/Velki        |
| 3b  | [betconstruct-sync-service.ts](file:///Users/nahidhasan/nahidArbX/lib/services/betconstruct-sync-service.ts)   | Swarm WS for BetConstruct        |
|  4  | [pinnacle-sync-service.ts](file:///Users/nahidhasan/nahidArbX/lib/services/pinnacle-sync-service.ts)           | WS subscription lifecycle        |
|  5  | [store.ts](file:///Users/nahidhasan/nahidArbX/lib/atoms/store.ts)                                              | In-memory odds + dirty tracking  |
|  6  | [odds-history.ts](file:///Users/nahidhasan/nahidArbX/lib/atoms/odds-history.ts)                                | Ring buffer                      |
|  7  | [reactive-detector.ts](file:///Users/nahidhasan/nahidArbX/lib/background/reactive-detector.ts)                 | Detection engine                 |
|  8  | [value-detector.ts](file:///Users/nahidhasan/nahidArbX/lib/atoms/value-detector.ts)                            | EV calc + cache                  |
|  9  | [vig-removal.ts](file:///Users/nahidhasan/nahidArbX/lib/atoms/vig-removal.ts)                                  | Vig removal (power method)       |
| 10  | [bets.ts](file:///Users/nahidhasan/nahidArbX/lib/db/repositories/bets.ts)                                      | Upsert value bets                |
| 11  | [auto-placer.ts](file:///Users/nahidhasan/nahidArbX/lib/betting/auto-placer.ts)                                | Strategy → placement             |
| 12  | [fetcher.ts](file:///Users/nahidhasan/nahidArbX/lib/background/fetcher.ts)                                     | Fixture scheduler                |
| 13  | [instrumentation.ts](file:///Users/nahidhasan/nahidArbX/instrumentation.ts)                                    | Boot orchestration               |

### Mappings & Config

| File                                                                                     | Purpose                       |
| ---------------------------------------------------------------------------------------- | ----------------------------- |
| [pinnacle.ts](file:///Users/nahidhasan/nahidArbX/lib/atoms/mappings/pinnacle.ts)         | Pinnacle → atom IDs           |
| [betconstruct.ts](file:///Users/nahidhasan/nahidArbX/lib/atoms/mappings/betconstruct.ts) | BetConstruct → atom IDs       |
| [constants.ts](file:///Users/nahidhasan/nahidArbX/lib/shared/constants.ts)               | Timing constants + thresholds |
| [schema.ts](file:///Users/nahidhasan/nahidArbX/lib/db/schema.ts)                         | Drizzle table definitions     |

---

## 14. Decommissioned

| Removed                                             | Replaced By                                       |
| --------------------------------------------------- | ------------------------------------------------- |
| `syncOddsOnly()`                                    | ReactiveDetector                                  |
| `scheduleNextOdds()`                                | 500ms debounce callback                           |
| `fetchAllOddsForMatchedEvents()`                    | PinnacleSyncService + GeniusSportsSyncService     |
| `beginFetchCycle()` / `endFetchCycleCleanup()`      | `pruneOddsForStaleEvents()`                       |
| `isOddsSyncInProgress()`                            | `getReactiveDetectorStats().passInProgress`       |
| 30s `oddsTimer` chain                               | 500ms debounce + 30s heartbeat                    |
| `bets.sharp_odds_age_ms`                            | Runtime staleness gate in `value-detector.ts`     |
| `bets.closing_soft_odds`                            | `bets.closing_sharp_odds` (industry-standard CLV) |
| `bets.request_payload/response_payload`             | Placement-confirmation tracker fields             |
| `bets_soft_provider_idx/market_idx/event_start_idx` | Dropped — blocked HOT, <10k rows                  |
