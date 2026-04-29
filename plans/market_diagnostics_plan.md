# Market & Atom Diagnostics — Implementation Record

> **Status:** Implemented (v3). Last updated 2026-04-29.

## Problem Statement

Our market mapping system uses hardcoded `switch/case` logic (`lib/atoms/mappings/*.ts`) that acts as a black box. When providers alter their JSON structures or introduce new markets, the system silently drops data. When semantic mappings are slightly off (e.g., swapped Home/Away participants), the system calculates massive "Fake EV," polluting the Value Bets pipeline.

### The 5 Core Problems

1. **Semantic vs. Syntactic Equivalency** — "DNB" vs "AH 0.0" are mathematically identical but syntactically different.
2. **Participant Reversals** — Home/Away swaps between providers create massive fake EV (e.g., 1.50 vs 5.00 for the same team).
3. **Line Syntax Fragmentation** — Quarter lines like `+0.25` vs `0/0.5` fail to match.
4. **European vs. Asian Totals** — 3-way pushable totals vs 2-way totals get conflated.
5. **Time Context Bleeding** — HT vs FT vs Live odds get compared across different scopes.

## Architecture (Implemented)

### Design Philosophy: Visibility over Suppression

The system is a **non-blocking diagnostic tool**. It flags mapping anomalies without halting live betting operations. The operator investigates and fixes issues manually using the data-rich `/lab/market-matcher` UI.

### Three Pillars

```
┌──────────────────────────────────────────────────────────────────┐
│                     SYNC PIPELINE (every 2 min)                 │
│                                                                  │
│  Provider API → Adapter → Mapper → Atoms Store → Value Detector │
│       │              │         │                        │        │
│       ▼              ▼         ▼                        ▼        │
│  [Drop Point 1] [Drop Point 2]                  [Math Check]    │
│  Unsupported     Unmapped                        IP deviation   │
│  market types    selections                      > 15% → flag   │
│       │              │                               │          │
│       ▼              ▼                               ▼          │
│  ┌─────────────────────────┐    ┌──────────────────────────┐    │
│  │   unmapped_markets (DB) │    │  market_anomalies (DB)   │    │
│  │   upsert on composite   │    │  upsert on composite     │    │
│  │   key, increment count  │    │  key, flag not block     │    │
│  └────────────┬────────────┘    └────────────┬─────────────┘    │
│               │                              │                   │
│               └──────────┬───────────────────┘                   │
│                          ▼                                       │
│              ┌───────────────────────┐                           │
│              │  /lab/market-matcher   │                           │
│              │  X-Ray | Unmapped |   │                           │
│              │  Anomalies            │                           │
│              └───────────────────────┘                           │
└──────────────────────────────────────────────────────────────────┘
```

---

## Implementation Details

### 1. Database Schema (`lib/db/schema.ts`)

Two new tables:

- **`unmapped_markets`** — Captures every provider market that our mapping code can't resolve to an atom.
  - Composite unique key: `(provider, raw_market_key)`
  - On conflict: increment `occurrence_count`, update `last_seen_at`, replace `sample_payload`
  - Fields: `provider`, `raw_market_key`, `raw_market_name`, `sample_payload` (jsonb), `occurrence_count`, `first_seen_at`, `last_seen_at`

- **`market_anomalies`** — IP deviation events from the value detector's math check.
  - Fields: `event_id`, `family_id`, `atom_id`, `soft_provider`, `sharp_provider`, `ip_soft`, `ip_sharp`, `deviation_pct`, `anomaly_type`, `soft_odds`, `sharp_odds`, `dropped` (default `false`)
  - `anomaly_type`: `'participant_reversal'` (>30% IP deviation) or `'extreme_deviation'` (>15%)
  - `dropped` is always `false` — bets are flagged, not blocked

### 2. Harvester — Two Drop Points

#### Drop Point 1: Adapter Level (`lib/atoms/adapters/betconstruct.ts`)

Catches **unsupported market types** before the mapper ever sees them. When BetConstruct sends a market type not in our whitelist (e.g., `CorrectScore`, `HalfTimeFullTime`), we buffer it with a sample selection for diagnostics.

```ts
if (!isSupportedMarketType(market.type)) {
  bufferUnmappedMarket({
    provider: "betconstruct",
    rawMarketKey: `UNSUPPORTED_TYPE:${market.type}`,
    rawMarketName: market.name,
    samplePayload: { marketType, sampleSelection, selectionsCount },
  });
  continue;
}
```

#### Drop Point 2: Mapping Level (all 4 mappers)

Catches **supported market types with unrecognized selections** — the switch/case returned `null` for a specific selection value.

Files modified:
- `lib/atoms/mappings/betconstruct.ts`
- `lib/atoms/mappings/pinnacle.ts`
- `lib/atoms/mappings/ninewickets-sportsbook.ts`
- `lib/atoms/mappings/ninewickets-exchange.ts`

#### Buffer & Flush (`lib/atoms/unmapped-buffer.ts`)

Unmapped markets are buffered in-memory during each sync cycle, then flushed to Postgres in a single batch at the end via `flushUnmappedBuffer()` (called from `lib/atoms/fetcher.ts`). This avoids DB writes in the hot loop.

Dedup: uses `ON CONFLICT (provider, raw_market_key) DO UPDATE` to increment count and update timestamp. Same market appearing across multiple syncs just bumps the counter.

### 3. Anomaly Detection — Flag Only (`lib/atoms/value-detector.ts`)

The math check computes IP deviation between soft and sharp books:

```
ipDeviation = |impliedProbSoft - trueProb|
```

- **> 15%** (`ANOMALY_IP_DEVIATION_THRESHOLD`): Flagged as `extreme_deviation`
- **> 30%** (`ANOMALY_PARTICIPANT_REVERSAL_THRESHOLD`): Flagged as `participant_reversal`

**Critical design decision:** The bet is **NOT blocked**. The `continue` statement was removed. Instead:
- The `ValueBet` interface has an `anomalyFlag` field: `'participant_reversal' | 'extreme_deviation' | null`
- The anomaly is recorded to `market_anomalies` with `dropped: false`
- The bet is still emitted to the pipeline, tagged for operator investigation

### 4. UI — `/lab/market-matcher` (3 Tabs)

#### Tab 1: Market X-Ray (Primary)

**Component:** `components/lab/market-matcher/MarketXRay.tsx`

Per-event side-by-side provider odds comparison grid. The operator picks an event and sees every atom with odds from each provider in columns.

- **Layout:** Atoms as rows (grouped by family), providers as columns
- **Data source:** In-memory atoms store via `getAllOddsForAtom()`, `getFamiliesForEvent()`
- **Visual signals:**
  - Best odds → bold emerald
  - >15% deviation from group average → amber highlight
  - >30% deviation → red highlight (participant reversal territory)
  - Missing provider → gray dash `—`
  - Suspended → strikethrough + dimmed
- **IP Δ% column:** Rightmost column shows max soft-vs-sharp implied probability gap
- **Detail panel:** Click any cell → card grid showing all providers' exact odds, IP%, age
- **Auto-refresh:** 15-second polling
- **Compact density:** 11px text, 30px rows, matching DataTable compact mode
- **Scrollable:** `max-height: calc(100vh - 220px)` with sticky header + sticky left column

#### Tab 2: Unmapped (Harvester)

**Component:** `components/lab/market-matcher/HarvesterTable.tsx`

Shows unmapped markets sorted by occurrence count (highest-impact gaps first).

- **Expandable rows:** Chevron on each row reveals the raw JSON payload
- **Provider filter:** Dropdown to filter by provider
- **Auto-refresh:** 30-second polling
- Uses `<DataTable>` component

#### Tab 3: Anomalies

**Component:** `components/lab/market-matcher/AnomalyTable.tsx`

Historical log of IP deviation events.

- Shows anomaly type, soft/sharp odds, deviation %, and `dropped` status (always "No")
- Uses `<DataTable>` component

### 5. API Route (`app/api/market-diagnostics/route.ts`)

Single route with tab-based dispatch:

| Tab | Purpose | Data Source |
|-----|---------|-------------|
| `xray` | Per-event provider grid | In-memory atoms store |
| `events` | Event picker list | Matched events store |
| `unmapped` | Harvester data | `unmapped_markets` table |
| `anomalies` | Anomaly log | `market_anomalies` table |
| `stats` | Aggregate anomaly stats | `market_anomalies` table |
| `providers` | Provider list for filter | `unmapped_markets` table |

### 6. Repository (`lib/db/repositories/market-diagnostics.ts`)

- `upsertUnmappedMarket()` — ON CONFLICT upsert with count increment
- `recordAnomalyAsync()` — Fire-and-forget anomaly write (swallows errors to never block pipeline)
- `getTopUnmappedMarkets()` — Sorted by occurrence count desc
- `getRecentAnomalies()` — Sorted by created_at desc, optional eventId filter
- `getAnomalyStats()` — Count by type
- `getUnmappedProviders()` — Distinct providers list
- `clearOldUnmapped()` / `clearOldAnomalies()` — Housekeeping (not yet wired)

---

## What's NOT Implemented (Deferred)

1. **Orthogonal Contexts** — Period/phase decoupling from atoms. Not needed for current diagnostics.
2. **AI-Assisted Fix Loop** — Google AI Mode prompt generation. Operator will fix manually using the raw JSON viewer.
3. **Snapshot/Replay** — X-Ray reads from in-memory store only. No historical snapshots.
4. **Unmapped per-event** — X-Ray shows coverage gaps visually (gray dashes) but doesn't cross-reference the unmapped_markets table per event.

## Deployment Checklist

- [ ] Run `npm run db:generate` then `npm run db:migrate` for the two new tables
- [ ] Verify `/lab/market-matcher` loads with X-Ray tab
- [ ] Wait 2-3 sync cycles, then check Unmapped tab for harvested data
- [ ] Check Anomalies tab for any IP deviation flags
