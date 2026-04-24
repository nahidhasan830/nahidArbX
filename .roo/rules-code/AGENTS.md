# Project Coding Rules (Non-Obvious Only)

- **Use `singleton()` from `lib/util/singleton.ts`** for any state that must survive HMR/Turbopack. Module-level `let` gives independent copies per loader context — pin to `globalThis` via `singleton()`.
- **Bet IDs are deterministic**: `${eventId}|${familyId}|${atomId}` — never UUIDs. This is the `bets` table primary key.
- **Auto-place stakes must snap to multiples of `AUTO_PLACE_STAKE_BUCKET` (100 BDT)**, min `MIN_AUTO_PLACE_STAKE` (200 BDT). Never submit fractional stakes like 4.69.
- **AI settlement is OFF by default** — every paid Gemini call MUST check `isAiEnabled()` first. See `lib/settle/cost-guard.ts`.
- **`lib/betting/settlement-cascade.ts`** is deprecated (empty re-export) — settlement is inline in the bets table via `applySettlement()` in `lib/db/repositories/bets.ts`.
- **`lib/shared/constants.ts`** is the single source of truth for magic numbers, NOT `lib/config.ts` (which only reads from constants + env vars).
- **Drizzle casing is `snake_case`** — DB columns are snake_case, TS code uses camelCase via Drizzle's casing transform. Config in `drizzle.config.ts`.
- **`better-sqlite3` is auth-only** — do NOT use it for app data. App DB is Postgres via Drizzle (`lib/db/client.ts`).
- **Middleware uses `jose`** (Edge Runtime compatible), not `jsonwebtoken`.
- **Adding a betting provider**: implement `BettingProviderAdapter` from `lib/betting/types.ts`, register in `BETTING_PROVIDERS` map in `lib/betting/registry.ts`.
- **Adding market types**: extend `AtomMarketType` in `lib/atoms/types.ts`, add families/atoms in `lib/atoms/atoms.json`.
- **Two separate test systems**: Vitest (`tests/unit/`) and Node built-in runner (`lib/**/*.test.ts`). `npm run test:unit` uses the latter.
- **All external data validated with Zod** before processing — no exceptions.
