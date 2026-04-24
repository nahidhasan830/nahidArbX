# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Build & Test Commands

- `npm run build` — production build (always run after changes, per CLAUDE.md rules)
- `npm run lint` — ESLint (next/core-web-vitals + typescript configs)
- `npm run test:unit` — Node built-in test runner via `node --import tsx --test lib/**/*.test.ts` (NOT vitest)
- `npx vitest run` — Vitest unit tests from `tests/unit/` (separate from test:unit above)
- `npm run test:settle` — Node runner focused on `lib/settle/*.test.ts`
- Single unit test: `node --import tsx --test lib/settle/settle-bet.test.ts`
- DB: `npm run db:generate` then `npm run db:migrate` (drizzle-kit, snake_case casing)

UI verification is manual — the user exercises changed features in-browser. Do not run Playwright E2E suites.

## Critical Non-Obvious Rules

- **Use `singleton()` from `lib/util/singleton.ts`** for any state that must survive Next.js HMR / Turbopack's separate module graphs. Module-level `let` gives independent copies per loader.
- **`instrumentation.ts`** is the server-boot hook that starts the sync + auto-settlement schedulers — the system is headless and runs whether or not the UI is open.
- **Auto-settle kill switch persists to `sessions/auto-settle-config.json`** — survives deploys/restarts. If settlement is mysteriously off, check this file.
- **AI settlement is OFF in the background scheduler by default** — `runAutoSettle` never passes `allowAi: true`. Manual settlement via UI/API opts in per-request through `settleBatch`'s `allowAi`/`forceAi` options, guarded by `assertWithinRequestCeiling` (default $2/batch ceiling). There is no global `AI_SETTLEMENT_ENABLED` env var or `isAiEnabled()` function anymore.
- **Bet IDs are deterministic**: `${eventId}|${familyId}|${atomId}` (not UUIDs) — primary key for `bets` table.
- **`bets` is the only app/backtest settlement table** — `value_bets` and `placed_bets` are dropped legacy tables. New code must use the merged `bets` table everywhere, and cleanup work should remove stale references to the old split-table model.
- **Settlement pipeline must be shared everywhere** — auto-settle, manual re-settle, and manual outcome application should converge on `settleBatch` / `applySettlementOutcomes` rather than drifting into separate code paths.
- **Telegram settlement notifications are only for actually placed bets** — if a row was never placed (`placedAt` is null), settle it silently with no notification.
- **Auto-place stakes snap to multiples of 100 BDT** (`AUTO_PLACE_STAKE_BUCKET`), min 200 BDT. Never submit fractional stakes.
- **`better-sqlite3` is auth-only** — do NOT use it for app data. App DB is Postgres via Drizzle.
- **Do not assume the local `.env` `DATABASE_URL` or `127.0.0.1` Postgres is the source of truth** — when runtime DB inspection is needed, prefer the real cloud database path via the app's configured SDK/connector. Document any local-only assumptions before using them.
- **Middleware uses `jose`** (Edge Runtime compatible), not `jsonwebtoken`.
- **Drizzle casing is `snake_case`** — DB columns are snake_case, TS code uses camelCase via Drizzle's casing transform.
- **`lib/shared/constants.ts`** is the single source of truth for magic numbers (not `lib/config.ts`).
- **`lib/betting/settlement-cascade.ts`** is deprecated (empty re-export) — settlement is inline in bets table now.
- **Two separate test systems**: Vitest (`tests/unit/`) and Node built-in runner (`lib/**/*.test.ts`). `npm run test:unit` uses the latter.
- **Single `.env` file** — this project uses one `.env` at repo root. Do not create `.env.local` or `.env.example`.
- **Cloud-only runtime — never run services locally.** The operator does not run `npm run dev`, the Python optimizer sidecar, `cloud-sql-proxy`, or any other service on their machine. Default to "deploy to production and verify there." Next.js prod lives at `https://nahidarbx.store`. Python optimizer sidecar runs on Cloud Run (`nahidarbx-optimizer`, project `nahidarbx-6e73`, region `asia-south1`) — push the change and redeploy via `bash services/optimizer/redeploy.sh` (or rely on the Cloud Build trigger if wired). Never instruct the operator to `brew install` tools, start a local uvicorn, or `curl localhost:*`. Verify via the cloud URL (`curl https://<service>/health`), not localhost.
- **Cloud SQL Postgres** in production (`nahidarbx-6e73:asia-south1:nahidarbx-db`). Local dev requires `cloud-sql-proxy --port 5432 nahidarbx-6e73:asia-south1:nahidarbx-db`.
- **Gemini cost safety** — paid `url_context` calls are gated by per-batch cost ceiling (`AI_MAX_PER_REQUEST_USD`, default $2). Never run AI settlement against real DB without verifying free tiers are maxed out and spend cap is lowered at ai.studio/spend. See CLAUDE.md "AI Cost Safety" section for full protocol.
- **Toolbar / filter components must be reused across spreadsheet surfaces.** When adding a new list/table page, reuse the patterns in `BetsHistoryToolbar` and `SpreadsheetToolbar` — same control heights (`h-7`), same `px-3 py-1.5` wrapper, same `bg-muted/40` backdrop, same `text-[11px]` buttons. If you need a new variant, extract the common parts into a shared component first. Inconsistent sizing between pages was a known pain point (April 2026).
