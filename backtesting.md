# Backtesting Infrastructure — Implementation Brain

> **Purpose of this doc:** Full-context plan for adding persistent storage + a backtesting dashboard on top of the existing value-bet detection pipeline. Designed to be pasted at the start of a fresh chat session so Claude can pick up work without prior conversation history.
>
> **How to use this doc in a new session:**
>
> 1. Paste the entire file contents at the top of the chat.
> 2. Jump to **§ Current Status** to see which phase is next.
> 3. Read **§ Decisions Log** so you don't relitigate settled choices.
> 4. Read **§ Open Questions** — surface any still-unresolved items to the user before coding.
> 5. Execute the **next phase** section end-to-end. Update **§ Current Status** when done.

---

## § Current Status

| Phase | Title                                                   | Status                            |
| ----- | ------------------------------------------------------- | --------------------------------- |
| 0     | Plan written (this doc)                                 | ✅ Done                           |
| 1     | Cloud SQL Postgres provisioned                          | ✅ Done                           |
| 2     | Drizzle schema + migration infra                        | ✅ Done                           |
| 3     | `value_bets` persistence wiring (detection → DB upsert) | ✅ Done                           |
| 4     | `/backtest` dashboard UI (read-only table + filters)    | 🟡 UI mockup only (backend wired) |
| 5     | AI analysis integration (Gemini on selected rows)       | 🟡 Backend done; UI pending       |
| 6     | Outcome tracking (manual marking + P&L)                 | 🟡 Backend done; UI pending       |
| 7     | Arbitrage code purge (cleanup)                          | ✅ Done                           |

**Next up:** fold the `/backtest` mockup into the unified `/admin` spreadsheet (per user UI spec — one table universe; per-row manual + AI settlement; model picker; Google-AI-Mode verify link). See `.claude/projects/-Users-nahidhasan-nahidArbX/memory/project_ui_requirements.md`.

**Phase 7 outcome (2026-04-18):**

- `is_arbitrageable` stripped from all 204 families in `lib/atoms/atoms.json` (small Node script, verified zero remaining).
- Removed types (`AtomArbitrage`, `AtomStake`, `Family.is_arbitrageable`), registry helpers (`getArbitrageableFamilies`, `getArbitrageableFamilyIds`), and arb-only constants (`MIN_PROFIT_PCT`, `DEFAULT_TOTAL_STAKE`, `MAX_REALISTIC_PROFIT`).
- `lib/config.ts` trimmed to the fields actually consumed (fetchInterval + Pinnacle). Dropped `minProfit` and `totalStake` (no callers).
- `docker-compose.yml`: dropped `MIN_PROFIT_PCT` and `TOTAL_STAKE` env defaults.
- UI copy refreshed: brand tagline, `/about` body + metadata description, `.well-known/security.txt`, match-review helper text.
- Docs updated: `CLAUDE.md`, `ARCHITECTURE.md`, `IMPROVEMENTS.md`, `.claude/commands/code-cleanup.md`. Deleted `.claude/commands/arb-check.md`.
- Final grep: zero `arbitrage|Arbitrage|AtomArbitrage|is_arbitrageable|getArbitrageable|MIN_PROFIT_PCT|DEFAULT_TOTAL_STAKE|MAX_REALISTIC_PROFIT` hits in `lib/`, `app/`, `components/`, `scripts/`.
- `npm run build` clean (only pre-existing `/_global-error` prerender issue, unrelated). Admin/login E2E pass; `/about`, `/api/health`, `/404` failures are pre-existing auth-middleware issues, not introduced by this cleanup.

**Phase 4/5/6 backend outcome (2026-04-18):**

REST endpoints:

- `GET /api/backtest/value-bets` — [app/api/backtest/value-bets/route.ts](app/api/backtest/value-bets/route.ts). Query params: `from`, `to`, `marketType`, `timeScope`, `softProvider`, `outcome` (incl. `settled`/`unsettled`), `minEv`, `maxEv`, `search`, `isDummy`, `limit`, `offset`. EV% filter uses a SQL expression mirroring `derive.evPctMax` so pagination is correct. Zod-validated.
- `PATCH /api/backtest/value-bets/[id]` — mark single outcome. Body `{ outcome }`. Returns updated row.
- `POST /api/backtest/outcomes/bulk` — [app/api/backtest/outcomes/bulk/route.ts](app/api/backtest/outcomes/bulk/route.ts). Body `{ updates: [{id, outcome}] }` (≤500). Returns `{applied, attempted, skipped}`.

AI endpoints (both Gemini, require `GEMINI_API_KEY`):

- `POST /api/backtest/ai-label` — [lib/ai/label-outcome.ts](lib/ai/label-outcome.ts) + [app/api/backtest/ai-label/route.ts](app/api/backtest/ai-label/route.ts). Per-bet Gemini call with `tools: [{ googleSearch: {} }]` grounding. Body `{ ids: string[] (≤50), model?: "flash"|"pro", concurrency?: 1-8 }`. Returns `[{id, proposedOutcome, confidence (0-1), reasoning, sources[], model, queries[]}]`. Verified: returns `pending` with cited sources when event hasn't happened yet.
- `POST /api/backtest/ai-analyze` — [lib/ai/analyze-backtest.ts](lib/ai/analyze-backtest.ts) + [app/api/backtest/ai-analyze/route.ts](app/api/backtest/ai-analyze/route.ts). Single Gemini call over up to 500 rows with structured JSON output (summary, patterns, concerns, recommendations, by_market). Body accepts either `{ ids }` or `{ filters }` (same filter shape as the list endpoint). Verified: produced a usable 5-pattern / 4-concern analysis of the 200-row dummy seed.

Repo additions ([lib/db/repositories/value-bets.ts](lib/db/repositories/value-bets.ts)): `listValueBets`, `getValueBetById`, `getValueBetsByIds` (uses Drizzle `inArray`), expanded filter surface.

**Phase 3 outcome (2026-04-18):**

- `lib/db/repositories/value-bets.ts` — `persistValueBets(bets)`, `listValueBets(filters)`, `markOutcome(id, outcome)`, `markOutcomesBulk(updates)`.
- Stable primary key `${eventId}|${familyId}|${atomId}` (computed in repo — the detector's `vb.id` includes provider+timestamp so we build our own key to honour D2 dedup).
- Upsert uses `ON CONFLICT DO UPDATE` — first detection freezes `soft_provider`, `soft_odds_first`; each tick bumps `last_seen_at`, `soft_odds_last`, `soft_odds_max = GREATEST(old, new)`, `tick_count + 1`.
- Hook in `lib/background/fetcher.ts` (after `setValueBets`) — wrapped in try/catch so DB failures log but never break the sync loop. Logs `[Sync] DB: +N new, ~M updated` per cycle.
- Missing-event rows skipped with warning (per user directive); missing-family ditto.
- **Schema refined to inputs-only**: dropped 7 derivable columns (`sharp_true_odds`, `soft_odds_adjusted_first`, `ev_pct_first/last/max`, `kelly_fraction_first`, `kelly_stake_first`, `pnl`) and added `soft_odds_max`. All derivation lives in `lib/backtest/derive.ts` (`derive()`, `kellyStake()`, `settlementPnl()`). UI + analyze.ts updated to use `derive()`. Rationale: strategy-dependent values (Kelly size, P&L) should be computed per query, not stored once.
- `scripts/seed-dummy.ts` + `npm run db:seed-dummy` — writes 200 seeded dummy rows with `is_dummy = true` so the UI can iterate against DB data while real sync data accumulates. Dummy rows are filterable/purgeable via the `is_dummy` column (indexed).

**Phase 2 outcome (2026-04-18):**

- `lib/db/schema.ts` — `valueBets` table with 6 user indexes (first-seen DESC, market+scope, soft provider, soft_odds_max DESC, outcome partial, event start) + `is_dummy` index (added in migration 0001).
- `lib/db/client.ts` — Drizzle client with `pg` Pool (global singleton in dev).
- `drizzle.config.ts` — uses `casing: "snake_case"` so TypeScript stays camelCase while DB stays snake_case.
- Migrations applied cleanly to Cloud SQL.
- Scripts: `npm run db:generate | db:migrate | db:push | db:studio | db:seed-dummy`.
- Outcome is `NOT NULL DEFAULT 'pending'` (tightened from the doc's nullable default — Phase 3 never needs to write it explicitly).

**Phase 1 outcome (2026-04-18):**

- GCP project: `nahidarbx-6e73` (linked to billing account `019A69-7FB610-99B9FD`)
- Cloud SQL instance: `nahidarbx-db` (db-f1-micro, Postgres 16.13, `asia-south1`)
- Database: `nahidarbx`, app user: `nahidarbx_app`
- Local connection via `cloud-sql-proxy --port 5432 nahidarbx-6e73:asia-south1:nahidarbx-db`
- `DATABASE_URL` lives in `/Users/nahidhasan/nahidArbX/.env` (gitignored). Note: this project uses a single `.env` file — **do not create `.env.local` or `.env.example`**.

---

## § Mission

Build infrastructure to **validate whether our value-betting strategy actually makes money over time.**

Flow:

1. Sync pipeline detects value bets every ~60s (already built).
2. Each unique opportunity is **persisted once** to Postgres on first detection.
3. A **separate `/backtest` dashboard** lets the user slice history by date, market, provider, EV range, etc.
4. User selects a slice and sends it to **Gemini** for qualitative analysis.
5. Eventually — user marks **outcomes** (win/loss/void) so P&L is computable and the strategy can be judged.

**Non-goals:**

- No multi-user / auth scope changes for backtesting views (reuse existing admin auth).
- No real-money placement automation.
- No live streaming to the dashboard (polling is fine — it's a historical view).

---

## § Critical Analysis (read this every session)

### What's already built (do NOT rebuild)

| Component               | File                                                       | Purpose                                                              |
| ----------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| Value bet detector      | [lib/atoms/value-detector.ts](lib/atoms/value-detector.ts) | EV calculation, Kelly sizing, commission-adjusted, incremental cache |
| Vig removal             | [lib/atoms/vig-removal.ts](lib/atoms/vig-removal.ts)       | Balanced-margin true probability                                     |
| Provider classification | [lib/providers/registry.ts](lib/providers/registry.ts)     | Sharp (Pinnacle) vs. soft (NW Exchange, NW Sportsbook, BetConstruct) |
| Commission adjustment   | [lib/shared/commission.ts](lib/shared/commission.ts)       | Exchange commission handling                                         |
| Value-bet constants     | [lib/shared/constants.ts](lib/shared/constants.ts)         | `MIN_EV_PCT=2`, `KELLY_FRACTION=0.25`, `VALUE_TOTAL_STAKE=1000`      |
| Detection pipeline      | [lib/background/fetcher.ts](lib/background/fetcher.ts)     | 60s sync scheduler                                                   |
| Gemini client           | [lib/ai/gemini.ts](lib/ai/gemini.ts)                       | Structured-JSON, tiered models                                       |
| ORM (not yet wired)     | `drizzle-orm` in `package.json`                            | Will use for Postgres                                                |

### What's missing (this plan)

1. **Persistence.** Value bets are held in an in-memory cache only. Restart = history lost.
2. **Historical dashboard.** Current `/admin` shows live state only — no temporal slicing.
3. **Strategy validation loop.** No outcome column, no P&L, no way to know if the strategy works.

### Honest risks / gaps

#### 🔴 The outcome-tracking gap (most important)

**Without outcomes, "backtesting" is just bet logging.** You cannot validate a value-betting strategy without knowing which bets won. Options:

- **(a) Manual entry** — dashboard row action to mark `WON / LOST / VOID / PUSH`. Simple. Scales poorly past ~50 bets/day.
- **(b) Automated results adapter** — scrape Pinnacle settled markets post-event, or use a free sports-results API (API-Football, TheSportsDB). Adds a provider adapter.
- **(c) Infer via Gemini** — unreliable; not recommended for ground truth.

**Decision:** start with (a) in Phase 6, leave (b) as a future phase. Flag in UI which bets are `pending_result`.

#### 🟡 Staleness of Pinnacle line

If Pinnacle token briefly expires and fetches fail, the cached sharp odds may go stale before being invalidated. Value bets detected against stale sharp lines are noise. Already somewhat mitigated by `MAX_VALUE_ODDS_AGE_MS = 90s` but worth capturing **`sharp_odds_age_ms` at detection** so we can filter suspect rows later.

#### 🟡 Event-matching errors

A bad match (wrong fixture linked across providers) → phantom value bets that "don't exist." Backtests on mismatched rows poison conclusions. **Capture `match_confidence` (from matcher) on each stored row** so we can filter `>= 0.95` for clean analyses.

#### 🟡 Closing line vs. detection-time odds

Pro value-bet validation uses **Closing Line Value (CLV)**: did the market move _toward_ our bet between detection and kickoff? Without kickoff-time snapshots, we can't compute CLV. Phase 6+ should capture a `closing_*` snapshot via a pre-event cron. Phase 3 schema reserves the columns but leaves them nullable.

#### 🟢 "Value vs. arbitrage" confusion in the existing codebase

Half-purged arb artifacts: `AtomArbitrage` type, `is_arbitrageable` flag, `getArbitrageableFamilies()`, various comments. None gate value-bet detection, but they add noise. Cleanup is Phase 7 so it doesn't block database work.

---

## § Decisions Log (settled — don't relitigate)

| #   | Decision                                                                                                                                                                   | Rationale                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Pinnacle is the only sharp.**                                                                                                                                            | Industry standard, ~2% vig, already classified as `bookmakerType: "sharp"` in [lib/providers/registry.ts](lib/providers/registry.ts).         |
| D2  | **One row per `(event_id, family_id, atom_id)`.** First-detected `soft_provider` wins; later detections on the same atom by other providers are **ignored** at write time. | User directive. Simpler than "keep best EV" and matches the stated intent.                                                                    |
| D3  | **Cloud SQL for Postgres** (not Firestore / BigQuery / AlloyDB).                                                                                                           | SQL fits analytical slice-and-dice queries; Drizzle already a dependency; f1-micro tier ≈ $9/mo → $300 credit lasts ~33 months.               |
| D4  | **Single table for value bets + aggregated fields** (`first_seen_at`, `last_seen_at`, `max_ev_pct`, `tick_count`). No separate `ticks` history table.                      | User directive: "only unique single market." Keeps schema simple. Can add a `value_bet_ticks` table later if time-series analysis is needed.  |
| D5  | **Separate `/backtest` route + API** — don't overload `/admin`.                                                                                                            | `/admin` is live state; `/backtest` is historical analysis. Different mental models.                                                          |
| D6  | **Drizzle + `pg` driver** (not `better-sqlite3`, not Prisma).                                                                                                              | `drizzle-orm` already installed; migrations are git-diffable; SQL-first. Postgres both in prod (Cloud SQL) and local dev (Docker).            |
| D7  | **Arb-code purge is Phase 7, not first.**                                                                                                                                  | DB + dashboard deliver user value immediately; arb cleanup is hygiene.                                                                        |
| D8  | **Manual outcome entry first** (Phase 6). Automated results adapter deferred.                                                                                              | Pragmatism — single-user admin tool, volume is low enough for manual.                                                                         |
| D9  | **EV threshold stays `MIN_EV_PCT = 2`** for detection (writes). Dashboard filters separately.                                                                              | Detection threshold is "what counts as a value bet worth logging." Dashboard threshold is "what's interesting right now." Different concerns. |

---

## § Open Questions

Surface these to the user at the start of the relevant phase. **Do not guess.**

| #   | Question                                                                                                                                                            | Needed by |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Q1  | GCP project name — create new or use existing?                                                                                                                      | Phase 1   |
| Q2  | Cloud SQL region — `asia-south1` (Mumbai, ~30–50ms to BD) or `asia-southeast1` (Singapore, ~60ms)?                                                                  | Phase 1   |
| Q3  | Cloud SQL tier — `db-f1-micro` (~$9/mo, 600MB RAM, fine for this workload) or `db-g1-small` (~$25/mo, 1.7GB)? Recommend f1-micro.                                   | Phase 1   |
| Q4  | Local dev DB — run Postgres in Docker, or connect to Cloud SQL via the Auth Proxy? Recommend Docker for speed.                                                      | Phase 2   |
| Q5  | Confirm dedup tie-breaker when two providers detect simultaneously on the same tick — which wins? Recommend: **first by provider ID alphabetical** (deterministic). | Phase 3   |
| Q6  | Dashboard row actions — just "mark outcome" + "send to AI," or also "re-fetch current odds" / "delete"?                                                             | Phase 4–6 |
| Q7  | Gemini prompt shape for analysis — free-form Q&A, or fixed-schema JSON output (profitability summary, patterns, recommendations)?                                   | Phase 5   |

---

## § Architecture Overview

```
┌────────────────────────────────────────────────────────────────────┐
│                    BACKGROUND SYNC (every 60s)                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ Fixtures → Matching → Odds fetch → detectAllValueBetsIncr()  │  │
│  └────────────────────────┬─────────────────────────────────────┘  │
│                           │                                        │
│                           ▼                                        │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │           NEW: value-bet persistence layer                   │  │
│  │  for each ValueBet in results:                               │  │
│  │    upsert into value_bets                                    │  │
│  │      WHERE (event_id, family_id, atom_id) unique             │  │
│  │      IF EXISTS: update last_seen_at, max_ev_pct, tick_count  │  │
│  │      IF NEW:    insert full row                              │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                           │                                        │
│                           ▼                                        │
└───────────────────── Cloud SQL Postgres ──────────────────────────┘
                            ▲
                            │
┌───────────────────────────┴────────────────────────────────────────┐
│                     NEW: /backtest route                           │
│  GET /api/backtest/value-bets?from=&to=&market=&provider=&minEv=   │
│  POST /api/backtest/analyze  → streams Gemini analysis             │
│  PATCH /api/backtest/value-bets/:id  → mark outcome (Phase 6)      │
└────────────────────────────────────────────────────────────────────┘
```

### File map — what gets added / modified

**New files:**

- `lib/db/client.ts` — Drizzle Postgres client singleton
- `lib/db/schema.ts` — table definitions
- `lib/db/migrations/` — migration SQL files (generated by `drizzle-kit`)
- `lib/db/repositories/value-bets.ts` — upsert / query logic
- `lib/ai/analyze-value-bets.ts` — Gemini wrapper for backtest analysis
- `app/backtest/page.tsx` — dashboard UI
- `app/backtest/layout.tsx` (if needed)
- `components/backtest/value-bets-table.tsx` — TanStack Table
- `components/backtest/filters-panel.tsx` — date range, market, provider, EV
- `components/backtest/ai-panel.tsx` — selection → analysis UI
- `app/api/backtest/value-bets/route.ts` — list endpoint
- `app/api/backtest/value-bets/[id]/route.ts` — update outcome (Phase 6)
- `app/api/backtest/analyze/route.ts` — Gemini analysis (streaming)
- `drizzle.config.ts` — at repo root
- `e2e/backtest.spec.ts` — Playwright tests

**Modified files:**

- `lib/background/fetcher.ts` — after `detectAllValueBetsIncremental`, call `persistValueBets`
- `package.json` — add `pg`, `@types/pg`, `drizzle-kit`; drop `better-sqlite3` in Phase 7
- `.env.example` — add `DATABASE_URL`, `GOOGLE_CLOUD_SQL_*` helpers
- `CLAUDE.md` — add Database section referencing this doc
- `docker-compose.yml` — add `postgres` service for local dev

---

## § Database Schema

Single table. All timestamps stored as `timestamptz`. Monetary values as `numeric(10,4)` to avoid float drift.

```sql
CREATE TABLE value_bets (
  -- Identity
  id                    text PRIMARY KEY,  -- "{event_id}|{family_id}|{atom_id}"
  event_id              text NOT NULL,
  family_id             text NOT NULL,
  atom_id               text NOT NULL,

  -- Event context (denormalized — events table is volatile, backtests need immutable snapshots)
  home_team             text NOT NULL,
  away_team             text NOT NULL,
  competition           text,
  event_start_time      timestamptz NOT NULL,
  match_confidence      numeric(4,3),      -- 0.850–1.000, from matcher

  -- Market context
  market_type           text NOT NULL,     -- e.g., "MATCH_RESULT"
  time_scope            text NOT NULL,     -- "FT" | "1H" | "2H"
  family_line           numeric(5,2),      -- e.g., 2.5 for O/U 2.5

  -- Sharp benchmark (Pinnacle)
  sharp_provider        text NOT NULL,     -- "pinnacle"
  sharp_odds            numeric(10,4) NOT NULL,
  sharp_true_prob       numeric(6,5) NOT NULL,  -- vig-removed, 0–1
  sharp_true_odds       numeric(10,4) NOT NULL, -- 1/true_prob
  sharp_odds_age_ms     integer,           -- freshness at detection

  -- Soft provider where value was found
  soft_provider         text NOT NULL,
  soft_odds_first       numeric(10,4) NOT NULL,
  soft_odds_last        numeric(10,4) NOT NULL,
  soft_odds_adjusted_first numeric(10,4) NOT NULL,  -- commission-adjusted
  soft_commission_pct   numeric(5,2) NOT NULL,

  -- Value metrics
  ev_pct_first          numeric(6,3) NOT NULL,
  ev_pct_last           numeric(6,3) NOT NULL,
  ev_pct_max            numeric(6,3) NOT NULL,
  kelly_fraction_first  numeric(7,5) NOT NULL,
  kelly_stake_first     numeric(10,4) NOT NULL,

  -- Temporal
  first_seen_at         timestamptz NOT NULL,
  last_seen_at          timestamptz NOT NULL,
  tick_count            integer NOT NULL DEFAULT 1,

  -- Closing line (populated by pre-event cron, future work)
  closing_sharp_odds    numeric(10,4),
  closing_soft_odds     numeric(10,4),
  closing_captured_at   timestamptz,

  -- Outcome (Phase 6)
  outcome               text,              -- 'pending' | 'won' | 'lost' | 'void' | 'push'
  outcome_marked_at     timestamptz,
  pnl                   numeric(10,4),     -- computed on outcome marking

  -- Bookkeeping
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX value_bets_first_seen_idx  ON value_bets (first_seen_at DESC);
CREATE INDEX value_bets_market_idx      ON value_bets (market_type, time_scope);
CREATE INDEX value_bets_soft_idx        ON value_bets (soft_provider);
CREATE INDEX value_bets_ev_idx          ON value_bets (ev_pct_max DESC);
CREATE INDEX value_bets_outcome_idx     ON value_bets (outcome) WHERE outcome IS NOT NULL;
CREATE INDEX value_bets_event_start_idx ON value_bets (event_start_time);
```

### Why these columns specifically

- **Denormalized event context**: backtests should not join to a volatile `events` table (which gets wiped/refetched). Each row is a self-contained snapshot.
- **`sharp_odds_age_ms` + `match_confidence`**: lets future analyses filter out noisy rows (see § Critical Analysis).
- **`first` / `last` / `max` triple** for soft odds and EV: captures odds drift without a time-series table. Sufficient per **D4**.
- **`closing_*` nullable**: reserved for CLV. Phase 3 does not populate these.
- **`outcome` nullable**: Phase 3 writes `'pending'`. Phase 6 adds marking UI.
- **`pnl`**: computed on outcome marking using `kelly_stake_first`. If `won`: `kelly_stake * (soft_odds_last - 1) * (1 - commission)`. If `lost`: `-kelly_stake`. `void` / `push`: 0.

### Drizzle schema sketch

```typescript
// lib/db/schema.ts
import {
  pgTable,
  text,
  numeric,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const valueBets = pgTable(
  "value_bets",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    familyId: text("family_id").notNull(),
    atomId: text("atom_id").notNull(),
    // ... (full mapping of SQL above)
  },
  (t) => ({
    firstSeenIdx: index("value_bets_first_seen_idx").on(t.firstSeenAt.desc()),
    marketIdx: index("value_bets_market_idx").on(t.marketType, t.timeScope),
    // ...
  }),
);

export type ValueBetRow = typeof valueBets.$inferSelect;
export type NewValueBetRow = typeof valueBets.$inferInsert;
```

---

## § Phase Plan (detailed)

Each phase is independently shippable. Build → runs → commit → next session.

---

### Phase 1 — Cloud SQL Postgres provisioning

**Goal:** a running Postgres instance reachable from the dev machine; connection string in `.env.local`.

**Prereqs:**

- GCP account with $300 credit (confirmed).
- `gcloud` CLI installed locally.
- User has answered **Q1, Q2, Q3** (project, region, tier).

**Steps:**

1. Create / select GCP project: `gcloud projects create <project-id>` (or `gcloud config set project <existing>`).
2. Enable Cloud SQL Admin API: `gcloud services enable sqladmin.googleapis.com`.
3. Create instance:
   ```bash
   gcloud sql instances create nahidarbx-db \
     --database-version=POSTGRES_16 \
     --tier=db-f1-micro \
     --region=asia-south1 \
     --root-password=<strong-password> \
     --storage-size=10GB \
     --storage-auto-increase \
     --backup-start-time=03:00
   ```
4. Create database: `gcloud sql databases create nahidarbx --instance=nahidarbx-db`.
5. Create app user: `gcloud sql users create nahidarbx_app --instance=nahidarbx-db --password=<app-password>`.
6. Download & run **Cloud SQL Auth Proxy** for local dev (avoids opening public IP):
   ```bash
   ./cloud-sql-proxy --port 5432 <project>:asia-south1:nahidarbx-db
   ```
7. Add to `.env.local`:
   ```
   DATABASE_URL=postgresql://nahidarbx_app:<password>@127.0.0.1:5432/nahidarbx
   ```
8. Test connection with `psql "$DATABASE_URL" -c "SELECT version();"`.

**Acceptance criteria:**

- [ ] `psql` connects successfully via the Auth Proxy.
- [ ] `DATABASE_URL` in `.env.local` (and `.env.example` has a dummy placeholder — never commit real creds).
- [ ] A `README-DB.md` (or appended section in `CLAUDE.md`) documenting how to start the Auth Proxy locally.

**Do not in this phase:**

- Any app-code changes beyond env vars.
- Schema creation (Phase 2 handles migrations).

**Rollback:** `gcloud sql instances delete nahidarbx-db`.

**Commit message:** `chore(db): provision Cloud SQL Postgres instance for backtesting`

---

### Phase 2 — Drizzle schema + migration infrastructure

**Goal:** `drizzle-kit generate` produces a migration that matches **§ Database Schema**, and it runs cleanly against the DB from Phase 1.

**Steps:**

1. Install runtime + dev deps:
   ```bash
   npm i pg
   npm i -D @types/pg drizzle-kit
   ```
2. Create [drizzle.config.ts](drizzle.config.ts) at repo root:
   ```typescript
   import type { Config } from "drizzle-kit";
   export default {
     schema: "./lib/db/schema.ts",
     out: "./lib/db/migrations",
     dialect: "postgresql",
     dbCredentials: { url: process.env.DATABASE_URL! },
   } satisfies Config;
   ```
3. Create [lib/db/schema.ts](lib/db/schema.ts) with the `valueBets` table (full mapping of SQL in § Database Schema).
4. Create [lib/db/client.ts](lib/db/client.ts):
   ```typescript
   import { drizzle } from "drizzle-orm/node-postgres";
   import { Pool } from "pg";
   const pool = new Pool({ connectionString: process.env.DATABASE_URL });
   export const db = drizzle(pool, { schema });
   ```
5. Add npm scripts to [package.json](package.json):
   ```json
   "db:generate": "drizzle-kit generate",
   "db:migrate": "drizzle-kit migrate",
   "db:studio": "drizzle-kit studio"
   ```
6. Optionally: add a `postgres` service to [docker-compose.yml](docker-compose.yml) for local dev (answer to **Q4**).
7. Run `npm run db:generate` → commit the generated SQL in `lib/db/migrations/`.
8. Run `npm run db:migrate` against the Cloud SQL proxy.
9. Verify with `psql` or `npm run db:studio`.

**Acceptance criteria:**

- [ ] `npm run db:generate` produces a clean migration matching § Database Schema.
- [ ] `npm run db:migrate` applies cleanly against Cloud SQL.
- [ ] Table + all indexes visible via `\d+ value_bets` in psql.
- [ ] `npm run build` passes (no type errors from schema imports).

**Do not in this phase:**

- Wire up writes to the DB from the pipeline (Phase 3).
- Build UI (Phase 4).

**Rollback:** drop the table manually or revert the migration file.

**Commit message:** `feat(db): add Drizzle schema + initial migration for value_bets`

---

### Phase 3 — Persistence wiring (detection → DB upsert)

**Goal:** every sync cycle, new value bets are inserted; repeat detections update aggregate fields. Backfill: skipped — history starts from deployment.

**Steps:**

1. Create [lib/db/repositories/value-bets.ts](lib/db/repositories/value-bets.ts) with:
   - `upsertValueBet(vb: ValueBet, eventMeta: EventMeta): Promise<void>` — implements **D2** dedup rule.
   - `listValueBets(filters: BacktestFilters): Promise<ValueBetRow[]>` — used by Phase 4 API.
   - `markOutcome(id, outcome)` — stub for Phase 6.

2. Upsert logic (pseudocode):

   ```typescript
   const id = `${vb.eventId}|${vb.familyId}|${vb.atomId}`;
   await db
     .insert(valueBets)
     .values({ id, ...firstSeenPayload(vb, eventMeta) })
     .onConflictDoUpdate({
       target: valueBets.id,
       set: {
         // Only update these on subsequent detections
         lastSeenAt: new Date(),
         softOddsLast: vb.softOdds,
         evPctLast: vb.evPct,
         evPctMax: sql`GREATEST(${valueBets.evPctMax}, ${vb.evPct})`,
         tickCount: sql`${valueBets.tickCount} + 1`,
         updatedAt: new Date(),
         // soft_provider is NOT updated — D2: first provider wins
       },
     });
   ```

   Note: the `ON CONFLICT` clause implicitly honours **D2** — if a row already exists for `(event, family, atom)`, we update it but never change `soft_provider`. If a new detection uses a different provider, it's a no-op against `soft_provider` and the first provider wins.

3. Hook into [lib/background/fetcher.ts](lib/background/fetcher.ts): after `detectAllValueBetsIncremental` returns, iterate and upsert. Wrap in try/catch — DB failure must not crash the sync. Log failures.

4. Build the `eventMeta` payload from the events store (match confidence, teams, competition, start time).

5. Add a small **unit test** for `upsertValueBet` using `pg-mem` or a throwaway DB: insert twice, assert `tick_count = 2`, `first_seen_at` unchanged, `last_seen_at` advanced.

**Acceptance criteria:**

- [ ] Start `npm run dev`, wait for one sync cycle, verify rows appear in `value_bets`.
- [ ] Wait for a second cycle — verify `tick_count` increments on existing rows.
- [ ] Simulate a DB outage (stop proxy) — the sync pipeline continues to run and logs the error.
- [ ] New detections by a **different soft_provider** on an existing `(event, family, atom)` do not overwrite `soft_provider`.
- [ ] `npm run build` + `npm test` pass.

**Edge cases to handle:**

- Event start time missing → skip row, log warning.
- `sharp_odds_age_ms` unavailable → write `null`.
- Match confidence unavailable → write `null`.

**Commit message:** `feat(db): persist detected value bets with dedup-on-atom`

---

### Phase 4 — `/backtest` dashboard (read-only, filters, table)

**Goal:** user can browse every stored value bet, filter by date / market / provider / EV, and page through results.

**Steps:**

1. **API** — [app/api/backtest/value-bets/route.ts](app/api/backtest/value-bets/route.ts):
   - Accepts query params: `from`, `to` (ISO dates), `marketType`, `timeScope`, `softProvider`, `minEv`, `maxEv`, `outcome`, `limit`, `offset`.
   - Returns paginated rows + total count.
   - Auth: reuse existing admin middleware.

2. **Route** — [app/backtest/page.tsx](app/backtest/page.tsx) with server-side auth guard.

3. **Components**:
   - [components/backtest/filters-panel.tsx](components/backtest/filters-panel.tsx) — shadcn Select, DateRangePicker, Input for EV range.
   - [components/backtest/value-bets-table.tsx](components/backtest/value-bets-table.tsx) — TanStack Table (already installed via `@tanstack/react-table`). Columns: event, market, atom, soft provider, odds, EV%, first seen, duration, tick count, outcome.
   - Use TanStack Query (already installed) for fetching + pagination.
   - Selection checkbox column (rows get sent to AI in Phase 5).

4. **Navigation** — add `/backtest` link in the admin nav.

5. **E2E test** — [e2e/backtest.spec.ts](e2e/backtest.spec.ts): login → navigate → filters apply → rows render → pagination works.

**Acceptance criteria:**

- [ ] `/backtest` loads, shows table with rows from Phase 3.
- [ ] All filters change the result set correctly.
- [ ] Pagination works (>100 rows).
- [ ] Columns sortable by `first_seen_at`, `ev_pct_max`, `tick_count`.
- [ ] E2E test passes.
- [ ] `npm run build` clean.

**Do not in this phase:**

- AI analysis (Phase 5).
- Outcome marking (Phase 6) — leave the column, read-only display.

**Commit message:** `feat(backtest): read-only dashboard with filters and pagination`

---

### Phase 5 — AI analysis of selected bets

**Goal:** user selects N rows, clicks "Analyze," and Gemini returns a qualitative summary.

**Steps:**

1. Need to answer **Q7** first — fixed-schema vs. free-form. Default proposal: **fixed-schema JSON**:

   ```json
   {
     "summary": "string",
     "hypothetical_pnl_units": 12.4,
     "win_rate_inferred": null,
     "patterns": ["string"],
     "concerns": ["string"],
     "recommendations": ["string"]
   }
   ```

   (P&L is "hypothetical" in Phase 5 because no outcomes yet.)

2. Create [lib/ai/analyze-value-bets.ts](lib/ai/analyze-value-bets.ts): wraps `@google/genai` with `Type.OBJECT` schema (see existing [lib/ai/gemini.ts](lib/ai/gemini.ts) for pattern). Use `gemini-2.5-flash` for default; let UI offer "deep" (Pro) toggle.

3. Create [app/api/backtest/analyze/route.ts](app/api/backtest/analyze/route.ts): POST body `{ ids: string[], model?: "flash"|"pro" }`, streams or returns analysis. Guard the max selection size (e.g., 200 bets) — over that, reject with a clear error.

4. UI — [components/backtest/ai-panel.tsx](components/backtest/ai-panel.tsx):
   - "Analyze selected (N)" button.
   - Results panel with sections from the JSON schema.
   - Loading skeleton while waiting.

5. Cost guard: log token counts per call so we can notice runaway usage.

**Acceptance criteria:**

- [ ] Select ~20 rows, click Analyze, get back structured analysis within ~10s.
- [ ] Bad input (no selection, or >200 rows) returns a clear 400.
- [ ] No `GEMINI_API_KEY` → endpoint returns a specific error, not a 500.

**Commit message:** `feat(backtest): Gemini analysis of selected value bets`

---

### Phase 6 — Outcome tracking (manual) + P&L

**Goal:** user can mark `won / half_won / lost / half_lost / void` per row; P&L computed; dashboard shows realized performance. (`"push"` is accepted as a legacy alias and collapsed to `"void"`.)

**Steps:**

1. API — [app/api/backtest/value-bets/[id]/route.ts](app/api/backtest/value-bets/[id]/route.ts) PATCH: `{ outcome: "won"|"half_won"|"lost"|"half_lost"|"void" }` (also accepts `"push"` → `"void"` for back-compat).
2. Server computes `pnl` on marking:
   ```typescript
   if (outcome === "won") {
     pnl =
       kelly_stake_first *
       (soft_odds_last - 1) *
       (1 - soft_commission_pct / 100);
   } else if (outcome === "lost") {
     pnl = -kelly_stake_first;
   } else {
     pnl = 0;
   }
   ```
3. UI — row action menu (shadcn DropdownMenu) with outcome options. Toast on success.
4. Dashboard summary strip: total bets, settled bets, win rate, total P&L (in units), ROI%.
5. Filter: "Show only settled" / "Show only pending."
6. Update AI prompt in Phase 5 module to include actual outcomes when analyzing settled bets.

**Acceptance criteria:**

- [ ] Mark 10 bets, dashboard shows accurate aggregate P&L.
- [ ] Re-marking a bet re-computes P&L correctly.
- [ ] AI analysis now uses real `pnl` instead of hypothetical.

**Commit message:** `feat(backtest): manual outcome marking + realized P&L`

---

### Phase 7 — Arbitrage code purge

**Goal:** zero references to arbitrage in production code. Docs can keep historical notes.

**Steps:**

1. Search for all remaining references (as of 2026-04 — baseline found 26 files):
   ```bash
   # Already-known hot spots:
   lib/atoms/types.ts               # AtomArbitrage, AtomStake types
   lib/atoms/registry.ts            # getArbitrageableFamilies, is_arbitrageable
   lib/atoms/index.ts               # comments
   lib/atoms/atoms.json             # is_arbitrageable flags
   lib/atoms/store.ts               # comments + any arb-specific code paths
   lib/shared/constants.ts          # MIN_PROFIT_PCT, DEFAULT_TOTAL_STAKE, MAX_REALISTIC_PROFIT
   lib/background/fetcher.ts        # comments
   lib/formatting/spreadsheet.ts    # arbitrage references in interfaces
   lib/branding.ts                  # tagline
   ```
2. Remove types, flags, functions, dead imports. Update `CLAUDE.md`, `ARCHITECTURE.md`, `IMPROVEMENTS.md`, `.claude/commands/arb-check.md`.
3. `atoms.json`: keep the schema but remove `is_arbitrageable` field — update [lib/atoms/registry.ts](lib/atoms/registry.ts) to not read it.
4. Update branding tagline from "arbitrage finder" → "value betting finder" in [lib/branding.ts](lib/branding.ts).
5. Run `npm run build` + full E2E suite.

**Acceptance criteria:**

- [ ] `grep -r "arbitrage\|Arbitrage\|AtomArbitrage" lib/ app/ components/` returns zero (or only deliberate historical references in docs).
- [ ] `npm run build` clean.
- [ ] `npm test` clean.
- [ ] `/admin` and `/backtest` still render correctly.

**Commit message:** `refactor: purge arbitrage types and helpers (superseded by value-bet pipeline)`

---

## § Future phases (not planned in detail)

- **P8. Automated results fetching** — adapter to pull event outcomes from a results API or Pinnacle settled markets. Populates `outcome` automatically.
- **P9. Closing-line snapshots** — cron runs ~5 min before kickoff, captures current Pinnacle + soft odds into `closing_*` columns. Enables CLV analysis.
- **P10. `value_bet_ticks` time-series table** — if aggregate `first/last/max` isn't enough for steam-move analysis, add a child table. Requires a retention policy.
- **P11. Export to BigQuery** — nightly pg_dump → BQ for heavy analytical queries, if the dataset outgrows Cloud SQL.

---

## § Working rules for new chat sessions

1. **Always read § Current Status first** and confirm the phase before coding.
2. **Re-read § Decisions Log** to avoid relitigating settled choices.
3. **Check § Open Questions** — surface any unanswered ones _before_ starting a phase.
4. **Follow per-phase Acceptance criteria as the definition of done.** Do not expand scope.
5. **After completing a phase:**
   - Update § Current Status checkbox.
   - Move any newly-settled issues from § Open Questions → § Decisions Log.
   - Commit with the suggested commit message.
6. **If the codebase has drifted** (new files, refactors) since this doc was written, update the File map section before starting.
7. **This doc takes precedence** over anything you remember from prior conversations — if there's a conflict, trust the doc.

---

_Doc version: 1.0 · Last updated: 2026-04-18_
