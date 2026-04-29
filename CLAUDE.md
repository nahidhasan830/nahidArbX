# CLAUDE.md

Full-form reference for this repository. [`AGENTS.md`](AGENTS.md) is the terse index — keep both in sync in the same commit.

## Solo-developer workflow

No branches. Everything lands on the working branch (treat as `master`). Commit everything relevant in as few commits as the work warrants — don't fragment across branches or separate agent vs user changes.

## Runtime

The app runs on **localhost** (`nahidarbx.store` is inactive).

| Component | Where | Notes |
|-----------|-------|-------|
| Next.js | `http://localhost:3000` | `npm run dev` |
| Optimizer sidecar | Cloud Run **Job** `nahidarbx-optimizer-job` | Project `nahidarbx-6e73`, region `asia-south1`. Redeploy: `bash services/optimizer/redeploy.sh` |
| Database | Cloud SQL Postgres `nahidarbx-6e73:asia-south1:nahidarbx-db` | Local: `cloud-sql-proxy --port 5432 nahidarbx-6e73:asia-south1:nahidarbx-db` |

## Commands

```bash
npm run dev          # Dev server (http://localhost:3000)
npm run build        # Production build — always run after changes
npm run lint         # ESLint
npm run test:unit    # Node built-in runner: node --import tsx --test lib/**/*.test.ts
npx vitest run       # Vitest: tests/unit/
npm run test:settle  # Node runner: lib/settle/*.test.ts only
npm run db:generate  # Drizzle codegen
npm run db:migrate   # Drizzle migrations
```

Two separate test systems: Vitest (`tests/unit/`) and Node built-in runner (`lib/**/*.test.ts`). UI verification is manual — do not run Playwright E2E suites.

## Architecture

NahidArbX is a real-time value-bet finder. Compares soft-book prices (NineWickets Exchange/Sportsbook, BetConstruct) against Pinnacle (sharp) and flags positive-EV opportunities. Detected bets persist to Postgres for review + settlement on `/bets`.

**4-phase pipeline:** Fixtures → Matching → Markets (atoms) → Value-bet detection. Background sync every 60s. Frontend polls `/api/admin` every 30s (2s when sync active).

**Key terms:** `Family` = market with mutually exclusive outcomes (e.g. 1X2). `Atom` = single outcome (e.g. Home Win). Bet IDs are deterministic: `${eventId}|${familyId}|${atomId}`.

## Routes

| Route | Purpose |
|-------|---------|
| `/dashboard` | Central betting-account dashboard |
| `/value-bets` | Value-bet / arb finder |
| `/bets` | Bets history — settlement + review |
| `/lab/optimisation` | Strategy parameter optimizer |
| `/api/value-bets` | GET: arb data, POST: manual sync |
| `/api/optimizer/runs` | POST: queue run + trigger Job; GET: list runs |

## Critical Rules

### Architecture & data

- **`bets` is the only settlement table.** `value_bets` and `placed_bets` are dropped legacy. New code uses `bets` everywhere.
- **Settlement pipeline is shared.** Auto-settle, manual re-settle, manual outcome application all converge on `settleBatch` / `applySettlementOutcomes`.
- **`singleton()` from `lib/util/singleton.ts`** for HMR-safe state. Module-level `let` breaks under Turbopack.
- **`instrumentation.ts`** is the server-boot hook — starts sync + auto-settlement schedulers headlessly.
- **`better-sqlite3` is auth-only.** App DB is Postgres via Drizzle.
- **Drizzle casing is `snake_case`** — DB columns snake_case, TS camelCase via casing transform.
- **`lib/shared/constants.ts`** is the single source for magic numbers (not `lib/config.ts`).
- **`lib/betting/settlement-cascade.ts`** is deprecated (empty re-export).
- **Single `.env` file** at repo root. No `.env.local` or `.env.example`.
- **Don't assume local `DATABASE_URL` is authoritative** — prefer the real cloud path via configured SDK/connector.
- **Middleware uses `jose`** (Edge Runtime), not `jsonwebtoken`.
- **All external data validated with Zod.**

### Settlement & AI

- **No automatic AI.** Settlement is deterministic Tier 0/1/2 only (cache → live feed → ESPN/SofaScore). The kill-switch was removed because there's no automatic AI to switch off.
- **Only paid Gemini surface is operator-triggered:** `/bets` "AI settle" dropdown → `aiLabelBets(ids, { forceAi: true, aiModel })` → Tier 3 `url_context`. Cost-guarded by `AI_MAX_PER_REQUEST_USD` (default $2).
- **The automatic scheduler MUST never set `forceAi: true`.** No code path from `scheduler.ts` → `auto-settler.ts` → `settle-batch.ts` → `waterfall.ts` opts in to AI.
- **URLs for `url_context` must be short scoreboard pages** (SofaScore, FlashScore). Wikipedia/indexes blow the context window.
- **Every paid Gemini call needs error classification.** Spend-cap errors must short-circuit (`UrlContextBatchAbort`).
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

| Don't say | Say instead |
|-----------|-------------|
| OOS / out-of-sample | "on bets it has never seen" |
| Sharpe ratio | "smoothness of returns" |
| p-value | "how likely this is just chance" |
| confidence interval | "the believable range" |
| Pareto frontier | "the trade-off line" |
| math formulas | (drop — describe the intent) |

### Workflow & infrastructure

- **Fix scripts: agent runs them, not the operator.** Execute directly using `.env` + ADC. Announce briefly, run, verify outcome, report. If it fails, surface error and ask for the unblocker. Extend existing `scripts/` runners. Cloud SQL DDL: `scripts/apply-pending-migrations.ts`. Destructive actions (DROP TABLE, force push) still need explicit say-so.
- **Cloud Run: Jobs for batch work, Services for HTTP only.** `--no-cpu-throttling` does NOT prevent idle instance reaping — only `--min-instances=1` does (~$80-100/mo). The optimizer was migrated Service→Job after a sweep died mid-flight.
- **IPRoyal proxy is SofaScore-fallback only.** Direct request first, proxy only on 403. Never route other sources (ESPN, Pinnacle, Gemini) through it. Cooldowns (30-min per-proxy, 10-min global) are intentional. `sessions/iproyal/proxies.txt` is gitignored.
- **Post-change: always run `npm run build` + `npm run lint`** (unless trivial CSS/text). Don't run Playwright E2E.

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
adjustedOdds   = softOdds * (1 - commissionPct/100)
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

| Path | Purpose |
|------|---------|
| `lib/types.ts` | Core types (Provider, NormalizedEvent) |
| `lib/providers/registry.ts` | Single source of truth for provider metadata |
| `lib/store.ts` | Events store + SyncStatus |
| `lib/config.ts` | App config (intervals, pagination) |
| `lib/adapters/*.ts` | Provider event adapters |
| `lib/atoms/` | Family/atom types, registry, store, fetcher, value-detector, vig-removal |
| `lib/db/schema.ts` | Postgres `bets` + settlement tables |
| `lib/db/repositories/bets.ts` | Upsert/list/place/settle repository |
| `lib/auth/token-manager.ts` | Pinnacle token capture (via cloudflare-bridge) |
| `lib/shared/cloudflare-bridge.ts` | Shared CF-solve + in-page-fetch pipeline (Pinnacle, 9W, future providers) |
| `lib/matching/matcher.ts` | Event matching with string-similarity |
| `lib/background/fetcher.ts` | Sync scheduler |

## Provider Adapter Pattern

```typescript
interface ProviderAdapter {
  name: Provider;
  fetchEvents(): Promise<NormalizedEvent[]>;
}

interface AtomsProviderAdapter {
  providerId: ProviderKey;
  fetchAndStoreOdds(providerEventId: string, normalizedEventId: string): Promise<number>;
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

Cloud SQL Postgres 16 — project `nahidarbx-6e73`, instance `nahidarbx-db` (db-f1-micro), database `nahidarbx`, user `nahidarbx_app`. Local: start `cloud-sql-proxy --port 5432 nahidarbx-6e73:asia-south1:nahidarbx-db`, then `127.0.0.1:5432` works transparently.

## Cloudflare Bridge (Shared Auth Pipeline)

Both Pinnacle (`lib/auth/token-manager.ts`) and 9W Sportsbook (`lib/betting/ninewickets/session.ts`) use the shared `lib/shared/cloudflare-bridge.ts` pipeline: Playwright solves CF challenge (~4s), then `page.evaluate(fetch())` runs login + getGameUrl — zero UI automation. Retry with backoff (3 attempts), auto-healing (browser disposal on failure). Session files in `sessions/` (gitignored): `betjili/pinnacle-token.json`, `9wkts/session.json`.
