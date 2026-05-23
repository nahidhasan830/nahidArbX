# CLAUDE.md

Full-form reference for this repository. [`AGENTS.md`](AGENTS.md) is the terse index — keep both in sync in the same commit.

For the active ML rebuild, [`ML_REBUILD_PLAN.md`](ML_REBUILD_PLAN.md) is the sole source of truth for phases and status.

## Solo-developer workflow

No branches. Everything lands on the working branch (treat as `master`). Commit everything relevant in as few commits as the work warrants — don't fragment across branches or separate agent vs user changes.

## Runtime

Dual-process on **localhost** (`nahidarbx.store` is inactive). Bangladesh IP required for NineWickets/Velki providers.

**Dev machine:** MacBook Pro 14″ (Nov 2024), Apple M4 Pro, 24 GB unified memory. Supports local Gemma 4 26B (MoE) via Ollama.

| Component         | Where                                                        | Notes                                                                          |
| ----------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Engine            | `npm run engine` (tsx)                                       | 13 background subsystems. `NAHIDARBX_ENGINE=1`                                 |
| Next.js           | `http://localhost:3000`                                      | `npm run dev` — web-only, read-only UI + API                                   |
| Optimizer sidecar | Cloud Run **Job** `nahidarbx-optimizer-job`                  | ML training sidecar (LightGBM). Project `nahidarbx-6e73`, region `asia-south1` |
| Database          | Cloud SQL Postgres `nahidarbx-6e73:asia-south1:nahidarbx-db` | Via Cloud SQL Connector (no local proxy needed)                                |

## Commands

```bash
npm run engine       # Start background engine (tsx engine.ts)
npm run dev          # Start Next.js web-only (Turbopack)
npm run dev:all      # Start both in one terminal
npm run engine:stop  # Stop engine gracefully
npm run kill         # Force-kill port 3000
npm run build        # Production build — always run after changes
npm run lint         # ESLint
npm run test:unit    # Node built-in runner: node --import tsx --test lib/**/*.test.ts
npx vitest run       # Vitest: tests/unit/
npm run test:settle  # Node runner: lib/settle/*.test.ts only
npm run db:generate  # Drizzle codegen
npm run db:migrate   # Drizzle migrations
```

Two separate test systems: Vitest (`tests/unit/`) and Node built-in runner (`lib/**/*.test.ts`). UI verification is manual — do not run Playwright E2E suites. **Never open a browser for testing; write scripts (bash/curl/Python) instead.** Before browser automation, always check if an API endpoint can be used — prefer API/curl over Playwright.\*\*

## Architecture

NahidArbX is a real-time value-bet finder. Compares soft-book prices (NineWickets Exchange/Sportsbook, BetConstruct) against Pinnacle (sharp) and flags positive-EV opportunities. Detected bets persist to Postgres for review + settlement on `/bets`.

**Dual-process architecture:** `engine.ts` runs all background subsystems (sync, WebSockets, detection, auto-place, auto-settle, Telegram). Next.js (`npm run dev`) is a thin read-only web server. `NAHIDARBX_ENGINE=1` env var signals both processes. `instrumentation.ts` calls `ensureDbReady()` first, then skips background tasks when engine flag is set.

**DB initialization:** `ensureDbReady()` in `lib/db/client.ts` creates the Pool asynchronously via Cloud SQL Connector. Called by `instrumentation.ts` (Next.js) and `engine.ts` (standalone) before any DB access. The `db` export is a transparent Proxy that forwards to the initialized Drizzle instance.

**4-phase pipeline:** Fixtures → Matching → Markets (atoms) → Value-bet detection. Event-driven reactive detection (500ms debounce).

**Key terms:** `Family` = market with mutually exclusive outcomes (e.g. 1X2). `Atom` = single outcome (e.g. Home Win). Bet IDs are deterministic: `${eventId}|${familyId}|${atomId}`.

## Routes

| Route                   | Purpose                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- |
| `/dashboard`            | Central betting-account dashboard                                                |
| `/value-bets`           | Value-bet / arb finder                                                           |
| `/bets`                 | Bets history — settlement + review                                               |
| `/lab/ml`               | ML Optimizer — LightGBM pipeline dashboard with current-contract corpus progress |
| `/api/value-bets`       | GET: arb data, POST: manual sync                                                 |
| `/api/ml/pipeline`      | GET: ML pipeline stats plus current-contract corpus counters                     |
| `/api/ml/training-data` | GET: trainer drill-down rows plus shared current-contract corpus summary         |
| `/api/ml/retrain`       | POST: trigger Cloud Run training job                                             |

## Critical Rules

### Architecture & data

- **`engine.ts`** is the standalone background process. **`instrumentation.ts`** is the Next.js boot hook — inits DB, skips background tasks when `NAHIDARBX_ENGINE=1`.
- **`bets` is the only settlement table.** `value_bets` and `placed_bets` are dropped legacy.
- **Settlement pipeline is shared.** All paths converge on `settleBatch` / `applySettlementOutcomes`.
- **`singleton()` from `lib/util/singleton.ts`** for HMR-safe state. Module-level `let` breaks under Turbopack.
- **`better-sqlite3` is auth-only.** App DB is Postgres via Drizzle (`snake_case` casing).
- **`lib/shared/constants.ts`** is the single source for magic numbers (not `lib/config.ts`).
- **Single `.env` file** at repo root. No `.env.local` or `.env.example`.
- **Middleware uses `jose`** (Edge Runtime), not `jsonwebtoken`.
- **All external data validated with Zod.**
- **Current-contract corpus accounting lives in `lib/ml/training-sample-accounting.ts`.** `/api/ml/pipeline`, `/api/ml/training-data`, and `/lab/ml` must reuse that shared source and keep raw settled/current-contract/win/loss progress separate from stricter trainer-readiness counts.

### Settlement

- **No automated settlement AI.** Settlement uses source-only tiers: cache → ESPN/API-Football/SofaScore. Unresolved rows stay pending for manual review.
- **Manual Google AI Mode is only a human verification link.** It must not feed backend settlement or auto-apply outcomes.
- **Manual re-settle bypasses cache.** Operator-triggered `/api/bets-history/settle` calls default to `bypassCache: true`; the automatic scheduler calls `settleBatch` directly and keeps Tier 0 enabled.
- **Prefer deterministic settlement.** `settleBet(row, score)` handles 80%+ of markets with zero AI.
- **Telegram notifications only for placed bets** — if `placedAt` is null, settle silently.
- **Auto-place stakes snap to 100 BDT multiples** (`AUTO_PLACE_STAKE_BUCKET`), min 200 BDT.
- **Prefilled AI prompts** are the preferred pattern for heavy discovery — generate a pre-built prompt for manual copy-paste rather than automated Gemini calls.

### UI rules

- **Styling is Tailwind only — no custom CSS.** Every style as Tailwind utilities. If a combo repeats, extract a React component, not a CSS class. `globals.css` is reserved for: Tailwind imports, `@theme inline` tokens, `:root`/`.dark` variables, `@layer base` border reset, Sonner overrides, scrollbar styling. No component-scoped classes, no app-specific keyframes, no utility helpers.
- **Every table uses `<DataTable>`** (`components/ui/data-table.tsx`). Virtualization, sorting, resize, drag-reorder, persistence, infinite scroll, grouping, selection — all opt-in. Don't write plain `<table>`. Always pass `getRowId` for polled queries. Only exception: `ValueBetSpreadsheet.tsx` (positional layout).
- **Toolbar/filter components are reused** across spreadsheet surfaces. Standard: `h-7` / `px-3 py-1.5` / `bg-muted/40` / `text-[11px]` buttons.
- **Typography tiers:** **Prose** (sentences to read — tooltips, descriptions, help text) → `text-sm` (14px min). **Chrome** (labels to scan — buttons, badges, table cells) → `text-[11px]`/`text-xs`. Never put full sentences at `text-[11px]`.
- **Tooltips are foundational.** Use `<Tooltip>`/`<TooltipTrigger>`/`<TooltipContent>` from `components/ui/tooltip.tsx` — never plain `title=""`. Wrap panel root in `<TooltipProvider delayDuration={200}>`. State-aware tooltips must reflect current state. AI-triggering controls must say "AI calls cost money."
- **Explanatory copy: plain language + one example.** Headline (plain English, no acronyms) + body (explanation woven with concrete betting example using real providers/markets/numbers). No "Why this matters" labels. Glossary at `lib/lab/glossary.ts` is reference impl (`short`/`example`/`objective` fields; `long` is deprecated). See vocabulary cheatsheet below.

**Copy vocabulary cheatsheet:**

| Don't say           | Say instead                      |
| ------------------- | -------------------------------- |
| OOS / out-of-sample | "on bets it has never seen"      |
| Sharpe ratio        | "smoothness of returns"          |
| p-value             | "how likely this is just chance" |
| confidence interval | "the believable range"           |
| Pareto frontier     | "the trade-off line"             |
| math formulas       | (drop — describe the intent)     |

### Workflow & infrastructure

- **Fix scripts: agent runs them, not the operator.** Execute directly using `.env` + ADC. Verify outcome. Destructive actions need explicit say-so.
- **Bangladesh geo-restriction.** Engine MUST run from Bangladesh network for NineWickets/Velki. Cloud Run asia-south1 will NOT work.
- **Cloud Run: Jobs for batch work, Services for HTTP only.** `--no-cpu-throttling` does NOT prevent idle reaping.
- **Scrape.do proxy is SofaScore-fallback only.** Direct first, proxy on 403 only. Free tier 1k credits/mo.
- **Post-change: always run `npm run build` + `npm run lint`**. Don't run Playwright E2E.
- **Always clean dead code and artifacts** (unused scripts, stale imports, temp files) after completing a task.

## Entity Resolution

Postgres-backed alias system replacing legacy JSON files. 5 tables: `entities`, `entity_names`, `name_observations`, `entity_review_queue`, `entity_resolver_runs`.

**Lookup:** `(provider, surface_normalized, competition_id)` UNIQUE — tournament-scoped. **Ingress:** all writers call `recordObservation` in `lib/matching/entities/observations.ts`.

**4-tier promoter** (`lib/matching/entities/promoter.ts`, every 5 min):

- **Tier 0** — deterministic gates: gender mismatch, team-variant mismatch (U17/U19/U20/U21/U23/Reserves/Academy/Futsal/etc.), group conflict, competing-candidate
- **Tier 1** — Bayesian evidence with provider/source weights
- **Tier 2** — LightGBM + conformal calibration (uncertain band [1.0, 3.0], promote at score ≥ 0.92 AND p-value ≤ 0.05)
- **Tier 3** — operator review queue

**Weekly cleanup Job** (`services/entity-resolver`): Splink + Leiden community detection. Auto-merges at probability > 0.99, queues rest for review.

**UI:** `EntityInspector` at `/diagnostics → Entities` — 7 tabs (Overview, Entities, Surface forms, Observations, Review queue, Job runs, Playground), all on `<DataTable>`.

**Env vars:** `ENTITY_CLASSIFIER_URL`, `ENTITY_RESOLVER_JOB_NAME`, `EMBEDDING_LOOKUP_ENABLED`.

## Value-Bet Detection

```
trueProb       = vig-removed Pinnacle probability
adjustedOdds   = 1 + (softOdds - 1) * (1 - commissionPct/100)
evPct          = (adjustedOdds * trueProb - 1) * 100
kellyFraction  = max(0, (b*p - q) / b)
kellyStake     = kellyFraction * KELLY_FRACTION * VALUE_TOTAL_STAKE
```

Flag as value bet when: sharp odds exist + fresh, soft odds exist + fresh, `evPct ≥ MIN_EV_PCT` (2.0).

## Event Matching

```
score = 0.6 * teamSimilarity + 0.2 * competitionSimilarity + 0.2 * timeScore
timeScore = max(0, 1 - timeDiff / 7200000)   // 2hr window
match if score >= 0.85
```

Competition names normalized (country adjectives → nouns).

## File Structure

| Path                              | Purpose                                                                  |
| --------------------------------- | ------------------------------------------------------------------------ |
| `engine.ts`                       | Standalone background engine entry point                                 |
| `instrumentation.ts`              | Next.js boot hook — DB init + conditional background tasks               |
| `lib/db/client.ts`                | Async DB pool init (`ensureDbReady()`) + Proxy `db` export               |
| `lib/types.ts`                    | Core types (Provider, NormalizedEvent)                                   |
| `lib/providers/registry.ts`       | Single source of truth for provider metadata                             |
| `lib/store.ts`                    | Events store + SyncStatus                                                |
| `lib/adapters/*.ts`               | Provider event adapters                                                  |
| `lib/atoms/`                      | Family/atom types, registry, store, fetcher, value-detector, vig-removal |
| `lib/db/schema.ts`                | Postgres `bets` + settlement tables                                      |
| `lib/db/repositories/bets.ts`     | Upsert/list/place/settle repository                                      |
| `lib/auth/token-manager.ts`       | Pinnacle token capture (via cloudflare-bridge)                           |
| `lib/shared/cloudflare-bridge.ts` | Shared CF-solve + in-page-fetch pipeline                                 |
| `lib/matching/matcher.ts`         | Event matching with string-similarity                                    |
| `lib/background/fetcher.ts`       | Sync scheduler                                                           |

## Provider Adapter Pattern

```typescript
interface ProviderAdapter {
  name: Provider;
  fetchEvents(): Promise<NormalizedEvent[]>;
}

interface AtomsProviderAdapter {
  providerId: ProviderKey;
  fetchAndStoreOdds(
    providerEventId: string,
    normalizedEventId: string,
  ): Promise<number>;
}
```

## Environment Variables

```bash
# Pinnacle (via Betjili)
BETJILI_USERNAME=  BETJILI_PASSWORD=  TOKEN_HEADLESS=true

# Pinnacle Config
PINNACLE_DAYS_AHEAD=2  PINNACLE_PAGE_SIZE=1000

# NineWickets
NINEWICKETS_API_KEY=  NINEWICKETS_BASE_URL=

# App
FETCH_INTERVAL_MS=60000

# Gemini
GEMINI_API_KEY=  GEMINI_DEFAULT_MODEL=gemini-3-flash-preview
GEMINI_PRO_MODEL=gemini-3.1-pro-preview  GEMINI_LITE_MODEL=gemini-3.1-flash-lite-preview

# Database (Cloud SQL Postgres)
DATABASE_URL=postgresql://nahidarbx_app:<pw>@127.0.0.1:5432/nahidarbx

# Optimizer (Cloud Run Job)
GCP_PROJECT_ID=nahidarbx-6e73  GCP_REGION=asia-south1  OPTIMIZER_JOB_NAME=nahidarbx-optimizer-job
```

## Database

Cloud SQL Postgres 16 — project `nahidarbx-6e73`, instance `nahidarbx-db` (db-f1-micro), database `nahidarbx`, user `nahidarbx_app`. Connection via `@google-cloud/cloud-sql-connector` (async init in `lib/db/client.ts`). No local cloud-sql-proxy needed.

## Cloudflare Bridge (Shared Auth Pipeline)

Both Pinnacle (`lib/auth/token-manager.ts`) and 9W Sportsbook (`lib/betting/ninewickets/session.ts`) use the shared `lib/shared/cloudflare-bridge.ts` pipeline: Playwright solves CF challenge (~4s), then `page.evaluate(fetch())` runs login + getGameUrl — zero UI automation. Retry with backoff (3 attempts), auto-healing (browser disposal on failure). Session files in `sessions/` (gitignored): `betjili/pinnacle-token.json`, `9wkts/session.json`.
