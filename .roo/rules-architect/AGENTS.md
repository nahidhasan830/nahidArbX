# Project Architecture Rules (Non-Obvious Only)

- **4-Phase Pipeline**: Fixtures → Matching → Markets → Arbitrage. Runs on background scheduler every 60s. Started from `instrumentation.ts` (headless — no UI dependency).
- **Dual Store System**: Events Store (`lib/store.ts`) + Atoms Odds Store (`lib/atoms/store.ts`). Both use `singleton()` to survive HMR — never use module-level `let` for shared state.
- **Family/Atom model**: A Family is a mutually-exclusive market (e.g., 1X2); an Atom is a single outcome. Defined in `lib/atoms/atoms.json`. Atoms cannot belong to multiple families (validated at init).
- **Value-bet detection** compares soft-book odds against Pinnacle's vig-removed true probability. Vig removal uses "balanced margin" method in `lib/atoms/vig-removal.ts`. Kelly criterion for sizing (quarter Kelly default).
- **Bet IDs are deterministic** (`${eventId}|${familyId}|${atomId}`) — not UUIDs. This enables upsert/dedup but means the same selection always maps to the same row.
- **Unified `bets` table** merged `value_bets` + `placed_bets`. Placement fields are NULL until bet is placed. Settlement is inline (outcome + P&L on the bet row), not a separate cascade.
- **AI settlement is a last-resort tier** behind free tiers (match_scores cache, live feed, football-data.org). Must be explicitly enabled and cost-guarded. Kill switch persists to `sessions/auto-settle-config.json`.
- **Event Bus** (`lib/events/event-bus.ts`) is the cross-module communication backbone — sync pipeline emits, SSE endpoint subscribes, dashboard tracks versions.
- **Betting provider adapters** implement `BettingProviderAdapter` from `lib/betting/types.ts` and register in `lib/betting/registry.ts`. The generic placer (`lib/betting/placer.ts`) is provider-agnostic.
- **Drizzle with `snake_case` casing** — DB columns are snake_case, TS code uses camelCase. Transform is automatic via Drizzle config.
- **Cloud SQL Postgres** via `@google-cloud/cloud-sql-connector` in production, direct connection via proxy in dev. Pool cached on `globalThis` to survive HMR.
- **Use `date-fns` for date filtering** — already installed at v4.1.0. Prefer `startOfDay`, `endOfDay`, `subDays`, `startOfMonth` etc. over manual `Date` arithmetic for clarity and correctness. See `lib/backtest/date-presets.ts` for the pattern.
