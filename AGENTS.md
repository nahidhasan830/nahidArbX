# AGENTS.md

Terse index for agents. [`CLAUDE.md`](CLAUDE.md) is the full reference — keep both in sync in the same commit.

## Build & Test

- `npm run build` — production build (always run after changes)
- `npm run lint` — ESLint
- `npm run test:unit` — Node built-in runner (`lib/**/*.test.ts`, NOT vitest)
- `npx vitest run` — Vitest (`tests/unit/`)
- `npm run test:settle` — Node runner for `lib/settle/*.test.ts`
- `npm run db:generate` then `npm run db:migrate` — Drizzle (snake_case casing)
- UI verification is manual. For frontend data issues, call the same API endpoints the client uses with curl/scripts first; browser automation test suites are not part of this repo.

## Architecture & Data

- **Dual-process:** `engine.ts` (background) + Next.js (web-only). `NAHIDARBX_ENGINE=1` env var. Engine runs 13 subsystems; Next.js is read-only UI.
- **Dev workflow:** `npm run engine` → `npm run dev`. Or `npm run dev:all`. Stop: `npm run engine:stop` / `npm run kill`.
- **DB init is async** — `ensureDbReady()` in `lib/db/client.ts`. Called by `instrumentation.ts` (Next.js) and `engine.ts` before any DB access. Uses Cloud SQL Connector when `CLOUD_SQL_INSTANCE` is set.
- **`singleton()`** (`lib/util/singleton.ts`) for HMR-safe state. Module-level `let` breaks under Turbopack.
- **`bets` is the only settlement table.** `value_bets`/`placed_bets` are dropped legacy.
- **Settlement pipeline is shared** — auto/manual/re-settle all use `settleBatch`/`applySettlementOutcomes`.
- **Current-contract corpus accounting is shared** — `lib/ml/training-sample-accounting.ts` feeds `/api/ml/pipeline`, `/api/ml/training-data`, and `/lab/ml`. Keep raw settled/current-contract/win/loss collection counts separate from trainer-readiness counts.
- **Bet IDs are deterministic:** `${eventId}|${familyId}|${atomId}` (not UUIDs).
- **`better-sqlite3` is auth-only.** App DB is Postgres via Drizzle (snake_case casing).
- **`lib/shared/constants.ts`** = single source for magic numbers (not `lib/config.ts`).
- **Single `.env` file** at repo root. No `.env.local`/`.env.example`.
- **Middleware uses `jose`** (Edge Runtime), not `jsonwebtoken`.

## Settlement

- **No automated settlement AI.** Settlement uses source-only tiers: cache → ESPN/API-Football/SofaScore. Unresolved rows stay pending for manual review.
- **Manual Google AI Mode is only a human verification link.** It must not feed backend settlement or auto-apply outcomes.
- **Manual re-settle bypasses cache.** `/api/bets-history/settle` defaults to `bypassCache: true`; the automatic scheduler calls `settleBatch` directly and keeps Tier 0 enabled.
- **Telegram notifications only for placed bets** — null `placedAt` → settle silently.
- **Auto-place stakes:** multiples of 100 BDT (`AUTO_PLACE_STAKE_BUCKET`), min 200 BDT.

## UI Rules

- **Tailwind only — no custom CSS.** Extract React components, not CSS classes. See CLAUDE.md §Styling.
- **Every table uses `<DataTable>`** (`components/ui/data-table.tsx`). Pass `getRowId` for polled queries. Exception: `ValueBetSpreadsheet.tsx`.
- **Typography:** Prose → `text-sm` (14px min). Chrome → `text-[11px]`/`text-xs`. Never full sentences at `text-[11px]`.
- **Tooltips on every control.** `<Tooltip>`/`<TooltipTrigger>`/`<TooltipContent>` — never plain `title=""`. `TooltipTrigger` should be `asChild` wrapping a real interactive element (`<button>`, `<span>`, etc.) — never a raw text node.
- **Sections over cards.** For density > 7 surfaces (operational dashboards, monitor pages), prefer `<section className="rounded-md border border-border bg-card p-3 shadow-sm">` with a `SectionHeader` (icon square + title + description) over shadcn `<Card>` primitives. Tiles are flat `rounded-md border border-border bg-background p-3` blocks, not cards.
- **Tone-coded outline badges.** Status pills use the `border-…/30 bg-…/10 text-…-700 dark:text-…-300` pattern (emerald / amber / rose / cyan). Never `<Badge variant="destructive">` / `variant="success">` for in-page status.
- **Numbers:** `font-mono … tabular-nums`. Big values → `text-2xl font-semibold` (never `font-bold`). Inline → `text-xs font-semibold`.
- **Custom progress bar.** Two-div bar inside `h-1.5 overflow-hidden rounded-sm bg-muted` — do not use the shadcn `<Progress>` primitive in operational dashboards.
- **Polled pages pattern.** Page wraps `AppShell` in a page-level `TooltipProvider` and wires `titleBadge` (live stat pills) + `actions` (auto-refresh indicator + Refresh button) into the shell. Skeleton is a dedicated `*PageSkeleton.tsx` component, not inline. Error state is a centered `border-rose-500/30 bg-rose-500/10` backdrop-blur block, not a `Card`. See `/lab/ml` and `/logs/memory` for the canonical wiring.

## Workflow & Infrastructure

- **ML rebuild source of truth:** `ML_REBUILD_PLAN.md`.

- **Solo-developer — no branches.** Few commits, no branch politics.
- **Dev machine:** MacBook Pro 14″ (Nov 2024), Apple M4 Pro, 24 GB unified memory. Supports local Gemma 4 26B (MoE) via Ollama.
- **Runtime is localhost.** Engine + Next.js locally. Cloud SQL Postgres via Cloud SQL Connector.
- **Bangladesh geo-restriction.** NineWickets/Velki require Bangladesh IP. Engine MUST run from Bangladesh network.
- **Cloud Run: Jobs for batch work, Services for HTTP only.**
- **Scrape.do proxy: SofaScore fallback only.** Direct first, proxy on 403 only. Free tier 1k credits/mo.
- **Post-change:** always `npm run build` + `npm run lint`.
- **Always clean dead code and artifacts** (unused scripts, stale imports, temp files) after completing a task.

## Entity Resolution

Postgres-backed alias system. Tournament-scoped lookup `(provider, surface_normalized, competition_id)`. Single ingress: `recordObservation`. Auto-resolver: deterministic gates → Bayesian → Vertex embedding cosine → operator review. Matcher Lab uses Node event matcher tables (`event_matcher_runs`, `matcher_candidates`, `matcher_decisions`, `matcher_impact_daily`); legacy Python-backed `match_pairs`/`matcher_config`/`matcher_runs` tables are dropped. See CLAUDE.md §Entity Resolution.
