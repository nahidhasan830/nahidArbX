# PUKU.md

**IMPORTANT - Current Date**: 2026-05-12

> Before any web search or research task, ALWAYS run `date` to check current local date first. Use this date for any date-sensitive queries.

This file provides guidance to puku-cli when working with code in this repository.

## Commonly Used Commands

```bash
# Development (dual-process)
npm run engine       # Start background engine (13 subsystems)
npm run dev        # Start Next.js web UI (Turbopack)
npm run dev:all    # Start both in one terminal
npm run engine:stop # Stop engine gracefully

# Build & Deploy
npm run build      # Production build (always run after changes)
npm run lint       # ESLint
npm run deploy    # Build + PM2 deploy to Cloud Run

# Database (Drizzle)
npm run db:generate  # Generate migrations
npm run db:migrate   # Run migrations
npm run db:push     # Push schema to DB
npm run db:studio   # Open Drizzle Studio

# Testing
npx vitest run                          # Vitest (tests/unit/)
npm run test:unit                      # Node built-in runner (lib/**/*.test.ts)
node --import tsx --test lib/settle/*.test.ts  # Settlement tests only

# Scripts
npm run kill      # Force-kill port 3000
npm run ai-search # Start AI search supervisor
```

## Architecture

**Dual-process:** Engine (`engine.ts`) runs 13 background subsystems (sync, WebSockets, detection, auto-place, settle, Telegram). Next.js (`npm run dev`) is read-only web UI. Both require `NAHIDARBX_ENGINE=1` env var.

**13 Engine subsystems:** event sync, odds fetch, event matching, market atoms, value-bet detection, auto-placement, auto-settlement, Telegram bot, scheduler, entity resolver, token manager, optimizer sidecar, stats aggregator.

**DB:** Postgres via Drizzle + Cloud SQL Connector. `ensureDbReady()` in `lib/db/client.ts` must be called before any DB access. Table `bets` is the only settlement table—no `value_bets` or `placed_bets`.

**Deterministic bet IDs:** `${eventId}|${familyId}|${atomId}` (not UUIDs).

## Routes

| Route | Purpose |
| ----- | ------- |
| `/dashboard` | Account dashboard |
| `/value-bets` | Arb finder |
| `/bets` | Settlement + review |
| `/lab/ml` | ML optimizer |
| `/api/value-bets` | GET arb data, POST manual sync |
| `/api/ml/pipeline` | GET pipeline stats |
| `/api/ml/retrain` | POST trigger Cloud Run training job |

## Key Patterns

- **`singleton()`** from `lib/util/singleton.ts` for HMR-safe state—module-level `let` breaks under Turbopack.
- **All metrics/constants** in `lib/shared/constants.ts` (not `lib/config.ts`).
- **Middleware** uses `jose` (Edge Runtime), not `jsonwebtoken`.
- **Settlement pipeline** shared across auto/manual/re-settle—all use `settleBatch`/`applySettlementOutcomes`.
- **Entity resolution:** Postgres-backed alias system with 4-tier promoter (deterministic → Bayesian → LightGBM → operator).

## Settlement & AI

- **No automatic AI** for settlement—deterministic Tier 0/1/2 only.
- **Operator-triggered AI:** `/bets` "AI settle" → `aiLabelBets(ids, { forceAi: true })`. Cost cap: `AI_MAX_PER_REQUEST_USD` (default $2).
- **Auto-settle** never passes `forceAi: true`.
- **Stakes** snap to 100 BDT multiples (`AUTO_PLACE_STAKE_BUCKET`), min 200 BDT.
- **Telegram** only for placed bets—null `placedAt` = silent settle.

## Critical Rules

- **Tailwind only**—no custom CSS. Extract React components, not CSS classes.
- **Every table** uses `<DataTable>` (`components/ui/data-table.tsx`).
- **Tooltips** on every control—use `<Tooltip>`/``<TooltipContent>`, never plain `title=""`.
- **Env:** Single `.env` at repo root, no `.env.local`.
- **Geo-restriction:** Engine runs from Bangladesh IP for NineWickets/Velki.
- **Post-change:** always `npm run build` + `npm run lint`.