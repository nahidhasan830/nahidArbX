# Project Debug Rules (Non-Obvious Only)

- **Auto-settle kill switch persists to `sessions/auto-settle-config.json`** — survives deploys/restarts. If settlement is mysteriously off, check this file.
- **AI settlement defaults to OFF** — `AI_SETTLEMENT_ENABLED=true` env or POST `{ "action": "enable-ai" }` to `/api/backtest/auto-settle`. If Gemini calls are silently skipped, check `isAiEnabled()`.
- **Gemini spend overages are a real risk** — one bad `url_context` URL can blow the 1M-token cap and cost dollars. Always lower the spend cap at ai.studio/spend before testing AI settlement against real DB.
- **`settlement_runs` table** logs every tick's tier hits + estimated cost — check `tier3_hits`/`tier4_hits` spikes to diagnose AI cost issues.
- **Pinnacle token capture** has a 4-level fallback chain: stored token → stored URL → browser session → full login. If token capture fails, check `sessions/betjili/` for stale files.
- **Cloud SQL Auth Proxy** must be running locally on port 5432 for DB access: `cloud-sql-proxy --port 5432 nahidarbx-6e73:asia-south1:nahidarbx-db`
- **`better-sqlite3` is auth-only** — if you see SQLite errors in app logic, something is wrong. App data is Postgres.
- **Playwright E2E tests auto-start dev server** — if port 3000 is occupied, tests may hang. Use `npm run kill` first.
- **Debug commands** for providers: see CLAUDE.md "Debug Commands" section for token capture and adapter testing one-liners.
