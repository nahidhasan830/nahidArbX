# Agent Instruction

Single source of truth for all AI coding agents working in this repository. This file is **versioned on purpose**: NahidArbX was built end-to-end with agent pair-programming under these constraints. Root `AGENTS.md` is the standard entry point and symlinks here; `CLAUDE.md` is a Claude Code compatibility symlink to `AGENTS.md`.

The canonical project skills live in `.central-agent-config/skills`. Agent-specific `skills` folders symlink to that directory.

Project-scoped MCP config lives in `.central-agent-config/mcp`. Agent-specific MCP config files and folders must only symlink or refer to that directory; do not add global MCP servers for this project.

**How agents are expected to work here:** read this contract first, implement under the architecture and safety rules below, prefer generalized fixes over one-off hacks, run `npm run build` and `npm run lint` after material changes, and clean dead code as part of the same work. Human direction owns product choices and risk non-negotiables (especially settlement: source-only, never auto-apply LLM outcomes).

## Solo-developer workflow

No branches. Everything lands on the working branch (treat as `master`). Commit everything relevant in as few commits as the work warrants — don't fragment across branches or separate agent vs user changes.

## Runtime

Dual-process on **localhost** (`nahidarbx.store` is inactive). Bangladesh IP required for NineWickets/Velki providers.

| Component         | Where                                                        | Notes                                                                          |
| ----------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Engine            | `npm run engine` (tsx)                                       | Owns background subsystems and Engine HTTP API on `ENGINE_PORT` (default 3001) |
| Next.js           | `http://localhost:3000`                                      | `npm run dev` — web UI plus thin API proxy/client endpoints                    |
| Optimizer sidecar | Cloud Run **Job** `nahidarbx-optimizer-job`                  | ML training sidecar (LightGBM). Project `nahidarbx-6e73`, region `asia-south1` |
| Database          | Cloud SQL Postgres `nahidarbx-6e73:asia-south1:nahidarbx-db` | App DB via Postgres/Drizzle and Cloud SQL Connector                            |

## Commands

```bash
npm run engine       # Start background engine (tsx engine.ts)
npm run dev          # Start Next.js web process (Turbopack)
npm run dev:all      # Start both in one terminal
npm run engine:stop  # Stop engine gracefully
npm run kill         # Stop local dev servers on ports 3000, 3001, and 8090
npm run build        # Production build — always run after changes
npm run lint         # ESLint
npm run test:unit    # Node built-in runner: node --import tsx --test lib/**/*.test.ts
npx vitest run       # Vitest: tests/unit/
npm run test:settle  # Node runner: lib/settle/*.test.ts only
npm run db:generate  # Drizzle codegen
npm run db:migrate   # Drizzle migrations
```

Two separate test systems: Vitest (`tests/unit/`) and Node built-in runner (`lib/**/*.test.ts`). UI verification is manual. For frontend data issues, call the same API endpoints the client uses with curl/scripts first; browser automation test suites are not part of this repo.

## Architecture

NahidArbX is a real-time value-bet finder. Compares soft-book prices (NineWickets Exchange/Sportsbook, Velki, SABA, BetConstruct when enabled) against Pinnacle (sharp) and flags positive-EV opportunities. Detected bets persist to Postgres for review + settlement on `/bets`.

**Dual-process architecture:** `engine.ts` runs all background subsystems (sync, WebSockets, detection, auto-place, auto-settle, Telegram, log retention) and exposes the Engine HTTP API. Next.js (`npm run dev`) is the web UI plus thin API proxy/client endpoints. `instrumentation.ts` initializes the DB for the web process and handles boot notification coordination; it must not start background subsystems.

**DB initialization:** `ensureDbReady()` in `lib/db/client.ts` creates the Pool asynchronously via Cloud SQL Connector. Called by `instrumentation.ts` (Next.js) and `engine.ts` (standalone) before any DB access. The `db` export is a transparent Proxy that forwards to the initialized Drizzle instance.

**4-phase pipeline:** Fixtures → Matching → Markets (atoms) → Value-bet detection. Event-driven reactive detection (500ms debounce).

**Key terms:** `Family` = market with mutually exclusive outcomes (e.g. 1X2). `Atom` = single outcome (e.g. Home Win). Bet IDs are deterministic: `${eventId}|${familyId}|${atomId}`.

## Routes

| Route                    | Purpose                                                                          |
| ------------------------ | -------------------------------------------------------------------------------- |
| `/dashboard`             | Central betting-account dashboard                                                |
| `/value-bets`            | Value-bet / arb finder                                                           |
| `/bets`                  | Bets history — settlement + review                                               |
| `/matcher-lab`           | Event matcher runs, candidates, decisions, and scheduler controls                |
| `/lab/ml`                | ML Optimizer — LightGBM pipeline dashboard with current-contract corpus progress |
| `/ai-engine`             | AI provider health and configuration                                             |
| `/ai-playground`         | Manual AI/search playground                                                      |
| `/logs/auto-placer`      | Auto-placement log                                                               |
| `/logs/ai-activity`      | AI activity log                                                                  |
| `/logs/memory`           | Memory diagnostics                                                               |
| `/telegram`              | Telegram bot/control status                                                      |
| `/api/value-bets`        | GET: arb data, POST: engine manual sync proxy                                    |
| `/api/value-bets/stream` | Server-sent event proxy for engine value-bet updates                             |
| `/api/ml/pipeline`       | GET: ML pipeline stats plus current-contract corpus counters                     |
| `/api/ml/learning`       | GET/POST: ML learning observatory                                                |
| `/api/ml/retrain`        | POST: trigger Cloud Run training job                                             |
| `/api/matcher-lab/*`     | Matcher lab reads, jobs, run stream, scheduler, and stats                        |

## Critical Rules

### Architecture & data

- **`engine.ts`** is the standalone background process. **`instrumentation.ts`** is the Next.js boot hook — it initializes DB state for the web process and must not start background tasks.
- **`bets` is the only settlement table.** `value_bets` and `placed_bets` are dropped legacy.
- **Settlement pipeline is shared.** All paths converge on `settleBatch` / `applySettlementOutcomes`.
- **`singleton()` from `lib/util/singleton.ts`** for HMR-safe state. Module-level `let` breaks under Turbopack.
- **No code comments.** When writing code, do not add comments of any kind. Preserve only syntax-required directives such as `"use client"`, `"use server"`, shebangs, and tool-mandated pragmas that cannot be replaced with code.
- **`better-sqlite3` is auth-only.** App DB is Postgres via Drizzle (`snake_case` casing).
- **`lib/shared/constants.ts`** is the single source for magic numbers (not `lib/config.ts`).
- **Single `.env` file** at repo root. No `.env.local` or `.env.example`.
- **Middleware uses `jose`** (Edge Runtime), not `jsonwebtoken`.
- **All external data validated with Zod.**
- **Current-contract corpus accounting lives in `lib/ml/training-sample-accounting.ts`.** `/api/ml/pipeline`, `/api/ml/retrain`, optimizer scheduler code, and `/lab/ml` must reuse that shared source and keep raw settled/current-contract/win/loss progress separate from stricter trainer-readiness counts.
- **ML runtime must stay Google Cloud managed.** Do not add local inference, Hugging Face runtime/fallbacks, or Hugging Face token/config paths. When changing ML, entity matching, embeddings, or scoring, prefer managed Google Cloud inference and remove local/Hugging Face runtime paths where the change scope allows.

### Settlement

- **No automated settlement AI.** Settlement uses source-only tiers: cache → ESPN → SofaScore → API-Football. Unresolved rows stay pending for manual review.
- **Manual Google AI Mode is only a human verification link.** It must not feed backend settlement or auto-apply outcomes.
- **Manual re-settle bypasses cache.** Operator-triggered `/api/bets-history/settle` calls default to `bypassCache: true`; the automatic scheduler calls `settleBatch` directly and keeps Tier 0 enabled.
- **Prefer deterministic settlement.** `settleBet(row, score)` handles 80%+ of markets with zero AI.
- **Telegram notifications only for placed bets** — if `placedAt` is null, settle silently.
- **Auto-place stakes snap to 100 BDT multiples** (`AUTO_PLACE_STAKE_BUCKET`), min 200 BDT.
- **Prefilled AI prompts** are the preferred pattern for settlement discovery — generate a pre-built prompt for manual copy-paste rather than automated settlement AI calls.

### UI rules

- **Styling is Tailwind only — no custom CSS.** Every style as Tailwind utilities. If a combo repeats, extract a React component, not a CSS class. `globals.css` is reserved for: Tailwind imports, `@theme inline` tokens, `:root`/`.dark` variables, `@layer base` border reset, Sonner overrides, scrollbar styling. No component-scoped classes, no app-specific keyframes, no utility helpers.
- **Every table uses `<DataTable>`** (`components/ui/data-table.tsx`). Virtualization, sorting, resize, drag-reorder, persistence, infinite scroll, grouping, selection — all opt-in. Don't write plain `<table>`. Always pass `getRowId` for polled queries. Only exception: `ValueBetSpreadsheet.tsx` (positional layout).
- **Toolbar/filter components are reused** across spreadsheet surfaces. Standard: `h-7` / `px-3 py-1.5` / `bg-muted/40` / `text-[11px]` buttons.
- **Typography tiers:** **Prose** (sentences to read — tooltips, descriptions, help text) → `text-sm` (14px min). **Chrome** (labels to scan — buttons, badges, table cells) → `text-[11px]`/`text-xs`. Never put full sentences at `text-[11px]`.
- **Tooltips are foundational.** Use `<Tooltip>`/`<TooltipTrigger>`/`<TooltipContent>` from `components/ui/tooltip.tsx` — never plain `title=""`. Wrap panel root in `<TooltipProvider delayDuration={200}>`. State-aware tooltips must reflect current state. AI-triggering controls must say "AI calls cost money."
- **Explanatory copy: plain language + one example.** Headline (plain English, no acronyms) + body (explanation woven with concrete betting example using real providers/markets/numbers). No "Why this matters" labels. Use `components/lab/HelpBanner.tsx` and `lib/lab/param-labels.ts` as the reference pattern. See vocabulary cheatsheet below.

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
- **Post-change: always run `npm run build` + `npm run lint`**.
- **Always clean dead code and artifacts** (unused scripts, stale imports, temp files) after completing a task.

## Entity Resolution

Postgres-backed alias system replacing legacy JSON files. Core tables: `entities`, `entity_names`, `name_observations`, `entity_decision_blocklist`.

**Lookup:** `(provider, surface_normalized, competition_id)` UNIQUE — tournament-scoped. **Ingress:** all writers call `recordObservation` in `lib/matching/entities/observations.ts`.

**Auto-resolver** (`lib/matching/entities/auto-resolve.ts`, triggered by observations):

- **Gates** — reject retired entities, gender mismatch, and team-variant mismatch (U17/U19/U20/U21/U23/Reserves/Academy/Futsal/etc.)
- **Blocklist** — respect recent operator overrides before auto-confirming
- **Bayesian evidence** — promote high-weight repeated observations
- **Bi-encoder** — Vertex embedding cosine for surface/entity similarity
- **Cross-encoder** — optional calibrated scorer when available
- **Escalation** — unresolved candidates stay for operator review

**Event Matcher Lab:** `/matcher-lab` reads the Node event matcher tables (`event_matcher_runs`, `matcher_candidates`, `matcher_decisions`, `matcher_impact_daily`). The old Python-backed `match_pairs`/`matcher_config`/`matcher_runs` lab tables are dropped.

**UI:** `Matcher Lab` is run-centric and table-first; every decision review table uses `<DataTable>`.

**Env vars:** Vertex-backed embedding paths use `GCP_PROJECT_ID`, `GCP_REGION`, and `VERTEX_EMBEDDING_MODEL`.

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
score = 0.7 * orientationAwareTeamSimilarity + 0.3 * competitionSimilarity
match if same kickoff bucket, normal orientation, passes competition gate, and score >= MATCH_THRESHOLD
```

Competition names normalized (country adjectives → nouns).

## File Structure

| Path                               | Purpose                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `engine.ts`                        | Standalone background engine entry point                                   |
| `instrumentation.ts`               | Next.js boot hook — web-process DB init and boot notification coordination |
| `lib/shared/engine-http.ts`        | Engine HTTP API                                                            |
| `lib/engine-proxy.ts`              | Next.js API proxy client for engine endpoints                              |
| `lib/db/client.ts`                 | Async DB pool init (`ensureDbReady()`) + Proxy `db` export                 |
| `lib/db/schema.ts`                 | Postgres schema                                                            |
| `lib/db/repositories/`             | Database access boundaries                                                 |
| `lib/providers/registry.ts`        | Single source of truth for provider metadata                               |
| `lib/adapters/unified-registry.ts` | Event and atoms adapter registry                                           |
| `lib/adapters/*.ts`                | Provider fixture/event adapters                                            |
| `lib/atoms/`                       | Family/atom types, mappings, odds store, fetcher, value detector           |
| `lib/betting/`                     | Placement/account/session adapters                                         |
| `lib/settle/`                      | Shared settlement pipeline and score sources                               |
| `lib/event-matcher/`               | Matcher Lab run pipeline, candidates, scoring, jobs, and repository        |
| `lib/matching/entities/`           | Entity observation, alias, resolver, and embedding logic                   |
| `lib/ml/`                          | Feature contract, scorer, training accounting, learning, and audit logic   |
| `services/optimizer/`              | Cloud Run LightGBM training sidecar                                        |
| `lib/shared/cloudflare-bridge.ts`  | Shared CF-solve + in-page-fetch pipeline                                   |
| `lib/background/fetcher.ts`        | Sync scheduler                                                             |

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
    homeTeam: string,
    awayTeam: string,
    options?: AtomsFetchOptions,
  ): Promise<number>;
}
```

## Environment Variables

- **Core:** `DATABASE_URL`, `JWT_SECRET`, `ENGINE_PORT`, `FETCH_INTERVAL_MS`
- **Pinnacle via Betjili:** `BETJILI_USERNAME`, `BETJILI_PASSWORD`, `BETJILI_URL`, `TOKEN_HEADLESS`, `PINNACLE_DAYS_AHEAD`, `PINNACLE_PAGE_SIZE`
- **Soft-book sessions:** `NINEWICKETS_USERNAME`, `NINEWICKETS_PASSWORD`, `VELKI_USERNAME`, `VELKI_PASSWORD`, `FANCYWIN_USERNAME`/`SABA_USERNAME`, `FANCYWIN_PASSWORD`/`SABA_PASSWORD`
- **AI/search:** `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, `DEEPSEEK_PRO_MODEL`, `GEMINI_API_KEY`, `GEMINI_FLASH_MODEL`, `GEMINI_PRO_MODEL`, `GEMINI_LITE_MODEL`, `VERTEX_ENGINE_ID`
- **Google Cloud / ML:** `GCP_PROJECT_ID`, `GCP_REGION`, `OPTIMIZER_JOB_NAME`, `VERTEX_MODEL_BUCKET`/`ML_MODEL_BUCKET`, `VERTEX_SERVING_IMAGE`, `VERTEX_PREDICTION_ENDPOINT`, `VERTEX_EMBEDDING_MODEL`
- **Settlement:** `API_FOOTBALL_KEY`, `SCRAPE_DO_TOKEN`
- **Telegram:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_FULL_COMMAND_MENU`

## Database

Cloud SQL Postgres 16 — project `nahidarbx-6e73`, instance `nahidarbx-db` (db-f1-micro), database `nahidarbx`, user `nahidarbx_app`. Connection via `@google-cloud/cloud-sql-connector` (async init in `lib/db/client.ts`). No local cloud-sql-proxy needed.

## Cloudflare Bridge (Shared Auth Pipeline)

Pinnacle (`lib/auth/token-manager.ts`), 9W Sportsbook (`lib/betting/ninewickets/session.ts`), SABA (`lib/betting/saba/session.ts`), and Velki (`lib/betting/velki/session.ts`) use the shared `lib/shared/cloudflare-bridge.ts` pipeline where applicable: Playwright solves CF challenge, then `page.evaluate(fetch())` runs login/get-game-url flows with retry/backoff and browser disposal on failure. Session files live in `sessions/` (gitignored): `betjili/pinnacle-token.json`, `9wkts/session.json`, `saba/session.json`, and `velki/session.json`.
