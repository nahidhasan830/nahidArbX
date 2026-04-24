# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start development server (http://localhost:3000)
npm run build    # Production build
npm run lint     # Run ESLint

# AlphaSearch optimizer sidecar (Python — services/optimizer/)
cd services/optimizer && uv sync                                  # install deps
cd services/optimizer && uv run uvicorn app.main:app --port 8001 --reload   # dev
```

UI verification is manual — the user exercises the app in-browser after changes. Do not run Playwright E2E suites as part of "post-change verification."

The optimizer sidecar runs separately from the Next.js app. Boot order doesn't matter — the Next.js scheduler retries every 30s if the sidecar is unreachable. See `docs/alphasearch.md` for the full user-facing guide and `services/optimizer/README.md` for engineering notes.

## Architecture

NahidArbX is a real-time value-bet finder for betting providers using a family/atom-based odds model. It compares soft-book prices (NineWickets Exchange, NineWickets Sportsbook, BetConstruct) against a sharp benchmark (Pinnacle) and flags positive-EV opportunities. Detected bets are persisted to Postgres for the bets-history review + settlement workflow on `/bets`.

**Providers:**

- **Pinnacle** - Sharp odds via betjili (requires Playwright token capture)
- **NineWickets Exchange** - Exchange back odds (MATCH_ODDS, O/U)
- **NineWickets Sportsbook** - Sportsbook odds (extensive market coverage)

**Odds Sources:**

- `exchange` - Exchange back odds (Pinnacle, NineWickets Exchange)
- `sportsbook` - Sportsbook odds (NineWickets Sportsbook)

**Data Flow (4-Phase Pipeline):**

```
┌─────────────────────────────────────────────────────────────────┐
│                        BACKEND (Server)                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   Background Sync Scheduler (every 60s)                         │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  Phase 1: FIXTURES - Pull events from all providers     │   │
│   │  Phase 2: MATCHING - Match events across providers      │   │
│   │  Phase 3: MARKETS  - Fetch odds, store in atoms system  │   │
│   │  Phase 4: ARBITRAGE- Detect opportunities per family    │   │
│   └─────────────────────────────────────────────────────────┘   │
│                           ↓                                     │
│                    Dual Store System                            │
│                    (Events Store + Atoms Odds Store)            │
│                           ↓                                     │
│   GET /api/admin  ←──── Returns events, arbs, status            │
│   POST /api/admin ←──── Triggers sync NOW                       │
│   GET /api/markets/[id] ←── Returns odds for specific event     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                            ↑ HTTP
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                       FRONTEND (Browser)                        │
├─────────────────────────────────────────────────────────────────┤
│   On Load: GET /api/admin → display data                        │
│   Every 30s: GET /api/admin → refresh display                   │
│   (polls faster at 2s when sync is active)                      │
│   "Sync Now" button: POST → trigger sync → GET data             │
└─────────────────────────────────────────────────────────────────┘
```

**Key Terms:**

- `isSyncing` - Currently pulling fresh data from providers
- `isSchedulerActive` - Background sync job is running on interval
- `syncNow()` - Manual trigger (POST /api/admin)
- `Family` - A market with mutually exclusive outcomes (e.g., 1X2)
- `Atom` - A single betting outcome (e.g., Home Win)

## Routes

| Route                                              | Purpose                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| `/`                                                | Redirects to `/dashboard`                                                      |
| `/dashboard`                                       | Central betting-account dashboard (root view)                                  |
| `/value-bets`                                      | Value-bet / arb finder (formerly `/admin`)                                     |
| `/bets`                                            | Bets history — captured value bets, settlement + review (formerly `/backtest`) |
| `/lab/alphasearch`                                 | Strategy parameter optimizer (sweeps configs against historical bets)          |
| `/api/betting-accounts`                            | GET: live balance/exposure per account                                         |
| `/api/value-bets`                                  | GET: arb data, POST: manual sync                                               |
| `/api/markets/[eventId]`                           | GET: odds for specific event                                                   |
| `/api/optimizer/runs`                              | POST: queue a new run; GET: list runs                                          |
| `/api/optimizer/runs/[id]` + `/trials` + `/cancel` | Per-run detail / trial list / cancellation                                     |

## Critical Rules

- **NO authentication/user system**
- **NO database/persistence** - in-memory stores only
- **Total stake: 100** (configurable via `TOTAL_STAKE` env)
- **All external data validated with Zod before processing**
- **Single source of truth** - When the same metric appears in multiple places (e.g., arb count), use one calculation/function that both places share. Never calculate the same value twice with different logic.
- **`bets` is the canonical settlement/backtest table** - the old `value_bets` and `placed_bets` tables are legacy-only migration history and should not be used by new code.
- **All settlement entry points must share one pipeline** - auto-settle, manual re-settle, and manual outcome application must converge on the same server-side settlement logic.
- **Send settlement Telegram notifications only for placed bets** - rows without an actual placement (`placedAt IS NULL`) should be settled silently.
- **Do not treat the local `.env` `DATABASE_URL` / `127.0.0.1` Postgres as authoritative by default** - for runtime investigation, prefer the real cloud database path through the configured SDK/connector rather than assuming a local endpoint exists.

## AI Cost Safety (learned the hard way — READ BEFORE TOUCHING AI CODE)

**On 2026-04-18 a single url_context test run tipped our Gemini spend past its $10 monthly cap and into $35+ of overage.** Root cause: a scoreboard URL handed to `url_context` fetched a page whose token count blew past the model's 1M-token cap. Every such blown call still charges for the input tokens — one wrong URL can cost cents; a batch of wrong URLs can cost dollars.

**Non-negotiable defaults:**

1. **AI is disabled in the settlement pipeline unless explicitly opted into.** The kill switch lives in [`lib/settle/kill-switch.ts`](lib/settle/kill-switch.ts) and defaults to OFF. Set `AI_SETTLEMENT_ENABLED=true` in `.env` to boot with AI on. Runtime toggles are exposed via the settlement monitor UI on `/bets`.
2. **Tier 3 (`url_context`) AND Tier 4 (grounded search / Batch) MUST always check `isAiEnabled()` before making any paid call.** Any new tier that talks to a paid API has to be gated the same way.
3. **Never run any settle-related script that calls the Gemini SDK against the real DB without first lowering the spend cap at [ai.studio/spend](https://ai.studio/spend) to a number you're willing to lose.** Scripts in `scripts/test-*.ts` default to AI-off; leave them that way.
4. **URLs passed to `url_context` must be short, known-good scoreboard pages (Sofascore, FlashScore).** Do NOT include encyclopedia-style pages (Wikipedia season articles, competition indexes) — their size is unbounded and they WILL blow the context window and burn money. See the warning comment in [`lib/settle/sources/url-context.ts`](lib/settle/sources/url-context.ts).
5. **Every paid Gemini call path needs error classification.** Spend-cap and quota-exhausted errors MUST short-circuit the batch (`UrlContextBatchAbort` pattern). Never let a failing AI call retry in a loop.
6. **Prefer deterministic settlement first.** The pure `settleBet(row, score)` handles 80%+ of markets with zero AI involvement given a score from any free tier (match_scores cache, live feed, football-data.org). AI is last-resort, not default.
7. **Before enabling AI, always verify the free tiers are maxed out.** Check `FOOTBALL_DATA_API_KEY` is set, the live-score feed is persisting to `match_scores`, and the cache hit rate on Tier 0 is high. If you're burning AI calls because the free tiers aren't wired up, fix that first.
8. **Audit settlement_runs regularly.** The `settlement_runs` table logs every tick's tier hits + estimated cost; if `tier3_hits` or `tier4_hits` suddenly spikes, investigate.

## Critical Algorithms

### Event Matching (threshold: 0.85)

```
score = 0.6 * teamSimilarity + 0.2 * competitionSimilarity + 0.2 * timeScore
timeScore = max(0, 1 - timeDiff / 7200000)  // 2hr window
match if score >= 0.85

// Competition names normalized before comparison:
// - Country adjectives → nouns (english → england, spanish → spain)
// - Handles "English FA Cup" vs "England FA Cup" variations
```

### Value-Bet Detection (Atoms-Based)

```
// Per atom, per soft provider:
trueProb       = vig-removed Pinnacle probability for that atom
adjustedOdds   = softOdds * (1 - commissionPct/100)   // only exchanges have commission
evPct          = (adjustedOdds * trueProb - 1) * 100

// Sizing (Kelly, fractional):
kellyFraction  = max(0, (b*p - q) / b)   // b = adjustedOdds - 1, p = trueProb, q = 1-p
kellyStake     = kellyFraction * KELLY_FRACTION * VALUE_TOTAL_STAKE

// Flag as a value bet if:
- sharp (Pinnacle) odds exist and are fresh (≤ MAX_VALUE_ODDS_AGE_MS)
- soft odds exist and are fresh
- evPct ≥ MIN_EV_PCT (2.0)

// Persistence: see lib/db/repositories/bets.ts
```

## File Structure

| Path                                     | Purpose                                             |
| ---------------------------------------- | --------------------------------------------------- |
| `lib/types.ts`                           | Core types (Provider, NormalizedEvent)              |
| `lib/providers/registry.ts`              | **Single source of truth** for provider metadata    |
| `lib/store.ts`                           | Events store + SyncStatus tracking                  |
| `lib/config.ts`                          | App config (fetchInterval 60s, daysAhead, pageSize) |
| `lib/adapters/pinnacle.ts`               | Pinnacle events adapter                             |
| `lib/adapters/ninewickets-exchange.ts`   | NW Exchange events + markets                        |
| `lib/adapters/ninewickets-sportsbook.ts` | NW Sportsbook (via Exchange fixtures)               |
| `lib/adapters/index.ts`                  | Adapter registry                                    |
| `lib/atoms/types.ts`                     | Atoms type definitions (Family, Atom, BestAtomOdds) |
| `lib/atoms/atoms.json`                   | Family definitions (pairs/groups, lines, atoms)     |
| `lib/atoms/registry.ts`                  | Family/atom lookup functions                        |
| `lib/atoms/store.ts`                     | Hierarchical odds storage                           |
| `lib/atoms/fetcher.ts`                   | Unified odds fetcher                                |
| `lib/atoms/value-detector.ts`            | Value-bet detection (EV, Kelly, freshness gates)    |
| `lib/atoms/vig-removal.ts`               | Balanced-margin vig removal for sharp odds          |
| `lib/db/schema.ts`                       | Postgres unified `bets` + settlement tables         |
| `lib/db/repositories/bets.ts`            | Upsert/list/place/settle repository                 |
| `lib/atoms/adapters/*.ts`                | Per-provider odds fetching                          |
| `lib/atoms/mappings/*.ts`                | Provider → atom mapping                             |
| `lib/auth/token-manager.ts`              | Playwright token capture + stealth mode             |
| `lib/matching/matcher.ts`                | Event matching with string-similarity               |
| `lib/background/fetcher.ts`              | Sync scheduler: syncAll(), startScheduler()         |
| `app/admin/page.tsx`                     | Admin dashboard UI                                  |
| `app/api/admin/route.ts`                 | Admin API endpoint                                  |
| `app/api/markets/[eventId]/route.ts`     | Markets API endpoint                                |
| `components/debug-machine/*.tsx`         | Debugging UI components                             |

## Provider Adapter Pattern

```typescript
// Event Adapter (lib/adapters/)
interface ProviderAdapter {
  name: Provider;
  fetchEvents(): Promise<NormalizedEvent[]>;
}

// Atoms Adapter (lib/atoms/adapters/)
interface AtomsProviderAdapter {
  providerId: ProviderKey;
  fetchAndStoreOdds(
    providerEventId: string,
    normalizedEventId: string,
  ): Promise<number>;
}
```

## Pinnacle Token Capture

Pinnacle requires browser automation to capture Bearer tokens:

```
1. Check stored token (sessions/betjili/pinnacle-token.json) - use if not expired
2. Try stored URL (sessions/betjili/pinnacle-url.txt) - navigate directly
3. Use browser session (sessions/betjili/browser-state.json) - click PINNACLE
4. Full betjili login - last resort
```

**Session files (in `sessions/betjili/`, gitignored):**

- `pinnacle-token.json` - Bearer token + expiry (~1 hour)
- `pinnacle-url.txt` - Session URL (~1 hour)
- `browser-state.json` - Betjili cookies (~24 hours)

## Key Dependencies

- **@google/genai** - Gemini API client for AI-assisted event matching
- **axios** - HTTP client for provider APIs
- **zod** - Runtime validation of all external data
- **string-similarity** - Event matching across providers
- **date-fns** - Date formatting and calculations
- **playwright** - Browser automation for Pinnacle token capture

## Code Style

- Clean, concise, modern React patterns
- Extend providers in `lib/providers/registry.ts`
- Extend market types in `lib/atoms/types.ts`: `AtomMarketType`
- Add new families/atoms in `lib/atoms/atoms.json`

## Dashboard Design Philosophy

**The Table is a Universe Container**

The admin dashboard table should be the single source of truth for ALL data visualization. Think of it as "a small box that holds the universe" - one unified table that displays:

- All providers (Pinnacle, NineWickets Exchange, NineWickets Sportsbook, BetConstruct)
- All events (matched and unmatched)
- All markets per event (organized by family)
- All odds per market (with provider comparison)
- All detected value bets (with EV%, Kelly fraction, settlement controls)

**Design Principles:**

1. **Everything in the table** - Don't fragment data across multiple views
2. **Expandable rows** - Click to reveal markets/odds nested within events
3. **Provider columns** - Side-by-side comparison of odds from different providers
4. **Real-time updates** - Odds should reflect the latest sync
5. **Filter, don't hide** - Use filters to narrow view, but data structure remains unified

## Environment Variables

```bash
# Pinnacle (via Betjili)
BETJILI_USERNAME=
BETJILI_PASSWORD=
TOKEN_HEADLESS=true  # false for debugging

# Pinnacle Config
PINNACLE_DAYS_AHEAD=2      # Fetch today + N days
PINNACLE_PAGE_SIZE=1000    # Events per request

# NineWickets (optional)
NINEWICKETS_API_KEY=
NINEWICKETS_BASE_URL=

# App Config
FETCH_INTERVAL_MS=60000  # Background sync interval (default 60s)

# Gemini API (match analysis + bets-history labeling) — see lib/ai/gemini.ts, lib/ai/label-outcome.ts
GEMINI_API_KEY=
GEMINI_DEFAULT_MODEL=gemini-3-flash-preview    # default "flash" tier
GEMINI_PRO_MODEL=gemini-3.1-pro-preview        # "pro" tier (deep reasoning)
GEMINI_LITE_MODEL=gemini-3.1-flash-lite-preview # "lite" tier (high-volume bulk)

# Bets-history DB (Cloud SQL Postgres) — see `## Database` section below
DATABASE_URL=postgresql://nahidarbx_app:<pw>@127.0.0.1:5432/nahidarbx

# AlphaSearch optimizer (Python sidecar — services/optimizer/)
OPTIMIZER_URL=http://localhost:8001            # prod: internal Cloud Run URL
OPTIMIZER_SHARED_SECRET=                       # HMAC token; both sides must match
```

## Database (bets-history — Phase 1+)

Cloud SQL Postgres 16 on GCP, used for persisting detected value bets (reviewed + settled on `/bets`). The app DB is separate from the existing SQLite auth DB — **do not touch** `better-sqlite3` or the `/data/` auth store.

| Resource                 | Value                                     |
| ------------------------ | ----------------------------------------- |
| GCP project              | `nahidarbx-6e73`                          |
| Region                   | `asia-south1` (Mumbai)                    |
| Instance                 | `nahidarbx-db` (db-f1-micro, Postgres 16) |
| Database                 | `nahidarbx`                               |
| App user                 | `nahidarbx_app`                           |
| Instance connection name | `nahidarbx-6e73:asia-south1:nahidarbx-db` |

**Local dev — start the Cloud SQL Auth Proxy** in a long-running terminal:

```bash
cloud-sql-proxy --port 5432 nahidarbx-6e73:asia-south1:nahidarbx-db
```

Then any tool on `127.0.0.1:5432` (psql, `npm run db:studio`, the app) connects transparently. `DATABASE_URL` lives in `.env` (gitignored) — never commit it.

## Current Status

- **Working:** All pipeline stages fully functional
  - Pinnacle adapter, NW Exchange adapter, NW Sportsbook adapter
  - Token capture (stealth mode)
  - Event matching (85% threshold)
  - Atoms odds storage system
  - Value-bet detection (Pinnacle-benchmarked EV + Kelly sizing)
  - Admin dashboard with manual sync
  - Markets API for per-event odds
  - Postgres persistence + bets-history REST/AI endpoints (`/api/bets-history/*`)

## NineWickets Market Sources

| Source              | Endpoint                          | Markets            |
| ------------------- | --------------------------------- | ------------------ |
| Exchange (fixtures) | `gakvx.seofmi.live/queryEvents`   | 1x2 (MATCH_ODDS)   |
| Exchange (markets)  | `awskvx.seofmi.live/queryMarkets` | O/U 0.5, 1.5, 2.5  |
| Sportsbook          | 2-step API flow                   | Extensive coverage |

See `ARCHITECTURE.md` for detailed implementation progress.

## Debug Commands

```bash
# Capture Pinnacle token (visible browser)
TOKEN_HEADLESS=false npx tsx -e "import { getPinnacleToken } from './lib/auth/token-manager'; getPinnacleToken(true).then(t => console.log('Token:', t ? 'captured' : 'failed'))"

# Test Pinnacle event fetching
npx tsx -e "import { pinnacleAdapter } from './lib/adapters/pinnacle'; pinnacleAdapter.fetchEvents().then(e => console.log('Events:', e.length))"

# Test NineWickets Exchange
npx tsx -e "import { ninewicketsExchangeAdapter } from './lib/adapters/ninewickets-exchange'; ninewicketsExchangeAdapter.fetchEvents().then(e => console.log('Events:', e.length))"
```

## General Rules

Always use Context7 MCP when I need library/API documentation, code generation, setup or configuration steps without me having to explicitly ask.

## Tool Usage Rules (MUST FOLLOW)

### Context7 MCP — Use Proactively

- **ALWAYS** use Context7 to fetch current docs before writing code that uses Next.js APIs, React patterns, Zod schemas, Playwright APIs, or Axios configurations.
- Do NOT rely on training data for library APIs — fetch live docs via Context7 first.
- Trigger: any code generation, bug fix, or refactor involving external libraries.

### Playwright MCP — Use for Browser Tasks

- Use when debugging or testing Pinnacle token capture flow.
- Use when the user asks to verify UI behavior or test a page.
- Use when inspecting browser state, cookies, or network requests.
- **Clean up artifacts when done.** After any browser verification session, delete everything you generated under `.playwright-mcp/` (console logs, snapshot `.yml` files, screenshots). One-liner: `rm -rf .playwright-mcp/*`. This keeps the repo tidy and avoids committing throwaway test output. The directory itself is gitignored; do not remove the directory, just empty it. Do NOT touch stray screenshots elsewhere (e.g. `backtest-*.png` at the repo root) — those may be intentional artifacts the user saved.

### Sequential Thinking MCP — Use for Complex Logic

- Use when working on value-bet detection or vig-removal algorithm changes.
- Use when debugging multi-provider matching issues.
- Use when planning changes that touch 3+ files or involve tricky state management.
- Trigger: any task where you'd normally think "this is complex, let me plan."

### Slash Commands — Suggest When Relevant

After making changes to specific areas, suggest running the appropriate command:

- Changes to adapters/providers → suggest `/provider-status`
- Changes to sync pipeline/fetcher/store → suggest `/sync-test`
- Broad refactors or new features → suggest `/code-cleanup` after completion
- After significant changes → suggest `/update-docs` to keep docs in sync

### Post-Change Verification

After ANY code change:

1. **Always run `npm run build`** (unless the change is trivial CSS/text only).
2. **Always run `npm run lint`** — catch unused vars / dead imports left over from deletions.
3. **Domain-specific checks:**
   - Provider adapters → also run `/provider-status`.
   - If user asks "does it work?" → run `/sync-test`.
4. **Do NOT run Playwright E2E suites.** UI verification is manual — the user will open the app and exercise changed features in-browser. Don't spin up dev servers or invoke `npx playwright test` as part of post-change verification.

### UI consistency — reuse toolbar/filter components

Toolbar and filter components should be reused across spreadsheet surfaces. When adding a new list/table page, reuse (or extract into a shared component under `components/spreadsheet/`) the filter pill, search, sort, and pagination patterns already in `BetsHistoryToolbar` and `SpreadsheetToolbar`. The standard is `h-7` / `px-3 py-1.5` / `bg-muted/40` wrapper / `text-[11px]` buttons — match this vocabulary. Do not duplicate styling; inconsistent sizing between pages was a fix point in April 2026. If you need a new variant, extract the common parts first.
