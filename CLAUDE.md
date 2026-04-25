# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Keep in sync with AGENTS.md

This file and [`AGENTS.md`](AGENTS.md) are intentional mirrors. CLAUDE.md is the full-form reference; AGENTS.md is a terse index whose entries point back here ("See CLAUDE.md 'X' section for full rule"). **When you add, change, or remove a rule in either file, update the other in the same commit.** A new CLAUDE.md rule needs a one-liner in AGENTS.md that cross-references it; a new AGENTS.md entry needs a full-form section in CLAUDE.md. Drift between the two is a documentation bug — fix it when you notice it.

## Solo-developer workflow — no feature branches

This is a solo-developer personal project. There is **no branching discipline** — every change lands on the working branch (currently `feat/alphasearch-phase-1`, treated as `master`). Don't propose feature branches, don't worry about branch hygiene, don't separate "my changes" from "the user's WIP" when committing. When asked to commit, **commit everything that's relevant** (my changes + any in-flight uncommitted work that overlaps with the same files), in as few commits as the work logically warrants. Don't fragment a coherent change across multiple commits because of branch politics — there are no other contributors to coordinate with.

## Runtime policy

**The production domain (`nahidarbx.store`) is no longer active. The app runs on localhost.**

- Next.js dev: `http://localhost:3000` (start with `npm run dev`)
- Python optimisation sidecar: Cloud Run **Job** — `nahidarbx-optimizer-job`, project `nahidarbx-6e73`, region `asia-south1`. Each sweep is one Job execution; the Next.js side triggers it via the Cloud Run Admin API. Redeploy with `bash services/optimizer/redeploy.sh`. (Migrated from Cloud Run Service on 2026-04-25 — see "Cloud Run lesson" section below.)
- Database: Cloud SQL Postgres (`nahidarbx-6e73:asia-south1:nahidarbx-db`) — requires `cloud-sql-proxy --port 5432 nahidarbx-6e73:asia-south1:nahidarbx-db` for local access.

Verify UI changes at `http://localhost:3000`. Verify backend/API changes by curling localhost after `npm run dev` is running.

## Cloud Run lesson — Service vs. Job for batch work

**On 2026-04-25 a 10,000-trial Optimisation sweep got stuck at 3,150 trials forever.** Root cause: the Python sidecar was deployed as a Cloud Run **Service**. `POST /run/start` returned 202 immediately and the trial loop ran as a background `asyncio.create_task`. Once that request completed, the Service had zero in-flight requests, and Cloud Run's autoscaler reaped the instance ~15 minutes later — killing the orphaned async task. The DB row stayed at `status='running'` forever.

**`--no-cpu-throttling` does NOT prevent this.** That flag keeps CPU allocated _while the instance is alive_. It does **not** stop the autoscaler from terminating idle instances when there are no in-flight requests. The previous fix attempt (commit `e448213`) added `--no-cpu-throttling` and was insufficient — the autoscaler reaped instances anyway.

**The only Service-side fix that actually works is `--min-instances=1`** (instance is always alive, never reaped). Cost: ~$80–100/mo for an always-on 6 vCPU / 12 GiB instance, even when idle.

**The architecturally correct fix is Cloud Run Jobs** (what we did). One execution per sweep, billed only while running, no autoscaler-reap surface, 7-day max task timeout. Migration touched: `services/optimizer/app/job.py` (new entrypoint), `lib/optimizer/api-client.ts` (rewritten to call the Cloud Run Admin API), `cloudbuild.yaml` (deploys a Job, not a Service), `lib/optimizer/scheduler.ts` (atomic `claimQueuedRun` to prevent race-double-trigger). The Python `runner.py` was untouched — it was already shaped correctly (DB-only state, no HTTP context).

**Rule for any future long-running batch work in this repo:** if the task takes > a few seconds and isn't tied to an HTTP request, **deploy as a Cloud Run Job, not a Service**. Reach for a Service only for genuine HTTP receivers. Don't try to paper over the Service-vs-batch mismatch with `--no-cpu-throttling` — it doesn't fix the actual problem.

## Commands

```bash
npm run dev      # Start development server (http://localhost:3000)
npm run build    # Production build
npm run lint     # Run ESLint

# Optimisation sidecar (Python — services/optimizer/, runs as Cloud Run Job)
cd services/optimizer && uv sync                                  # install deps
cd services/optimizer && RUN_ID=<some-id> uv run python -m app.job  # local one-shot
```

UI verification is manual — the user exercises the app in-browser after changes. Do not run Playwright E2E suites as part of "post-change verification."

The optimizer sidecar runs separately from the Next.js app. Boot order doesn't matter — the Next.js scheduler retries every 30s if the sidecar is unreachable. User-facing documentation lives in the in-app tooltips on `/lab/optimisation` (sourced from [`lib/lab/glossary.ts`](lib/lab/glossary.ts)); engineering notes are in [`services/optimizer/README.md`](services/optimizer/README.md).

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
| `/lab/optimisation`                                | Strategy parameter optimizer (sweeps configs against historical bets)          |
| `/api/betting-accounts`                            | GET: live balance/exposure per account                                         |
| `/api/value-bets`                                  | GET: arb data, POST: manual sync                                               |
| `/api/markets/[eventId]`                           | GET: odds for specific event                                                   |
| `/api/optimizer/runs`                              | POST: queue a new run + trigger Cloud Run Job; GET: list runs                  |
| `/api/optimizer/runs/[id]` + `/trials` + `/cancel` | Per-run detail / trial list / DB-driven cancel (Job polls flag every 2s)       |

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

## IPRoyal residential proxy — fallback only, never pre-emptive

SofaScore sits behind Cloudflare. Cloud Run egress IPs trip Cloudflare's adaptive bot-score cap after a few hundred requests and start returning 403s — this is what left 21 bets in "ready to settle" limbo with `tier2_hits=0` for hours on 2026-04-25. The fallback is an IPRoyal residential pool (498 sticky-session proxies at `sessions/iproyal/proxies.txt`, 168h TTL per session). Implementation: [`lib/settle/sources/iproyal-proxy.ts`](lib/settle/sources/iproyal-proxy.ts); wired into [`lib/settle/sources/sofascore.ts`](lib/settle/sources/sofascore.ts).

**Non-negotiable defaults:**

1. **Direct first, proxy on failure only.** Every SofaScore call tries the direct (Cloud Run egress) request first. A proxy is used ONLY when the direct call returns 403, OR when a recent direct 403 has put "direct" on a 10-minute cooldown. Never route pre-emptively, never route because "it's safer" — the fallback only exists to unblock actual 403s.
2. **Residential proxies are a metered resource.** IPRoyal bills per GB of bandwidth. Overusing the pool burns budget AND speeds up the 168h session rotation (finite pool → running out on a weekend means no fallback when we actually need one). Keep fallback scope narrow: SofaScore's small JSON responses only.
3. **Don't reach for the proxy from other sources.** ESPN, football-data.org, Pinnacle, NineWickets, Gemini, etc. are NOT Cloudflare-blocked and do NOT need proxy routing. Adding proxy support to those paths wastes bandwidth and is a misread of the actual problem.
4. **Cooldowns are intentional.** Per-proxy 30-min cooldown on 403 and global 10-min direct-cooldown after a direct 403 exist to prevent hammering Cloudflare/IPRoyal into broader bans. Don't shorten or remove them without understanding why the previous value was "stuck for hours."
5. **`sessions/iproyal/proxies.txt` is gitignored and must stay that way.** It contains proxy credentials. If the file is missing, `getProxyAgent()` returns null and SofaScore silently reverts to direct-only — which will re-stall settlement whenever Cloud Run IPs get blocked.
6. **If you find yourself wanting to use the proxy for anything besides SofaScore fallback, stop and reconsider.** The right answer is almost always "fix the non-SofaScore source properly" (better headers, backoff, caching, different tier), not "route it through IPRoyal too."

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

## Fix scripts — the agent runs them, not the operator

Whenever resolving a system issue requires a script run (DB migration, data backfill, cache invalidation, schema repair, secret rotation, redeploy, etc.), **the agent executes the script directly** rather than handing the operator a command to run. This is durable authorization from the operator: standing instruction, not per-incident approval.

**How to apply this:**

- After identifying the fix, run it from the agent shell using the same env the app uses (`.env` at repo root, ADC for GCP). Do not output a "please run X" instruction in place of running it.
- If the script touches production state (Cloud SQL DDL, Cloud Run deploys, Postgres data writes), still announce _what_ you're about to do in one short sentence before invoking — transparency, not approval-seeking.
- After running, verify the outcome — re-curl the endpoint, re-query the table, confirm the post-check passes — and report the result.
- If the script fails (network, permissions, missing credential), surface the error verbatim and ask for the specific unblocker. Do not silently fall back to "you do it."
- Existing fix runners live in `scripts/` — extend them in place rather than creating a new one each time. The Cloud-SQL-aware migration runner is `scripts/apply-pending-migrations.ts` (uses `@google-cloud/cloud-sql-connector` + IAM ADC, no proxy).
- Standing destructive-action restrictions still apply (no `DROP TABLE` without explicit say-so, no `git push --force`, no spend-cap-busting AI runs) — see "Executing actions with care" in the system prompt.

## Typography tiers (prose vs. chrome)

Every piece of text in the app falls into one of two tiers. Pick the right one:

| Tier       | What it is                                                                                                                                                                 | Size                                                                                      | Rationale                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Prose**  | Sentences the user has to _read_ — tooltip bodies, description paragraphs, help text under form fields, empty-state copy, error messages, section intros, long-form labels | **`text-sm` (14px) minimum**, `text-[13px]` acceptable for secondary captions             | Readability at laptop-viewing distance. The user consumes these to _learn_ something, not just scan. |
| **Chrome** | Labels on controls users _scan_ — toolbar buttons, pill filters, table cells, spreadsheet cells, badge counters, stat numbers, key/value metric labels                     | `text-[11px]` / `text-xs` (12px) — keep small per the April-2026 toolbar-consistency rule | Information density. Spreadsheet surfaces with 20+ visible columns would be unusable at 14px.        |

**Heuristic** — if the element is inside a `<Button>`, `<Badge>`, table `<td>`, tab-row, or toolbar wrapper → chrome (small). If it's a `<p>`, a `<label className="text-muted-foreground">` describing what to enter, a `<CardDescription>`, a tooltip body, or a standalone explanatory block → prose (14px). **Never** put a full-sentence explanation at `text-[11px]`.

Existing debts: pre-April-2026 code has a lot of `text-[11px]` on prose elements (tooltip bodies, description blocks, help captions). Fix them as you touch them. Toolbar buttons at `text-[11px]` are correct and should stay.

## Explanatory copy — always contextualize to betting

Whenever you write user-facing explanations (tooltips, empty states, section intros, form-field help text, error messages, glossary entries, docs), follow this pattern:

1. **Definition** — a one-line plain-English definition (non-contextual, so a new reader can grasp the concept).
2. **Basic analogy/example** — optional, only when the concept is abstract (e.g. CPCV, DSR, Pareto). Keep it short and vivid — a dart-board, a cinema-seat, a car-shopping analogy. Skip this for self-evident terms.
3. **Betting-context example** — a concrete illustration using _this app's domain_: real-looking numbers (e.g. "+3.2% EV", "800 settled bets", "Kelly 0.25"), real providers (Pinnacle, NineWickets Exchange, NineWickets Sportsbook), real markets (1X2, Asian Handicap, BTTS, O/U 2.5). This is the part that makes the concept land for the operator.
4. **Objective / what you'll achieve** — especially for choices (algorithms, samplers, samplers, kelly fractions, strategies). One sentence on the tangible outcome: "pick this when you want X", "this unlocks Y", "use this if you care about Z over W." Never leave a choice without an answer to _"why would I pick this one?"_

**Rules of thumb:**

- Never ship a tooltip or help string that's only non-contextual. If a reader can't translate the term to their own bet history, the copy failed.
- Prefer concrete numbers over hand-wavy ranges ("ROI 5.2% across 800 bets" beats "decent ROI on a reasonable sample").
- Prefer app-specific nouns over generic finance language ("placed bets", "settled bets", "soft book", "sharp book", "value bet", "EV cutoff") over "trades", "positions", "signals".
- When in doubt, err on the side of longer, betting-flavored copy — tooltips and docs are read once per concept; clarity compounds.

This rule applies everywhere in the app: `/lab/optimisation` tooltips, `/bets` filter explanations, `/value-bets` column headers, API error payloads, onboarding copy, empty states, toast messages. The glossary at [`lib/lab/glossary.ts`](lib/lab/glossary.ts) is the reference implementation — new explanatory copy should follow its `short` / `long` / `example` / `objective` structure.

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

# Optimisation sidecar (Python — services/optimizer/, runs as Cloud Run Job)
GCP_PROJECT_ID=nahidarbx-6e73                  # Cloud Run Admin API target
GCP_REGION=asia-south1                         # ditto
OPTIMIZER_JOB_NAME=nahidarbx-optimizer-job     # Job name to trigger executions on
# OPTIMIZER_URL / OPTIMIZER_SHARED_SECRET are obsolete (Job has no HTTP surface)
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
