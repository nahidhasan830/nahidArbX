# NahidArbX Architecture & Implementation Progress

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           NAHIDARBX DATA PIPELINE                            │
│                                                                             │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────┐ │
│   │   PROVIDERS  │───▶│   MATCHING   │───▶│  DETECTION   │───▶│  STORE   │ │
│   │      ✅      │    │      ✅      │    │      ✅      │    │    ✅    │ │
│   └──────────────┘    └──────────────┘    └──────────────┘    └──────────┘ │
│          │                   │                   │                  │       │
│          ▼                   ▼                   ▼                  ▼       │
│   Pinnacle + 9W-Ex      String Similarity    Atoms-Based       Dual Store  │
│   + 9W-Sportsbook                             Family/Atom      (Events +   │
│                                               Detection        Atoms Odds)  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND LAYER                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                         ┌──────────────────────┐                            │
│                         │     /api/admin       │                            │
│                         │         ✅           │                            │
│                         └──────────┬───────────┘                            │
│                                    │                                        │
│                    ┌───────────────┼───────────────┐                        │
│                    ▼               ▼               ▼                        │
│           ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                │
│           │ /admin Page  │ │ /api/markets │ │Debug Machine │                │
│           │      ✅      │ │      ✅      │ │      ✅      │                │
│           └──────────────┘ └──────────────┘ └──────────────┘                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

Legend: ✅ Complete  ⚠️ Partial/In Progress  ❌ Not Started
```

---

## Current State Summary

### What's Working ✅

- **Token Capture (Pinnacle)** - Playwright-based browser automation with stealth mode (anti-bot detection)
- **Pinnacle Adapter** - Fully functional, fetches events/markets with Zod validation, configurable date range
- **NineWickets Exchange Adapter** - Exchange back odds (MATCH_ODDS, O/U 0.5/1.5/2.5)
- **NineWickets Sportsbook Adapter** - Sportsbook odds (extensive market coverage)
- **Event Matching** - Cross-provider matching with 85% similarity threshold
- **Atoms System** - Family/atom-based odds storage and retrieval
- **Value-Bet Detection** - Pinnacle-benchmarked EV + Kelly sizing (`lib/atoms/value-detector.ts`)
- **Postgres Persistence** - Drizzle + Cloud SQL, upserts detected bets each sync cycle
- **Backtest REST + AI Endpoints** - `/api/backtest/*` (list, mark, bulk-mark, ai-label, ai-analyze)
- **In-Memory Store** - Events store + hierarchical atoms odds store
- **Admin Dashboard** - Provider status, event counts, matching stats, 30s polling
- **Background Sync** - Runs every 60s (configurable), 4-phase pipeline
- **Manual Sync** - "Sync Now" button with real-time status updates
- **Markets API** - Per-event market data via /api/markets/[eventId]
- **Debug Machine** - Debugging UI components for pipeline inspection

### What's In Progress ⚠️

- _None currently - all core features complete_

### What's Not Working ❌

- _None - pipeline is fully functional_

---

## Provider Registry

All providers are defined in a central registry (`lib/providers/registry.ts`):

| Provider ID              | Short Name | Display Name  | Source     | Enabled |
| ------------------------ | ---------- | ------------- | ---------- | ------- |
| `pinnacle`               | PL         | Pinnacle      | exchange   | ✅      |
| `ninewickets-exchange`   | 9W-Ex      | 9W Exchange   | exchange   | ✅      |
| `ninewickets-sportsbook` | 9W-SB      | 9W Sportsbook | sportsbook | ✅      |

---

## Provider Authentication

### Pinnacle (via Betjili)

Pinnacle provides odds via browser-based authentication through betjili.

```
┌─────────────────────────────────────────────────────────────────┐
│                   PINNACLE TOKEN CAPTURE FLOW                    │
│                    lib/auth/token-manager.ts                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   STEP 1: Check Stored Token                                    │
│   ├── Read sessions/betjili/pinnacle-token.json                 │
│   ├── Check JWT expiry (with 5-min buffer)                      │
│   └── If valid → RETURN TOKEN                                   │
│                                                                 │
│   STEP 2: Try Stored Pinnacle URL                               │
│   ├── Read sessions/betjili/pinnacle-url.txt (contains sess=)   │
│   ├── Navigate directly to URL                                  │
│   ├── Capture token from /player/auth/authentication            │
│   └── If valid → SAVE & RETURN TOKEN                            │
│                                                                 │
│   STEP 3: Use Browser Session                                   │
│   ├── Load sessions/betjili/browser-state.json (saved cookies)  │
│   ├── Go to betjili365.com                                      │
│   ├── Click PINNACLE button → new tab opens                     │
│   ├── Wait for redirect to cc1ps.com/pinnacleSports.jsp         │
│   ├── Capture token from /player/auth/authentication            │
│   └── If valid → SAVE ALL FILES & RETURN TOKEN                  │
│                                                                 │
│   STEP 4: Full Login (Last Resort)                              │
│   ├── Navigate to betjili login page                            │
│   ├── Fill BETJILI_USERNAME & BETJILI_PASSWORD                  │
│   ├── Submit login form                                         │
│   ├── Save sessions/betjili/browser-state.json                  │
│   └── Continue to STEP 3 (click PINNACLE)                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Persisted Files:**

| File                                   | Purpose                        | TTL       |
| -------------------------------------- | ------------------------------ | --------- |
| `sessions/betjili/pinnacle-token.json` | Bearer token + expiry          | ~1 hour   |
| `sessions/betjili/pinnacle-url.txt`    | Session URL with `sess=` param | ~1 hour   |
| `sessions/betjili/browser-state.json`  | Betjili cookies/session        | ~24 hours |

### NineWickets

No authentication required for API access. Uses multiple endpoints:

```
┌─────────────────────────────────────────────────────────────────┐
│                    NINEWICKETS MARKET SOURCES                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   EXCHANGE (source: "exchange")                                 │
│   ├── Fixtures: POST gakvx.seofmi.live/queryEvents              │
│   └── Markets: POST awskvx.seofmi.live/queryMarkets             │
│       → MATCH_ODDS, O/U 0.5, 1.5, 2.5                           │
│                                                                 │
│   SPORTSBOOK (source: "sportsbook")                             │
│   ├── Events: Shares fixtures with Exchange                     │
│   └── Markets: 2-step API flow                                  │
│       → Extensive market coverage (1X2, O/U, AH, BTTS, etc.)    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Atoms Architecture

The atoms system provides a unified model for cross-provider odds comparison and value-bet detection.

### Core Concepts

```
┌─────────────────────────────────────────────────────────────────┐
│                         ATOMS MODEL                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   FAMILY = A market with mutually exclusive outcomes             │
│   ├── ID: "ft_1x2" (Full-time 1X2)                              │
│   ├── Type: "group" (3+ outcomes) or "pair" (2 outcomes)        │
│   └── Atoms: ["ft_home_win", "ft_draw", "ft_away_win"]          │
│                                                                 │
│   ATOM = A single betting outcome                                │
│   ├── ID: "ft_home_win"                                         │
│   ├── Belongs to exactly one family                             │
│   └── Has odds from multiple providers (sharp + soft)           │
│                                                                 │
│   VALUE BET = When a soft book's adjusted odds exceed the        │
│   sharp (Pinnacle) true-odds line.                              │
│   ├── sharpTrueProb = vig-removed Pinnacle probability          │
│   ├── adjustedOdds  = softOdds × (1 - commission/100)           │
│   ├── evPct         = (adjustedOdds × trueProb − 1) × 100       │
│   ├── Minimum EV threshold: 2.0%                                │
│   └── Kelly-sized stake (¼ Kelly by default)                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Atoms Store Structure

```
eventId → familyId → atomId → provider → OddsRecord
                                           ├── odds: number
                                           └── timestamp: number
```

### Key Files

| File                          | Purpose                                            |
| ----------------------------- | -------------------------------------------------- |
| `lib/atoms/atoms.json`        | Family definitions (pairs/groups, lines, atoms)    |
| `lib/atoms/types.ts`          | Type definitions (Family, Atom, BestAtomOdds, ...) |
| `lib/atoms/registry.ts`       | Family/atom lookup functions                       |
| `lib/atoms/store.ts`          | Hierarchical odds storage                          |
| `lib/atoms/fetcher.ts`        | Unified odds fetching orchestrator                 |
| `lib/atoms/value-detector.ts` | EV + Kelly value-bet detection                     |
| `lib/atoms/vig-removal.ts`    | Balanced-margin vig removal for Pinnacle odds      |
| `lib/atoms/mappings/*.ts`     | Provider-specific atom mapping                     |
| `lib/atoms/adapters/*.ts`     | Provider-specific odds fetching                    |

---

## Pipeline Stages

### Stage 1: Data Fetching ✅ COMPLETE

```
┌─────────────────────────────────────────────────────────────────┐
│ BACKGROUND SYNC (every 60 seconds)                              │
│ lib/background/fetcher.ts                                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐│
│   │Pinnacle Adapter │  │  9W-Exchange    │  │  9W-Sportsbook  ││
│   │lib/adapters/    │  │  Adapter ✅     │  │  Adapter ✅     ││
│   │pinnacle.ts ✅   │  │                 │  │                 ││
│   │                 │  │  • Live+Upcoming│  │  • Via Exchange ││
│   │• Token Manager  │  │  • queryEvents  │  │  • Same eventId ││
│   │• Zod Validation │  │  • queryMarkets │  │  • 2-step API   ││
│   └────────┬────────┘  └────────┬────────┘  └────────┬────────┘│
│            │                    │                    │          │
│            └─────────────┬──────┴────────────────────┘          │
│                          ▼                                      │
│              ┌───────────────────────┐                          │
│              │ NormalizedEvent[]     │                          │
│              │ (All providers)       │                          │
│              └───────────────────────┘                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Adapter Files:**

- `lib/adapters/pinnacle.ts` - Pinnacle events (Zod validation)
- `lib/adapters/ninewickets-exchange.ts` - Exchange events & markets
- `lib/adapters/ninewickets-sportsbook.ts` - Sportsbook (delegates to Exchange for fixtures)
- `lib/adapters/index.ts` - Adapter registry

---

### Stage 2: Event Matching ✅ COMPLETE

```
┌─────────────────────────────────────────────────────────────────┐
│ EVENT MATCHER                                                   │
│ lib/matching/matcher.ts                                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   Input: NormalizedEvent[] (from multiple providers)            │
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  STEP 1: Time Bucketing (5-minute windows)              │   │
│   │  Events grouped by start time ±5 minutes                │   │
│   └────────────────────────┬────────────────────────────────┘   │
│                            ▼                                    │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  STEP 2: String Similarity Scoring                      │   │
│   │                                                         │   │
│   │  score = 0.6 × teamSimilarity                           │   │
│   │        + 0.2 × competitionSimilarity                    │   │
│   │        + 0.2 × timeScore                                │   │
│   │                                                         │   │
│   │  timeScore = max(0, 1 - timeDiff / 7200000)            │   │
│   │  threshold = 0.85                                       │   │
│   │                                                         │   │
│   │  Competition normalization:                             │   │
│   │  - Country adjectives mapped to nouns                   │   │
│   │  - "English FA Cup" → "England FA Cup" (similarity: 1.0)│   │
│   │  - Supports 27 country mappings                         │   │
│   └────────────────────────┬────────────────────────────────┘   │
│                            ▼                                    │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  STEP 3: Merge Matched Events                           │   │
│   │  Creates single event with providers[] array            │   │
│   │  ID: "matched-{id1}-{id2}-..."                          │   │
│   │  Pinnacle prioritized as source of truth for team names│   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│   Output: NormalizedEvent[] (deduplicated, cross-provider)      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Competition Name Normalization:**

Providers use inconsistent country naming ("English FA Cup" vs "England FA Cup"). The matcher normalizes these before comparison:

| Adjective        | Normalized To       |
| ---------------- | ------------------- |
| english, british | england             |
| scottish         | scotland            |
| spanish          | spain               |
| german           | germany             |
| french           | france              |
| italian          | italy               |
| ...              | (27 total mappings) |

This improves matching for events like "Burton Albion vs West Ham" where NW uses "English FA Cup" and Pinnacle/BC use "England FA Cup".

---

### Stage 3: Odds Fetching ✅ COMPLETE

```
┌─────────────────────────────────────────────────────────────────┐
│ ATOMS FETCHER                                                   │
│ lib/atoms/fetcher.ts                                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   Input: Matched events (2+ providers)                          │
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  For each provider:                                     │   │
│   │  1. Filter events with this provider                    │   │
│   │  2. Fetch odds in parallel batches (concurrency: 10)    │   │
│   │  3. Map to atoms using provider-specific mappings       │   │
│   │  4. Store in atoms store                                │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│   Provider Adapters (lib/atoms/adapters/):                      │
│   ├── pinnacle.ts → fetchAndStorePinnacleOdds()                 │
│   ├── ninewickets-exchange.ts → fetchAndStoreNwExchangeOdds()   │
│   └── ninewickets-sportsbook.ts → fetchAndStoreNwSportsbookOdds()│
│                                                                 │
│   Provider Mappings (lib/atoms/mappings/):                      │
│   ├── pinnacle.ts → mapPinnacleToAtom()                         │
│   ├── ninewickets-exchange.ts → mapExchangeToAtom()             │
│   └── ninewickets-sportsbook.ts → mapSportsbookToAtom()         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### Stage 4: Value-Bet Detection ✅ COMPLETE

```
┌─────────────────────────────────────────────────────────────────┐
│ VALUE-BET DETECTOR                                              │
│ lib/atoms/value-detector.ts                                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  ALGORITHM (per family, per soft provider):             │   │
│   │                                                         │   │
│   │  1. Gate on Pinnacle coverage of the whole family       │   │
│   │     (need sibling atoms' odds for vig removal).         │   │
│   │                                                         │   │
│   │  2. vig-removal.ts: balanced-margin method              │   │
│   │     → sharpTrueProb (for this atom)                     │   │
│   │                                                         │   │
│   │  3. adjustedOdds = softOdds × (1 − commission/100)      │   │
│   │                                                         │   │
│   │  4. evPct = (adjustedOdds × sharpTrueProb − 1) × 100    │   │
│   │                                                         │   │
│   │  5. If evPct ≥ MIN_EV_PCT (2.0):                        │   │
│   │     b = adjustedOdds − 1, q = 1 − sharpTrueProb         │   │
│   │     kellyFraction = max(0, (b·p − q) / b)               │   │
│   │     kellyStake    = kellyFraction × KELLY_FRACTION      │   │
│   │                                × VALUE_TOTAL_STAKE      │   │
│   │                                                         │   │
│   │  6. Return ValueBet                                     │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│   Freshness gates:                                              │
│   ├── sharp snapshot ≤ MAX_VALUE_ODDS_AGE_MS (90s)              │
│   ├── soft snapshot  ≤ MAX_VALUE_ODDS_AGE_MS (90s)              │
│   └── neither side suspended                                    │
│                                                                 │
│   Persistence: detected ValueBets are upserted to Postgres      │
│   via `lib/db/repositories/value-bets.ts` (D2 dedup: first      │
│   soft-provider per (event, family, atom) wins).                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### Stage 5: Storage ✅ COMPLETE

```
┌─────────────────────────────────────────────────────────────────┐
│ DUAL STORE SYSTEM                                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   EVENTS STORE (lib/store.ts)                                   │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  Map<string, NormalizedEvent>                           │   │
│   │  ├── events → Matched events                            │   │
│   │  ├── valueBets → ValueBet[] (current in-memory set)     │   │
│   │  ├── providerStatus → Status per provider               │   │
│   │  └── syncStatus → Phase tracking, timing                │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│   ATOMS STORE (lib/atoms/store.ts)                              │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  Hierarchical: eventId → familyId → atomId → provider   │   │
│   │  ├── setOdds() / setOddsBatch()                         │   │
│   │  ├── getBestOddsForAtom()                               │   │
│   │  ├── getBestOddsForFamily()                             │   │
│   │  └── getStoreStats()                                    │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Status Matrix

| Component                 | File                                     | Status      | Notes                                    |
| ------------------------- | ---------------------------------------- | ----------- | ---------------------------------------- |
| **Core Types**            | `lib/types.ts`                           | ✅ Complete | Provider, NormalizedEvent                |
| **Provider Registry**     | `lib/providers/registry.ts`              | ✅ Complete | Central provider metadata                |
| **Config**                | `lib/config.ts`                          | ✅ Complete | fetchInterval (60s), daysAhead, pageSize |
| **Events Store**          | `lib/store.ts`                           | ✅ Complete | Events, valueBets, syncStatus            |
| **Token Manager**         | `lib/auth/token-manager.ts`              | ✅ Complete | Playwright + stealth mode                |
| **Pinnacle Adapter**      | `lib/adapters/pinnacle.ts`               | ✅ Complete | Events (Zod validation)                  |
| **9W Exchange Adapter**   | `lib/adapters/ninewickets-exchange.ts`   | ✅ Complete | Events + markets                         |
| **9W Sportsbook Adapter** | `lib/adapters/ninewickets-sportsbook.ts` | ✅ Complete | Via Exchange fixtures                    |
| **Adapter Registry**      | `lib/adapters/index.ts`                  | ✅ Complete | getEnabledAdapters()                     |
| **Event Matcher**         | `lib/matching/matcher.ts`                | ✅ Complete | 85% threshold                            |
| **Atoms Types**           | `lib/atoms/types.ts`                     | ✅ Complete | Family, Atom, BestAtomOdds               |
| **Atoms Registry**        | `lib/atoms/registry.ts`                  | ✅ Complete | Family/atom lookups                      |
| **Atoms Store**           | `lib/atoms/store.ts`                     | ✅ Complete | Hierarchical odds storage                |
| **Atoms Fetcher**         | `lib/atoms/fetcher.ts`                   | ✅ Complete | Parallel odds fetching                   |
| **Atoms Adapters**        | `lib/atoms/adapters/*.ts`                | ✅ Complete | Per-provider odds fetching               |
| **Atoms Mappings**        | `lib/atoms/mappings/*.ts`                | ✅ Complete | Provider → atom mapping                  |
| **Value-Bet Detector**    | `lib/atoms/value-detector.ts`            | ✅ Complete | Pinnacle-benchmarked EV + Kelly          |
| **Vig Removal**           | `lib/atoms/vig-removal.ts`               | ✅ Complete | Balanced-margin method                   |
| **DB Schema**             | `lib/db/schema.ts`                       | ✅ Complete | Drizzle `value_bets` table               |
| **DB Repository**         | `lib/db/repositories/value-bets.ts`      | ✅ Complete | Upsert + list + markOutcome              |
| **Backtest REST API**     | `app/api/backtest/*`                     | ✅ Complete | list / PATCH / bulk / ai-label / analyze |
| **Background Sync**       | `lib/background/fetcher.ts`              | ✅ Complete | 4-phase pipeline                         |
| **Admin API**             | `app/api/admin/route.ts`                 | ✅ Complete | Starts background scheduler              |
| **Markets API**           | `app/api/markets/[eventId]/route.ts`     | ✅ Complete | Per-event market data                    |
| **Admin Page**            | `app/admin/page.tsx`                     | ✅ Complete | Dashboard with polling                   |
| **Debug Machine**         | `components/debug-machine/*.tsx`         | ✅ Complete | Debugging components                     |

---

## File Structure

```
lib/
├── adapters/                    # Event-fetching adapters
│   ├── index.ts                 # Adapter registry
│   ├── pinnacle.ts              # Pinnacle adapter
│   ├── pinnacle/                # Pinnacle modules
│   │   ├── client.ts            # Axios client
│   │   ├── schemas.ts           # Zod schemas
│   │   ├── urls.ts              # URL builders
│   │   └── index.ts             # Re-exports
│   ├── ninewickets-exchange.ts  # 9W Exchange adapter
│   └── ninewickets-sportsbook.ts# 9W Sportsbook adapter
├── atoms/                       # Atoms odds system
│   ├── index.ts                 # Public API
│   ├── types.ts                 # Type definitions
│   ├── atoms.json               # Family definitions
│   ├── registry.ts              # Family/atom lookups
│   ├── store.ts                 # Hierarchical odds storage
│   ├── fetcher.ts               # Unified odds fetcher
│   ├── value-detector.ts       # Value-bet detection (EV + Kelly)
│   ├── vig-removal.ts          # Balanced-margin vig removal
│   ├── adapters/                # Per-provider odds fetching
│   │   ├── registry.ts          # Atoms adapter registry
│   │   ├── pinnacle.ts
│   │   ├── ninewickets-exchange.ts
│   │   └── ninewickets-sportsbook.ts
│   └── mappings/                # Provider → atom mapping
│       ├── pinnacle.ts
│       ├── ninewickets-exchange.ts
│       └── ninewickets-sportsbook.ts
├── auth/
│   ├── index.ts                 # Re-exports
│   └── token-manager.ts         # Pinnacle token capture
├── background/
│   └── fetcher.ts               # Sync scheduler
├── matching/
│   ├── index.ts
│   └── matcher.ts               # Event matching
├── providers/
│   └── registry.ts              # Provider metadata (single source of truth)
├── shared/
│   ├── errors.ts                # Error formatting utilities
│   └── schemas/
│       └── ninewickets.ts       # Shared Zod schemas
├── config.ts                    # App config
├── store.ts                     # Events store + sync status
└── types.ts                     # Core types

app/
├── api/
│   ├── admin/route.ts           # Admin API
│   └── markets/[eventId]/route.ts# Markets API
├── admin/page.tsx               # Admin dashboard
├── layout.tsx
└── page.tsx                     # Redirects to /admin

components/
└── debug-machine/               # Debugging UI components
    ├── StepCard.tsx
    ├── CompactStepCard.tsx
    ├── StepGroup.tsx
    ├── FlowConnector.tsx
    ├── JSONViewer.tsx
    ├── IssuePanel.tsx
    ├── EventSelector.tsx
    └── summaries/
        ├── FixturesSummary.tsx
        ├── MarketsSummary.tsx
        ├── MatchEventsSummary.tsx
        └── ValueBetSummary.tsx

scripts/                         # Validation & exploration scripts
├── analyze-pinnacle-markets.ts
├── analyze-saved-samples.ts
├── explore-nw-sportsbook.ts
├── explore-nw-sportsbook-selections.ts
├── explore-nw-sportsbook-raw.ts
├── explore-all-market-types.ts
├── refresh-and-fetch.ts
├── validate-pinnacle-docs.ts
├── validate-nw-exchange.ts
└── validate-nw-sportsbook.ts

.claude/commands/                # Claude Code commands
├── dashboard-audit.md
└── update-docs.md

# Session files (gitignored)
sessions/
└── betjili/
    ├── browser-state.json       # Betjili cookies (~24h)
    ├── pinnacle-url.txt         # Session URL (~1h)
    └── pinnacle-token.json      # Bearer token (~1h)
```

---

## Environment Variables

```bash
# Betjili (for Pinnacle token capture)
BETJILI_USERNAME=your_username
BETJILI_PASSWORD=your_password
TOKEN_HEADLESS=true  # false for debugging (shows browser)

# Pinnacle Config
PINNACLE_DAYS_AHEAD=2     # Fetch today + N days (default: 2)
PINNACLE_PAGE_SIZE=1000   # Events per API request (default: 1000)

# NineWickets (optional, uses public endpoints)
NINEWICKETS_API_KEY=your_api_key
NINEWICKETS_BASE_URL=https://api.ninewickets.com

# App Config
FETCH_INTERVAL_MS=60000   # Background sync interval (default: 60s)

# Backtesting DB (Cloud SQL via cloud-sql-proxy)
DATABASE_URL=postgresql://nahidarbx_app:<pw>@127.0.0.1:5432/nahidarbx

# Gemini (match review + backtest AI endpoints)
GEMINI_API_KEY=
GEMINI_DEFAULT_MODEL=gemini-3-flash-preview
GEMINI_PRO_MODEL=gemini-3.1-pro-preview
GEMINI_LITE_MODEL=gemini-3.1-flash-lite-preview
```

---

## API Routes

| Route                           | Method   | Purpose                             |
| ------------------------------- | -------- | ----------------------------------- |
| `/`                             | GET      | Redirects to /admin                 |
| `/admin`                        | GET      | Admin dashboard page                |
| `/api/admin`                    | GET      | Get events, value bets, sync status |
| `/api/admin`                    | POST     | Trigger manual sync                 |
| `/api/markets/[eventId]`        | GET      | Get markets/odds for specific event |
| `/api/backtest/value-bets`      | GET/POST | List / pagination / filters         |
| `/api/backtest/value-bets/[id]` | PATCH    | Manual outcome mark                 |
| `/api/backtest/outcomes/bulk`   | POST     | Bulk outcome apply                  |
| `/api/backtest/ai-label`        | POST     | Gemini + Google Search label        |
| `/api/backtest/ai-analyze`      | POST     | Gemini structured analysis          |

---

## Debug Commands

```bash
# Capture Pinnacle token (visible browser)
TOKEN_HEADLESS=false npx tsx -e "import { getPinnacleToken } from './lib/auth/token-manager'; getPinnacleToken(true).then(t => console.log('Token:', t ? 'captured' : 'failed'))"

# Test Pinnacle event fetching
npx tsx -e "import { pinnacleAdapter } from './lib/adapters/pinnacle'; pinnacleAdapter.fetchEvents().then(e => console.log('Events:', e.length))"

# Test NineWickets Exchange
npx tsx -e "import { ninewicketsExchangeAdapter } from './lib/adapters/ninewickets-exchange'; ninewicketsExchangeAdapter.fetchEvents().then(e => console.log('Events:', e.length))"

# Validate atom mappings
npx tsx scripts/validate-nw-exchange.ts
npx tsx scripts/validate-nw-sportsbook.ts
npx tsx scripts/validate-pinnacle-docs.ts
```
