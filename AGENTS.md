# AGENTS.md

Terse index for agents. [`CLAUDE.md`](CLAUDE.md) is the full reference — keep both in sync in the same commit.

## Build & Test

- `npm run build` — production build (always run after changes)
- `npm run lint` — ESLint
- `npm run test:unit` — Node built-in runner (`lib/**/*.test.ts`, NOT vitest)
- `npx vitest run` — Vitest (`tests/unit/`)
- `npm run test:settle` — Node runner for `lib/settle/*.test.ts`
- `npm run db:generate` then `npm run db:migrate` — Drizzle (snake_case casing)
- UI verification is manual — do not run Playwright E2E suites.

## Architecture & Data

- **`singleton()`** (`lib/util/singleton.ts`) for HMR-safe state. Module-level `let` breaks under Turbopack.
- **`instrumentation.ts`** boots sync + auto-settlement schedulers headlessly.
- **`bets` is the only settlement table.** `value_bets`/`placed_bets` are dropped legacy.
- **Settlement pipeline is shared** — auto/manual/re-settle all use `settleBatch`/`applySettlementOutcomes`.
- **Bet IDs are deterministic:** `${eventId}|${familyId}|${atomId}` (not UUIDs).
- **`better-sqlite3` is auth-only.** App DB is Postgres via Drizzle.
- **Drizzle casing:** DB snake_case, TS camelCase via casing transform.
- **`lib/shared/constants.ts`** = single source for magic numbers (not `lib/config.ts`).
- **`lib/betting/settlement-cascade.ts`** is deprecated (empty re-export).
- **Single `.env` file** at repo root. No `.env.local`/`.env.example`.
- **Middleware uses `jose`** (Edge Runtime), not `jsonwebtoken`.
- **Don't assume local DB is authoritative** — prefer cloud path via SDK/connector.

## Settlement & AI

- **No automatic AI.** Settlement is deterministic Tier 0/1/2 only.
- **Only paid Gemini path:** `/bets` "AI settle" → `aiLabelBets(ids, { forceAi: true, aiModel })`. Cost ceiling: `AI_MAX_PER_REQUEST_USD` ($2).
- **Automatic scheduler MUST never set `forceAi: true`.** See CLAUDE.md §Settlement & AI.
- **Telegram notifications only for placed bets** — null `placedAt` → settle silently.
- **Auto-place stakes:** multiples of 100 BDT (`AUTO_PLACE_STAKE_BUCKET`), min 200 BDT.
- **Prefilled AI prompts** preferred over automated Gemini calls for discovery tasks.

## UI Rules

- **Tailwind only — no custom CSS.** No component-scoped classes, no app keyframes. Extract React components, not CSS classes. See CLAUDE.md §Styling.
- **Every table uses `<DataTable>`** (`components/ui/data-table.tsx`). Don't write plain `<table>`. Pass `getRowId` for polled queries. Exception: `ValueBetSpreadsheet.tsx`.
- **Reuse toolbar/filter components.** Standard: `h-7`/`px-3 py-1.5`/`bg-muted/40`/`text-[11px]` buttons.
- **Typography:** Prose (sentences) → `text-sm` (14px min). Chrome (labels/controls) → `text-[11px]`/`text-xs`. Never full sentences at `text-[11px]`.
- **Tooltips on every control.** Use `<Tooltip>`/`<TooltipTrigger>`/`<TooltipContent>` — never plain `title=""`. State-aware. AI controls warn about cost.
- **Explanatory copy:** plain English headline + body with concrete betting example. No jargon. Glossary: `lib/lab/glossary.ts`. See CLAUDE.md §Explanatory copy.

## Workflow & Infrastructure

- **Solo-developer — no branches.** Commit everything relevant, few commits, no branch politics.
- **Runtime is localhost.** `npm run dev` → `http://localhost:3000`. Cloud SQL Postgres via proxy.
- **Cloud Run: Jobs for batch work, Services for HTTP only.** `--no-cpu-throttling` doesn't prevent idle reaping.
- **Fix scripts: agent runs them, not the operator.** Execute directly with `.env` + ADC. Verify outcome. See CLAUDE.md §Fix scripts.
- **IPRoyal proxy: SofaScore fallback only, never pre-emptive.** Direct first, proxy on 403 only. Don't route other sources through it.
- **Post-change:** always `npm run build` + `npm run lint`.

## Entity Resolution

Postgres-backed alias system (5 tables). Tournament-scoped lookup `(provider, surface_normalized, competition_id)`. Single ingress: `recordObservation`. 4-tier promoter (deterministic gates → Bayesian → LightGBM → operator review). Weekly Splink+Leiden cleanup Job. UI: `EntityInspector` at `/diagnostics → Entities` (7 tabs on `<DataTable>`). See CLAUDE.md §Entity Resolution.
