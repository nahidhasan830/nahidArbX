# VenusEdge Architecture & Implementation Progress

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           VENUSEDGE DATA PIPELINE                            │
│                                                                             │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────┐ │
│   │   PROVIDERS  │───▶│   MATCHING   │───▶│  DETECTION   │───▶│  STORE   │ │
│   │      ✅      │    │      ✅      │    │      ❌      │    │    ✅    │ │
│   └──────────────┘    └──────────────┘    └──────────────┘    └──────────┘ │
│          │                   │                   │                  │       │
│          ▼                   ▼                   ▼                  ▼       │
│   PSLive + 9Wickets    String Similarity    NOT IMPLEMENTED     In-Memory  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND LAYER                                 │
│                                                                             │
│                         ┌──────────────────────┐                            │
│                         │     /api/admin       │                            │
│                         │         ✅           │                            │
│                         └──────────┬───────────┘                            │
│                                    │                                        │
│                                    ▼                                        │
│                         ┌──────────────────────┐                            │
│                         │   /admin Dashboard   │                            │
│                         │         ✅           │                            │
│                         └──────────────────────┘                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

Legend: ✅ Complete  ⚠️ Partial/In Progress  ❌ Not Started
```

---

## Current State Summary

### What's Working ✅
- **Token Capture (PSLive)** - Playwright-based browser automation with stealth mode (anti-bot detection)
- **PSLive Adapter** - Fully functional, fetches events/markets with Zod validation, configurable date range
- **NineWickets Adapter** - Fully functional, fetches live/upcoming events
- **Event Matching** - Cross-provider matching with 85% similarity threshold
- **In-Memory Store** - Stores events, arbitrages, provider status
- **Admin Dashboard** - Shows provider status, event counts, matching stats with 30s polling
- **Background Fetcher** - Runs every 20s, fetches from all providers in parallel

### What's Not Working ❌
- **Arbitrage Detection** - `lib/arb/detector.ts` needs implementation

---

## Provider Authentication

### PSLive (via Betjili)

PSLive provides Pinnacle odds but requires browser-based authentication through betjili.

```
┌─────────────────────────────────────────────────────────────────┐
│                    PSLIVE TOKEN CAPTURE FLOW                     │
│                    lib/auth/token-manager.ts                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   STEP 1: Check Stored Token                                    │
│   ├── Read pslive-token.json                                    │
│   ├── Check JWT expiry (with 5-min buffer)                      │
│   └── If valid → RETURN TOKEN                                   │
│                                                                 │
│   STEP 2: Try Stored PSLive URL                                 │
│   ├── Read pslive-url.txt (contains sess= param)                │
│   ├── Navigate directly to URL                                  │
│   ├── Capture token from /player/auth/authentication            │
│   └── If valid → SAVE & RETURN TOKEN                            │
│                                                                 │
│   STEP 3: Use Browser Session                                   │
│   ├── Load browser-state.json (saved cookies)                   │
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
│   ├── Save browser-state.json                                   │
│   └── Continue to STEP 3 (click PINNACLE)                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Persisted Files:**

| File | Purpose | TTL |
|------|---------|-----|
| `pslive-token.json` | Bearer token + expiry | ~1 hour |
| `pslive-url.txt` | Session URL with `sess=` param | ~1 hour |
| `browser-state.json` | Betjili cookies/session | ~24 hours |

**Environment Variables:**
```bash
BETJILI_USERNAME=your_username
BETJILI_PASSWORD=your_password
TOKEN_HEADLESS=false  # Set to false for debugging
```

### NineWickets

Simple API key authentication, no browser automation required.

```bash
NINEWICKETS_API_KEY=your_api_key
NINEWICKETS_BASE_URL=https://api.ninewickets.com
```

---

## Pipeline Stages

### Stage 1: Data Fetching ✅ COMPLETE

```
┌─────────────────────────────────────────────────────────────────┐
│ BACKGROUND FETCHER (every 20 seconds)                           │
│ lib/background/fetcher.ts                                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────────────────┐     ┌─────────────────────┐          │
│   │  PSLive Adapter ✅  │     │ NineWickets Adapter ✅│         │
│   │  lib/adapters/      │     │ lib/adapters/        │         │
│   │  pslive.ts          │     │ ninewickets.ts       │         │
│   │                     │     │                      │         │
│   │  • Token Manager ✅ │     │  • API Key Auth      │         │
│   │  • Fetch Events ✅  │     │  • Zod Validation    │         │
│   │  • Fetch Markets ✅ │     │  • Live + Upcoming   │         │
│   │  • Zod Validation   │     │  • Markets: 1X2      │         │
│   │  • Configurable     │     │                      │         │
│   │    date range       │     │                      │         │
│   └──────────┬──────────┘     └──────────┬───────────┘         │
│              │                           │                      │
│              └───────────┬───────────────┘                      │
│                          ▼                                      │
│              ┌───────────────────────┐                          │
│              │ NormalizedEvent[]     │                          │
│              │ (Both providers)      │                          │
│              └───────────────────────┘                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Files:**
- `lib/adapters/pslive.ts` - **Complete** (Zod validation, events/markets)
- `lib/adapters/ninewickets.ts` - **Complete**
- `lib/adapters/index.ts` - Adapter registry
- `lib/auth/token-manager.ts` - **Complete** (Playwright + stealth mode)
- `lib/background/fetcher.ts` - Orchestration

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
│   └────────────────────────┬────────────────────────────────┘   │
│                            ▼                                    │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  STEP 3: Merge Matched Events                           │   │
│   │  Creates single event with providers[] array            │   │
│   │  ID: "matched-{id1}-{id2}-..."                          │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│   Output: NormalizedEvent[] (deduplicated, cross-provider)      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### Stage 3: Arbitrage Detection ❌ NOT IMPLEMENTED

```
┌─────────────────────────────────────────────────────────────────┐
│ ARBITRAGE DETECTOR                                              │
│ lib/arb/detector.ts  ← FILE DOES NOT EXIST                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ⚠️  THIS IS THE CRITICAL MISSING COMPONENT                   │
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  EXPECTED ALGORITHM:                                    │   │
│   │                                                         │   │
│   │  1. Filter events with 2+ providers                     │   │
│   │                                                         │   │
│   │  2. For each market, calculate implied probability:     │   │
│   │     impliedProb = Σ(1/odds) for all outcomes            │   │
│   │                                                         │   │
│   │  3. If impliedProb < 1.0 → ARBITRAGE EXISTS             │   │
│   │                                                         │   │
│   │  4. Calculate profit:                                   │   │
│   │     profitPct = (1/impliedProb - 1) × 100               │   │
│   │                                                         │   │
│   │  5. If profitPct >= MIN_PROFIT (0.5%):                  │   │
│   │     Calculate stakes:                                   │   │
│   │     stake[i] = totalStake × (1/odds[i]) / impliedProb   │   │
│   │                                                         │   │
│   │  6. Return Arbitrage[]                                  │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│   STATUS: Implementation required to complete the pipeline      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### Stage 4: Storage ✅ COMPLETE

```
┌─────────────────────────────────────────────────────────────────┐
│ IN-MEMORY STORE                                                 │
│ lib/store.ts                                                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  Map<string, any>                                       │   │
│   │                                                         │   │
│   │  events        → NormalizedEvent[]                      │   │
│   │  arbitrages    → Arbitrage[]  (currently empty)         │   │
│   │  providerStatus→ Record<Provider, Status>               │   │
│   │  lastUpdate    → Date                                   │   │
│   │  matchingStats → { raw, matched, unmatched, stored }    │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│   Providers: pslive, ninewickets                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Status Matrix

| Component | File | Status | Notes |
|-----------|------|--------|-------|
| **Types** | `lib/types.ts` | ✅ Complete | Provider = "pslive" \| "ninewickets" |
| **Config** | `lib/config.ts` | ✅ Complete | fetchInterval, daysAhead, pageSize |
| **Store** | `lib/store.ts` | ✅ Complete | |
| **Token Manager** | `lib/auth/token-manager.ts` | ✅ Complete | Playwright + stealth mode |
| **PSLive Adapter** | `lib/adapters/pslive.ts` | ✅ Complete | Zod validation, configurable |
| **NineWickets Adapter** | `lib/adapters/ninewickets.ts` | ✅ Complete | |
| **Adapter Registry** | `lib/adapters/index.ts` | ✅ Complete | |
| **Auth Index** | `lib/auth/index.ts` | ✅ Complete | Re-exports token-manager |
| **Event Matcher** | `lib/matching/matcher.ts` | ✅ Complete | |
| **Background Fetcher** | `lib/background/fetcher.ts` | ✅ Complete | 20s interval |
| **Arb Detector** | `lib/arb/detector.ts` | ❌ Missing | |
| **Admin API** | `app/api/admin/route.ts` | ✅ Complete | Starts background fetcher |
| **Admin Page** | `app/admin/page.tsx` | ✅ Complete | 30s polling |

---

## Next Steps

### Immediate: Implement Arbitrage Detector

Create `lib/arb/detector.ts`:

1. **Filter events with 2+ providers**
2. **For each matched market**, calculate implied probability:
   ```typescript
   impliedProb = outcomes.reduce((sum, o) => sum + 1/o.odds, 0);
   ```
3. **If impliedProb < 1.0** → Arbitrage exists
4. **Calculate profit and stakes**:
   ```typescript
   profitPct = (1/impliedProb - 1) * 100;
   stake[i] = totalStake * (1/odds[i]) / impliedProb;
   ```

### After Arbitrage Detector Complete

1. **Wire into background fetcher**
   - Call detector after matching
   - Store arbitrages in store

2. **Update admin dashboard**
   - Display arbitrage opportunities
   - Show stakes and expected profit

---

## File Structure

```
lib/
├── adapters/
│   ├── index.ts          # Adapter registry
│   ├── pslive.ts         # PSLive adapter (complete - Zod validation)
│   └── ninewickets.ts    # NineWickets adapter (complete)
├── auth/
│   ├── index.ts          # Re-exports token-manager
│   └── token-manager.ts  # Playwright + stealth mode (complete)
├── matching/
│   ├── index.ts
│   └── matcher.ts        # Event matching (complete)
├── arb/
│   └── detector.ts       # NOT IMPLEMENTED
├── background/
│   └── fetcher.ts        # Orchestration (complete, 20s interval)
├── config.ts             # App config (fetchInterval, daysAhead, pageSize)
├── store.ts
└── types.ts

app/
├── api/
│   └── admin/route.ts    # Admin API (starts background fetcher)
├── admin/page.tsx        # Admin dashboard (30s polling)
└── page.tsx              # Redirects to /admin

.claude/
└── commands/
    └── update-docs.md    # Custom command for updating docs

# Session files (gitignored)
browser-state.json        # Betjili cookies (~24h)
pslive-url.txt           # Session URL (~1h)
pslive-token.json        # Bearer token (~1h)
```

---

## Environment Variables

```bash
# Betjili (for PSLive token capture)
BETJILI_USERNAME=your_username
BETJILI_PASSWORD=your_password
TOKEN_HEADLESS=true  # false for debugging (shows browser)

# PSLive Config
PSLIVE_DAYS_AHEAD=2      # Fetch today + N days (default: 2)
PSLIVE_PAGE_SIZE=1000    # Events per API request (default: 1000)

# NineWickets
NINEWICKETS_API_KEY=your_api_key
NINEWICKETS_BASE_URL=https://api.ninewickets.com

# App Config
FETCH_INTERVAL_MS=20000  # Background fetch interval (default: 20s)
MIN_PROFIT_PCT=0.5
TOTAL_STAKE=100
```
