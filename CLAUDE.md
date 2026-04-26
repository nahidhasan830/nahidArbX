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

## AI usage policy — manual only, no automatic Gemini

**Updated 2026-04-26:** all automatic Gemini AI usage was removed from the settlement pipeline. The persistent kill-switch (`lib/settle/kill-switch.ts`) is gone, the `/ai` Telegram command is gone, the kill-switch UI button on the Settlement Monitor is gone. Settlement runs deterministic Tier 0/1/2 only (cache → live feed → ESPN/SofaScore).

**The only Gemini surface that remains is operator-triggered:**

1. **Manual "AI settle" button on `/bets`** — operator selects pending bets, clicks "Re-run with Lite/Flash/Pro" in the dropdown. The dialog calls [`aiLabelBets(ids, { forceAi: true, aiModel })`](lib/bets-history/api-client.ts), which sends events straight to Tier 3 `url_context`. Cost-guarded by `AI_MAX_PER_REQUEST_USD` (default $2 ceiling).
2. **Match-review "Verify" button** — operator clicks Verify on a near-match pair; calls `analyzeMatchWithGemini` for matching, not settlement.

**Non-negotiable defaults:**

- **The automatic settlement scheduler MUST never set `forceAi: true`.** No code path between [`lib/settle/scheduler.ts`](lib/settle/scheduler.ts) → [`lib/settle/auto-settler.ts`](lib/settle/auto-settler.ts) → [`lib/settle/settle-batch.ts`](lib/settle/settle-batch.ts) → [`lib/settle/waterfall.ts`](lib/settle/waterfall.ts) opts in to AI. The Tier 3 block in waterfall.ts gates strictly on `opts.forceAi === true`. If you add a new settlement entry point, it must inherit this default.
- **URLs passed to `url_context` must be short, known-good scoreboard pages** (Sofascore, FlashScore). Wikipedia season articles or competition indexes have unbounded size and WILL blow the context window — see the warning comment in [`lib/settle/sources/url-context.ts`](lib/settle/sources/url-context.ts).
- **Every paid Gemini call path needs error classification.** Spend-cap and quota-exhausted errors MUST short-circuit the batch (`UrlContextBatchAbort` pattern). Never let a failing AI call retry in a loop.
- **Prefer deterministic settlement first.** The pure `settleBet(row, score)` handles 80%+ of markets with zero AI involvement given a score from any free tier. The manual AI button is a last-resort operator tool, not a default.
- **Before clicking the manual AI button, check free-tier health.** If `tier1_hits` is unusually low in `settlement_runs`, fix the free-tier issue (proxy down, ESPN slug missing) instead of throwing AI at it.

There is no kill-switch any more because there is no automatic-AI cost surface to switch off. If the operator misuses the manual button, the pre-flight cost-guard refuses batches above the per-request ceiling.

## Entity Resolution — alias system (Postgres-backed)

**Updated 2026-04-26:** the legacy `data/aliases/{team,competition}-aliases.json` store was replaced by a Postgres-backed entity-resolution system with a 4-tier ML-augmented promoter. The old store was producing silently-wrong canonical mappings (e.g. `obolon → obolon kyiv metalurh donetsk` after 26 false confirmations) that poisoned every future sync.

**Tables:** `entities`, `entity_names`, `name_observations`, `entity_review_queue`. See [`lib/db/migrations/0031_entities.sql`](lib/db/migrations/0031_entities.sql) and [`lib/db/migrations/0032_entity_review_queue.sql`](lib/db/migrations/0032_entity_review_queue.sql). Includes pgvector for multilingual embedding fallback (transliteration cases).

**Lookup hot path:** `(provider, surface_normalized, competition_id)` UNIQUE, so `Athletic` in La Liga and `Athletic` in Colombian Primera A coexist as distinct rows. See [`lib/matching/entities/resolver.ts`](lib/matching/entities/resolver.ts).

**Single ingress:** every alias-learning writer (matcher harvester, settle pipeline, match-review UI confirm, learner) calls [`recordObservation`](lib/matching/entities/observations.ts) — appends to `name_observations` (audit log) and updates the candidate row. Decisions about `candidate → active` happen out-of-band in the promoter.

**4-tier promoter** ([`lib/matching/entities/promoter.ts`](lib/matching/entities/promoter.ts), runs every 5 min):

- **Tier 0 — deterministic gates:** gender mismatch, **team-variant mismatch (U17/U19/U20/U21/U23/Sub-20/Olympic/Reserves/II/B/Castilla/Academy/Futsal/Beach/eSports/Selects/Youth)**, group conflict (Serie C Group A vs B), competing-candidate, anti-ratchet (≥1 h temporal spread).
- **Tier 1 — Bayesian-flavoured evidence:** `evidence = log(weight+1) - α·log(neg+1)`. Provider weights configurable (Pinnacle 3, NW 2, BetConstruct 1) × source weight (match-review/settle 4, learner 2, harvester 1).
- **Tier 2 — LightGBM pairwise classifier** + **conformal-prediction calibration** ([`services/entity-classifier`](services/entity-classifier)). Runs only in the uncertain band [1.0, 3.0]. Promote when `score ≥ 0.92 AND p-value ≤ 0.05`.
- **Tier 3 — operator review queue:** anything Tier 2 is uncertain about is surfaced to the EntityInspector UI (`/diagnostics` → Entities tab → Review queue panel).

**Weekly graph cleanup Job** ([`services/entity-resolver`](services/entity-resolver)): runs Splink (probabilistic record linkage on DuckDB) + Leiden community detection (igraph) to find merge / split / conflict candidates. Auto-applies merges only if Splink probability > 0.99; everything else queues for operator approval. Triggers via `POST /api/entities/cluster-now`.

**Cross-worker cache invalidation:** Postgres LISTEN/NOTIFY on the `entities_invalidate` channel — any promoter / decay update fires a notification; every Next.js worker clears its 30 s LRU.

**EntityInspector UI** ([`components/diagnostics/EntityInspector.tsx`](components/diagnostics/EntityInspector.tsx)) — operator console with seven tabs, all using the shared `<DataTable>` for sort / virtualize / resize / persisted layout:

- **Overview** — health KPIs, observations sparkline, writers donut, classifier-score histogram, active-Job card
- **Entities** — DataTable of teams/competitions; click row → `EntityDrawer` side panel with surface forms + observations
- **Surface forms** — DataTable of every `entity_names` row, status filter (candidate-first), inline promote/retire
- **Observations** — append-only audit log, live-refreshing every 15 s
- **Review queue** — Splink/Leiden findings with Approve/Reject inline
- **Job runs** — entity-resolver Cloud Run Job history; **active runs show a live progress card with current pass + per-pass counters polling every 2 s**
- **Playground** — read-only resolver/classifier probe + controlled "submit observation" form

The header shows a pulsing pill while a cleanup Job is in flight, and the Job-runs tab gets a sky-coloured ring + dot so the operator notices regardless of which tab they're on.

**Required env vars (optional but unlock features):**

- `ENTITY_CLASSIFIER_URL` — Cloud Run Service URL for Tier-2 ML scoring + `/embed` endpoint
- `ENTITY_RESOLVER_JOB_NAME` — Cloud Run Job name for the weekly graph cleanup
- `EMBEDDING_LOOKUP_ENABLED=true` — switches on the resolver's embedding-cosine fallback (after the classifier Job has populated embeddings)

**Migration:** the seed script [`scripts/seed-entities-from-aliases.ts`](scripts/seed-entities-from-aliases.ts) imported the legacy JSON aliases as entities + entity_names rows, dropping known-junk patterns (`obolon`, `sc poltava`, `ho chi minh city`, gender-mismatched, >5-word canonicals). Re-runnable any time.

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

## Styling — Tailwind only, no custom CSS

**The styling system is Tailwind v4 utilities + shadcn primitives. Do not write hand-rolled CSS classes.** Every layout, color, animation, hover state, focus ring, and gradient should be expressible as Tailwind utilities (or arbitrary-value variants like `bg-[oklch(0.18_0.005_250/0.8)]` / `grid-cols-[repeat(24,minmax(0,1fr))]`). When in doubt, reach for utilities first; if a long combo repeats across files, lift it into a React component (`<KpiCard>`, `<MetricChip>`), not a custom CSS class.

**Why:** on 2026-04-25 the dashboard layout silently collapsed because Turbopack's CSS-bundler dropped a ~400-line block of custom rules from `app/globals.css` mid-parse — the source was valid but the compiled chunk just stopped emitting `.db-*`, `.acc-*`, `.fintech-*`, `.dashboard-*`, `.appshell-*`, `.metric-pod`, `.glass-panel`, etc., so every consumer fell back to default `display: block`. Tailwind utilities don't have this failure mode (each utility is independently scanned from JSX). Custom CSS is also harder to refactor (no IDE autocomplete, no purging, no design-token integration with the theme).

**What's allowed in `app/globals.css`:**

- `@import "tailwindcss"` and the other library imports.
- The `@theme inline { ... }` block that maps semantic tokens to CSS variables (this is how Tailwind v4 wires the design system).
- The `:root` / `.dark` blocks defining `--background`, `--foreground`, `--danger`, `--positive`, `--warning`, `--sidebar-*`, etc. — these are theme tokens consumed via Tailwind utilities like `text-foreground`, `bg-danger`, `border-sidebar-border`.
- The `@layer base { * { @apply border-border outline-ring/50 } }` reset (one rule, applies the global border color).
- Sonner toast overrides (`[data-sonner-toast][data-type="..."]`) — these target a third-party library's data attributes, can't be expressed in Tailwind.
- Global scrollbar styling (`::-webkit-scrollbar`) — pseudo-element, no Tailwind equivalent.

**What's NOT allowed:**

- Component-scoped class blocks (`.db-kpi-card { ... }`, `.acc-card { ... }`, `.appshell-topbar { ... }`, etc.). Inline the styling on the JSX, or extract a React component.
- App-specific keyframes (`@keyframes value-update`, `@keyframes nav-slide-in`, `@keyframes fade-up`, etc.). Use Tailwind's built-in animations (`animate-pulse`, `animate-spin`, `animate-fade-in`, `animate-slide-in-from-left`, etc., from `tw-animate-css`) or arbitrary `animate-[name_duration_easing]` with the keyframe declared on the element via `@property` if truly bespoke.
- Utility-style helper classes (`.data-text { font-family: var(--font-jetbrains); ... }`, `.glass-panel { ... }`). Replace with utilities (`font-mono tabular-nums tracking-tight`, etc.) or a wrapper component.

**When migrating an existing component, the steps are:** (1) read the custom-class definition in `globals.css`, (2) translate each declaration into the equivalent Tailwind utility (use `bg-[oklch(...)]` / `shadow-[inset_0_0_30px_oklch(...)]` for arbitrary values), (3) replace the class on the JSX, (4) delete the rule from `globals.css`, (5) verify no other consumer still uses it (`grep -r "the-class-name" app/ components/ lib/`).

This rule overrides "Code Style" or any earlier section that suggested writing custom CSS — when they conflict, this rule wins.

## Tooltips are foundational — every meaningful control has one

Tooltips are not optional polish — they are the platform's primary explanatory layer. The operator should never have to guess what a button does, what a tab contains, what a filter chip narrows by, or what a dropdown menu picks between. **If a control is non-obvious, it gets a Tooltip.**

**The rule:**

- Use the `<Tooltip>` / `<TooltipTrigger>` / `<TooltipContent>` primitives from [`components/ui/tooltip.tsx`](components/ui/tooltip.tsx) — never plain `title=""` HTML attributes for anything beyond a fallback. Native `title` is only acceptable for trivial decorative icons; for any actionable control, the rich Radix tooltip is the standard. Wrap the panel root (or a sensible subtree) in `<TooltipProvider delayDuration={200}>` once.
- **Every workflow step gets a tooltip explaining what it does and what happens next.** Tabs, filter chips, action buttons (approve/reject/verify/delete), bulk dropdowns, refresh/sync buttons, status badges that mean something specific — all of these need explanatory tooltips.
- **Tooltip body follows the "Explanatory copy" rule below** — plain English, concrete example where applicable, no acronym soup. Keep it to 1–2 sentences for action buttons; up to 3 for tab/section explanations.
- **State-aware tooltips:** when the control's behavior changes by context (e.g. "Approve" on the To Review tab merges + learns aliases, "Approve" on the Decided tab overrides any prior verdict), the tooltip body must reflect the current state. Don't ship a tooltip that lies about what the click will do.
- **Cost-coded tooltips for paid actions:** any control that triggers a billed AI call (Gemini Lite/Flash/Pro) must say "AI calls cost money" in the tooltip and recommend cheaper paths first. The dropdown label itself ("Verify with AI (paid)") is the visible cue; the tooltip is the explanation.

**Why this rule exists:** the Matcher Lab's pre-2026-04-26 UI relied on `title=""` for explanations. They were inaccessible on touch devices, didn't render rich content, and were so terse the operator couldn't tell which AI tier was the cheapest or what "auto-suggested" meant. Reaching for proper Tooltip components is a baseline expectation, not a polish pass — code that ships UI without them is incomplete.

## Explanatory copy — plain language with one concrete example

Every tooltip, empty state, section intro, form-field help text, error message, or glossary entry has to be readable by a non-technical operator. Two paragraphs max:

1. **Headline** — one plain-English sentence (the bold first line of any tooltip). NO acronyms, NO field-of-study terms in the headline. "Tests each strategy on bets it has never seen" beats "CPCV — Combinatorial Purged Cross-Validation".
2. **Body** — one short paragraph that weaves a plain-English explanation together with a concrete betting illustration. Uses real-looking numbers ("+3.2% EV", "1,200 settled bets", "100k BDT bankroll"), this app's providers (Pinnacle, NineWickets-Exchange, NineWickets-SB, BetConstruct), and real markets (1X2, Asian Handicap, BTTS, O/U 2.5). Don't separate "definition" from "example" into different blocks — combine them in one flowing paragraph.
3. **Choice tail (optional)** — for picker-type entries only (algorithms, CV mode, staking scheme, Kelly fraction): one short italic sentence answering "why pick this one?". Skip on metric/concept entries.

**Vocabulary cheatsheet** — drop these from user-facing copy unless explicitly kept as a column label. Use the right column instead:

| Don't say in body copy           | Say instead                                                        |
| -------------------------------- | ------------------------------------------------------------------ |
| OOS / out-of-sample              | "on bets it has never seen"                                        |
| in-sample                        | "on bets it trained on"                                            |
| Sharpe ratio                     | "smoothness of returns"                                            |
| Bayesian sampler / TPE (in body) | "learns from the early trials and focuses on what looks promising" |
| stationary block bootstrap       | "we shuffle your history thousands of times"                       |
| confidence interval / CI         | "the believable range"                                             |
| p-value                          | "how likely this is just chance"                                   |
| Pareto frontier                  | "the trade-off line"                                               |
| variance / stdev                 | "how bumpy the equity curve is"                                    |
| 11-dimensional parameter space   | "the menu of knobs"                                                |
| math formulas                    | (drop entirely; describe the intent)                               |

Acronyms (DSR, PBO, WRC, CPCV) are still fine **as column headers and pickers** — that's where the user encounters the term. The tooltip body must explain it without using the acronym again.

**Rules of thumb:**

- Headline + body. No "Why this matters" / "For your bets:" / "What you'll achieve:" labels.
- Prefer concrete numbers over hand-wavy ranges ("ROI 5.2% across 800 bets" beats "decent ROI on a reasonable sample").
- Prefer app-specific nouns ("placed bets", "settled bets", "soft book", "sharp book", "value bet", "EV cutoff") over generic finance jargon ("trades", "positions", "signals").
- A non-technical operator should be able to read any tooltip cold and understand both _what it is_ and _why they'd care_, without needing to look anything else up.

This rule applies everywhere: `/lab/optimisation` tooltips, `/bets` filter explanations, `/value-bets` column headers, API error payloads, onboarding copy, empty states, toast messages. The glossary at [`lib/lab/glossary.ts`](lib/lab/glossary.ts) is the reference implementation — new explanatory copy should follow its `short` / `example` / `objective` structure (the legacy `long` field is deprecated and no longer rendered).

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

### Reusable table component — always use `<DataTable>`

Every table in the app uses [`components/ui/data-table.tsx`](components/ui/data-table.tsx) (`<DataTable>`). It already provides virtualization, sorting, column resize, drag-to-reorder, persistence, infinite scroll, grouping, and selection — opt-in via flags. Do not write a new plain `<table>` for tabular data; if you need a feature `<DataTable>` is missing, extend it in place rather than forking. A 500-row plain table on `/lab/optimisation/[id]` was the root cause of laggy polling on 2026-04-25 — the component exists precisely so we don't repeat that.

Use `getRowId` whenever rows are returned from a polled query, otherwise the virtualizer treats every poll as a full DOM rebuild.

The only existing exception is [`components/spreadsheet/ValueBetSpreadsheet.tsx`](components/spreadsheet/ValueBetSpreadsheet.tsx), which is intentionally bespoke because its row layout is positional (event-header rows, family grouping) and doesn't map onto a flat column model. New tables should not become further exceptions — solve it inside `<DataTable>`.
