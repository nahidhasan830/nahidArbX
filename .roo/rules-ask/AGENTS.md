# Project Documentation Rules (Non-Obvious Only)

- **`lib/config.ts` is NOT the source of truth for constants** — `lib/shared/constants.ts` is. `config.ts` only reads from constants + env vars.
- **`lib/betting/settlement-cascade.ts`** is deprecated but still exists (empty re-export) — don't reference it for settlement logic; settlement is inline in the bets table.
- **`lib/db/schema.ts`** has a unified `bets` table that merged the former `value_bets` and `placed_bets` tables. Placement fields are NULL until a bet is actually placed.
- **Two separate test systems** exist: Vitest (`tests/unit/`) and Node built-in runner (`lib/**/*.test.ts`). They are NOT interchangeable — `npm run test:unit` runs the Node runner only.
- **`better-sqlite3` is auth-only** — the app DB is Postgres via Drizzle. Don't confuse the two.
- **`lib/atoms/atoms.json`** defines all market families/atoms — this is the canonical source, not code.
- **`lib/providers/registry.ts`** is the single source of truth for provider metadata (which are sharp vs soft, commission rates).
- **`CLAUDE.md`** is the most comprehensive project doc — includes architecture, data flow, algorithms, and critical rules. `ARCHITECTURE.md` and `backtesting.md` supplement it.
- **`instrumentation.ts`** is the server-boot hook that starts the sync + auto-settlement schedulers — the system is headless and runs whether or not the UI is open.
