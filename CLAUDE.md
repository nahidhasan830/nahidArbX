# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start development server (http://localhost:3000)
npm run build    # Production build
npm run lint     # Run ESLint
```

## Architecture

VenusEdge is a real-time arbitrage finder for betting providers.

**Providers:**
- **PSLive** - Pinnacle odds via betjili (requires Playwright token capture)
- **NineWickets** - Direct API access

**Background Fetcher (20s interval):**

1. Fetch all providers in parallel
2. Normalize events to common format
3. Match events across providers
4. Store results in Map (in-memory only)

```
Browser ──GET /api/admin──▶ API Route ──▶ In-Memory Store (Map)
                                 ▲
                     Background Fetcher (20s interval)
                           │           │
                       PSLive    NineWickets
                       (✅)         (✅)
```

## Routes

| Route | Purpose |
|-------|---------|
| `/` | Redirects to `/admin` |
| `/admin` | Admin dashboard |
| `/api/admin` | GET: data, POST: manual fetch |

## Critical Rules

- **NO authentication/user system**
- **NO database/persistence** - in-memory Map only
- **Total stake: 100** (configurable via `TOTAL_STAKE` env)
- **All external data validated with Zod before processing**

## Critical Algorithms

### Event Matching (threshold: 0.85)

```
score = 0.6 * teamSimilarity + 0.2 * competitionSimilarity + 0.2 * timeScore
timeScore = max(0, 1 - timeDiff / 7200000)  // 2hr window
match if score >= 0.85
```

### Arbitrage Detection

```
impliedProb = sum(1/odds for each outcome)
if (impliedProb < 1) → arbitrage exists
profitPct = (1/impliedProb - 1) * 100
stake[i] = totalStake * (1/odds[i]) / impliedProb
minProfit = 0.5%  // filter threshold
```

## File Structure

| Path                         | Purpose                                                      |
| ---------------------------- | ------------------------------------------------------------ |
| `lib/types.ts`               | **Single source of truth** for ALL interfaces                |
| `lib/store.ts`               | In-memory Map store for events, arbitrages, provider status  |
| `lib/config.ts`              | App config (fetchInterval, daysAhead, pageSize)              |
| `lib/adapters/pslive.ts`     | PSLive adapter (✅ complete - Zod validation)                |
| `lib/adapters/ninewickets.ts`| NineWickets adapter (✅ complete)                            |
| `lib/auth/token-manager.ts`  | Playwright token capture + stealth mode                      |
| `lib/matching/matcher.ts`    | Event matching with string-similarity                        |
| `lib/arb/detector.ts`        | Arbitrage detection (❌ NOT IMPLEMENTED)                     |
| `lib/background/fetcher.ts`  | Orchestrates fetch → match → store (20s interval)            |
| `app/admin/page.tsx`         | Admin dashboard UI (30s polling)                             |
| `app/api/admin/route.ts`     | Admin API endpoint (starts background fetcher)               |

## Provider Adapter Pattern

```typescript
interface ProviderAdapter {
  name: Provider;
  fetchEvents(): Promise<NormalizedEvent[]>;
  fetchMarkets(eventId: string): Promise<NormalizedMarket[]>;
}
```

## PSLive Token Capture

PSLive requires browser automation to capture Bearer tokens:

```
1. Check stored token (pslive-token.json) - use if not expired
2. Try stored URL (pslive-url.txt) - navigate directly
3. Use browser session (browser-state.json) - click PINNACLE
4. Full betjili login - last resort
```

**Session files (gitignored):**
- `pslive-token.json` - Bearer token + expiry (~1 hour)
- `pslive-url.txt` - Session URL (~1 hour)
- `browser-state.json` - Betjili cookies (~24 hours)

## Key Dependencies

- **axios** - HTTP client for provider APIs
- **zod** - Runtime validation of all external data
- **string-similarity** - Event matching across providers
- **date-fns** - Date formatting and calculations
- **playwright** - Browser automation for PSLive token capture

## Code Style

- Clean, concise, modern React patterns
- Extend types in `lib/types.ts`: `Sport`, `Provider`, `MarketType` as union types

## Environment Variables

```bash
# PSLive (via Betjili)
BETJILI_USERNAME=
BETJILI_PASSWORD=
TOKEN_HEADLESS=true  # false for debugging

# PSLive Config
PSLIVE_DAYS_AHEAD=2      # Fetch today + N days
PSLIVE_PAGE_SIZE=1000    # Events per request

# NineWickets
NINEWICKETS_API_KEY=
NINEWICKETS_BASE_URL=

# App Config
FETCH_INTERVAL_MS=20000  # Background fetcher interval
MIN_PROFIT_PCT=0.5
TOTAL_STAKE=100
```

## Current Status

- **Working:** PSLive adapter, NineWickets adapter, token capture (stealth mode), event matching, admin dashboard
- **Pending:** Arbitrage detector implementation

See `ARCHITECTURE.md` for detailed implementation progress.

## Debug Commands

```bash
# Capture PSLive token (visible browser)
TOKEN_HEADLESS=false npx tsx -e "import { getPsliveToken } from './lib/auth/token-manager'; getPsliveToken(true).then(t => console.log('Token:', t ? 'captured' : 'failed'))"

# Test PSLive event fetching
npx tsx -e "import { psliveAdapter } from './lib/adapters/pslive'; psliveAdapter.fetchEvents().then(e => console.log('Events:', e.length))"
```

## General Rules

Always use Context7 MCP when I need library/API documentation, code generation, setup or configuration steps without me having to explicitly ask.
