<div align="center">

# NahidArbX

### Real-time value-bet detection and settlement operations for sports-betting markets

NahidArbX connects to betting providers, normalizes fixtures and odds, compares prices against sharp reference odds, flags **positive expected value** opportunities, tracks placed bets, and supports source-based settlement review.

<br />

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-16-000000?style=for-the-badge&logo=nextdotjs&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=111111)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Cloud_SQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)
![Google Cloud](https://img.shields.io/badge/Google_Cloud-Managed_ML-4285F4?style=for-the-badge&logo=googlecloud&logoColor=white)
![Local Demo](https://img.shields.io/badge/Demo-Local_Only-f97316?style=for-the-badge)

</div>

---

## Demo Note

This is a personal technical project, not a commercial betting product, client service, or public wagering operation. A hosted demo is not available because the provider integrations have access, account, and jurisdictional restrictions. If anyone is interested, I can demonstrate the local version from my machine.

## Legal and Responsible Use

NahidArbX is shared as a personal technical case study for reviewing software architecture, data processing, automation, and operational tooling. It is not betting advice, a bookmaker, a gambling service, or a platform for public wagering.

The repository does not include provider credentials, session files, or live access. Demonstrations should use screenshots, demo data, or a local walkthrough, and should not require placing real wagers.

Betting and gambling laws vary by jurisdiction and may restrict or prohibit this type of activity. Anyone reviewing, running, or adapting this code is responsible for complying with applicable laws, provider terms, and platform policies.

Do not use this repository to facilitate real-money wagering where betting or gambling is restricted or prohibited.

## Screenshots

### Dashboard

![Dashboard](assets/screenshots/Dashboard.png)

### Value-Bet Finder

![Value-Bet Finder](assets/screenshots/Value_Bets_Page.png)

### Bets History and Settlement

![Bets History and Settlement](assets/screenshots/Bets_History_and_Settlement.png)

### Matcher Lab

![Matcher Lab](assets/screenshots/Matcher_Lab.png)

### ML Optimizer

![ML Optimizer](assets/screenshots/ML_optimizer.png)

## What The System Does

| Area | Details |
| --- | --- |
| **Provider ingestion** | Pulls fixtures, odds, balances, session state, and provider overviews from sportsbook integrations |
| **Event matching** | Aligns cross-provider football fixtures despite different team names, competitions, and kickoff surfaces |
| **Market normalization** | Converts provider markets into shared **families** and **atoms** so prices can be compared consistently |
| **Value-bet detection** | Uses vig-removed Pinnacle probability, commission-adjusted soft odds, EV percentage, and Kelly-based stake sizing |
| **Placed-bet tracking** | Stores deterministic bet records with stake, odds, provider ticket IDs, CLV, outcome, P/L, and settlement metadata |
| **Settlement review** | Resolves bets through deterministic source tiers and keeps unresolved rows pending for operator review |
| **Entity resolution** | Records provider aliases in Postgres and promotes safe matches using gates, repeated evidence, and Vertex embeddings |
| **ML workflow** | Tracks current-contract training readiness and triggers managed LightGBM training through Google Cloud Run Jobs |

## Architecture

```text
                  Provider Sessions
     Pinnacle / NineWickets / Velki / SABA / BetConstruct
                            |
                            v
                    Background Engine
       fixture sync | odds ingestion | matching | detection
       settlement   | placement flow | alerts   | retention
                            |
                            v
                     Cloud SQL Postgres
        events | odds atoms | bets | aliases | logs | ML samples
                            |
                            v
                       Next.js Dashboard
       value bets | bets history | matcher lab | ML lab | diagnostics
```

## Implementation Notes

- **Dual-process runtime**: `engine.ts` runs background jobs and exposes the Engine HTTP API; Next.js serves the UI, proxy routes, and SSE streams.
- **Database initialization**: `ensureDbReady()` initializes Cloud SQL access for both the engine and web process before Drizzle queries run.
- **Reactive detection**: odds updates flow through fixture matching, market atoms, and debounced value-bet detection.
- **Deterministic settlement**: settlement uses cache, ESPN, SofaScore, and API-Football before leaving unresolved bets for manual review.
- **Managed ML**: model training runs as a Google Cloud Run Job; model artifacts and embeddings stay on managed Google Cloud infrastructure.

## Key Routes

| Route | Purpose |
| --- | --- |
| `/dashboard` | Account overview, provider state, exposure, and performance |
| `/value-bets` | Real-time value-bet discovery and odds comparison |
| `/bets` | Bet history, settlement state, review, and profit/loss |
| `/matcher-lab` | Event matcher runs, candidates, decisions, and scheduler controls |
| `/lab/ml` | ML optimizer, corpus progress, and training readiness |
| `/ai-engine` | AI provider health and configuration |
| `/logs/auto-placer` | Placement workflow history and diagnostics |
| `/logs/ai-activity` | AI and search audit trail |
| `/telegram` | Telegram bot status and controls |

## Tech Stack

| Layer | Tools |
| --- | --- |
| **Frontend** | Next.js 16, React 19, TypeScript, Tailwind CSS, Radix UI |
| **Data UI** | TanStack Query, TanStack Table, TanStack Virtual, Recharts |
| **Backend** | Node.js, `tsx`, Engine HTTP API, Server-Sent Events |
| **Database** | PostgreSQL, Cloud SQL, Drizzle ORM |
| **Validation** | Zod |
| **Provider automation** | Playwright, authenticated sessions, provider adapters |
| **Cloud and ML** | Google Cloud Run Jobs, Cloud Storage, Vertex AI, LightGBM |
| **Notifications** | Telegram Bot API |
| **Quality** | ESLint, Next build, Node test runner, Vitest |

## Local Development

The application expects one root `.env` file with database, provider, AI, settlement, Google Cloud, and Telegram credentials. Credentials and session files are not committed.

Install dependencies:

```bash
npm install
```

Run the engine and dashboard together:

```bash
npm run dev:all
```

Or run each process separately:

```bash
npm run engine
npm run dev
```

Default local services:

| Service | URL |
| --- | --- |
| **Web dashboard** | `http://localhost:3000` |
| **Engine API** | `http://localhost:3001` |

## Verification

```bash
npm run build
npm run lint
npm run test:unit
npx vitest run
```

## Repository Map

| Path | Purpose |
| --- | --- |
| `engine.ts` | Background engine entry point |
| `instrumentation.ts` | Web-process database initialization |
| `app/` | Next.js routes and API endpoints |
| `components/` | Dashboard and shared UI components |
| `lib/atoms/` | Market family, atom, odds, and detection logic |
| `lib/event-matcher/` | Event matching pipeline and Matcher Lab data |
| `lib/matching/entities/` | Entity observation, aliasing, and auto-resolution |
| `lib/settle/` | Shared settlement pipeline and score sources |
| `lib/ml/` | ML feature contract, learning, accounting, and optimizer logic |
| `lib/betting/` | Provider placement, account, and session adapters |
| `services/optimizer/` | Cloud Run LightGBM training sidecar |
