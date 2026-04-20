# NahidArbX System Overview

A visual guide to understand how the application works.

## High-Level Architecture

```
                                    YOUR MACBOOK
┌────────────────────────────────────────────────────────────────────────────────┐
│                                                                                │
│   ┌─────────────────────────────────────────────────────────────────────────┐  │
│   │                              PM2 DAEMON                                  │  │
│   │                          (runs in background)                           │  │
│   ├─────────────────────────────────────────────────────────────────────────┤  │
│   │                                                                         │  │
│   │   ┌───────────────────────┐      ┌───────────────────────┐             │  │
│   │   │     nahidarbx         │      │       tunnel          │             │  │
│   │   │   (Next.js App)       │      │   (cloudflared)       │             │  │
│   │   │   Port: 4747          │◄────►│                       │             │  │
│   │   │                       │      │                       │             │  │
│   │   └───────────────────────┘      └───────────────────────┘             │  │
│   │              │                              │                           │  │
│   └──────────────┼──────────────────────────────┼───────────────────────────┘  │
│                  │                              │                              │
│                  ▼                              ▼                              │
│        localhost:4747                  Cloudflare Network                      │
│                                               │                                │
└───────────────────────────────────────────────┼────────────────────────────────┘
                                                │
                                                ▼
                                      ┌─────────────────┐
                                      │ nahidarbx.store │
                                      │  (Public URL)   │
                                      └─────────────────┘
                                                │
                                                ▼
                                      ┌─────────────────┐
                                      │    USERS        │
                                      │ (Browser/Phone) │
                                      └─────────────────┘
```

## Data Flow - How Odds Are Fetched

```
Every 30 seconds (FETCH_INTERVAL_MS):

┌──────────────────────────────────────────────────────────────────────────────┐
│                         BACKGROUND SYNC SCHEDULER                             │
│                      (lib/background/fetcher.ts)                              │
└──────────────────────────────────────────────────────────────────────────────┘
                                    │
           ┌────────────────────────┼────────────────────────┐
           │                        │                        │
           ▼                        ▼                        ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│    PINNACLE      │    │   9W EXCHANGE    │    │  9W SPORTSBOOK   │
│                  │    │                  │    │                  │
│ Token via        │    │ Direct API       │    │ Direct API       │
│ Playwright       │    │                  │    │                  │
│ (Browser auto)   │    │                  │    │                  │
└────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘
         │                       │                       │
         │     ┌─────────────────┴─────────────────┐     │
         │     │                                   │     │
         └────►│         EVENT MATCHING            │◄────┘
               │    (lib/matching/matcher.ts)      │
               │                                   │
               │  • Compare team names (fuzzy)     │
               │  • Compare competition names      │
               │  • Compare start times            │
               │  • Score >= 85% = MATCH           │
               └─────────────────┬─────────────────┘
                                 │
                                 ▼
               ┌─────────────────────────────────────┐
               │         IN-MEMORY STORE             │
               │          (lib/store.ts)             │
               │                                     │
               │  ┌─────────────┐  ┌─────────────┐   │
               │  │   Events    │  │  Atoms/Odds │   │
               │  │   Store     │  │    Store    │   │
               │  └─────────────┘  └─────────────┘   │
               └─────────────────┬───────────────────┘
                                 │
                                 ▼
               ┌─────────────────────────────────────┐
               │       ARBITRAGE DETECTION           │
               │      (lib/atoms/arbitrage.ts)       │
               │                                     │
               │  For each market family:            │
               │  • Get best odds per outcome        │
               │  • Calculate implied probability    │
               │  • If sum < 100% = ARBITRAGE!       │
               │  • Calculate stakes & profit        │
               └─────────────────────────────────────┘
```

## Request Flow - User Loads Dashboard

```
User visits nahidarbx.store/admin

┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Browser   │────►│  Cloudflare  │────►│   Next.js    │────►│  In-Memory   │
│             │     │   Tunnel     │     │   Server     │     │    Store     │
└─────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
      │                                          │                    │
      │                                          │                    │
      │     1. GET /admin                        │                    │
      │────────────────────────────────────────►│                    │
      │                                          │                    │
      │     2. Check JWT (middleware)            │                    │
      │                                          │                    │
      │     3. Render React page                 │                    │
      │◄────────────────────────────────────────│                    │
      │                                          │                    │
      │     4. GET /api/dashboard (every 30s)   │                    │
      │────────────────────────────────────────►│                    │
      │                                          │  5. Read events   │
      │                                          │─────────────────►│
      │                                          │                    │
      │                                          │  6. Read arbs     │
      │                                          │◄─────────────────│
      │                                          │                    │
      │     7. Return JSON                       │                    │
      │◄────────────────────────────────────────│                    │
      │                                          │                    │
      │     8. Update UI                         │                    │
      │                                          │                    │
```

## Pinnacle Token Capture Flow

```
When Pinnacle token expires (~1 hour):

┌─────────────────────────────────────────────────────────────────────────────┐
│                        TOKEN CAPTURE (Playwright)                            │
│                      lib/auth/token-manager.ts                               │
└─────────────────────────────────────────────────────────────────────────────┘

Step 1: Check cached token
        │
        ▼
    ┌──────────────────┐     Valid?      ┌──────────────────┐
    │ pinnacle-token   │──────YES──────►│  USE TOKEN       │
    │     .json        │                 │  (skip browser)  │
    └──────────────────┘                 └──────────────────┘
        │ NO/Expired
        ▼
Step 2: Try stored URL
        │
        ▼
    ┌──────────────────┐     Works?      ┌──────────────────┐
    │ pinnacle-url     │──────YES──────►│  CAPTURE TOKEN   │
    │     .txt         │                 │  (fast path)     │
    └──────────────────┘                 └──────────────────┘
        │ NO/Invalid
        ▼
Step 3: Try browser session
        │
        ▼
    ┌──────────────────┐     Works?      ┌──────────────────┐
    │ browser-state    │──────YES──────►│  Click PINNACLE  │
    │     .json        │                 │  → Capture token │
    └──────────────────┘                 └──────────────────┘
        │ NO/Expired
        ▼
Step 4: Full login (last resort)
        │
        ▼
    ┌──────────────────────────────────────────────────────┐
    │  1. Open betjili365.com                              │
    │  2. Enter username/password                          │
    │  3. Click login                                      │
    │  4. Click PINNACLE button                            │
    │  5. Intercept Bearer token from network requests     │
    │  6. Save token + URL + session for next time         │
    └──────────────────────────────────────────────────────┘
```

## Authentication Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           USER AUTHENTICATION                                │
└─────────────────────────────────────────────────────────────────────────────┘

NEW USER (Invite Flow):
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Admin   │───►│  POST    │───►│  Email   │───►│  User    │───►│  User    │
│  invites │    │ /invite  │    │  sent    │    │  clicks  │    │  sets    │
│  user    │    │          │    │  (token) │    │  link    │    │ password │
└──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘

LOGIN:
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  User    │───►│  POST    │───►│  Verify  │───►│  Set JWT │
│  enters  │    │ /login   │    │ password │    │  cookie  │
│  creds   │    │          │    │  (bcrypt)│    │          │
└──────────┘    └──────────┘    └──────────┘    └──────────┘

EVERY REQUEST:
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Request │───►│Middleware│───►│  Verify  │───►│  Allow   │
│  arrives │    │          │    │   JWT    │    │ or deny  │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
```

## Process Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              LIFECYCLE                                       │
└─────────────────────────────────────────────────────────────────────────────┘

MAC BOOTS UP
     │
     ▼
PM2 Daemon starts (via launchd)
     │
     ├───► nahidarbx process starts
     │          │
     │          ├───► Next.js server on port 4747
     │          │
     │          └───► Background scheduler starts
     │                     │
     │                     └───► Syncs every 30 seconds
     │
     └───► tunnel process starts
                │
                └───► Connects to Cloudflare
                           │
                           └───► Public URL active

USER VISITS SITE
     │
     ▼
Request → Cloudflare → Tunnel → Next.js → Response

DEPLOY (npm run deploy)
     │
     ├───► Build Next.js app
     │
     ├───► Stop old PM2 process
     │
     └───► Start new PM2 process
                │
                └───► Zero downtime (tunnel stays connected)
```

## Deployment Flow - Step by Step

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                            npm run deploy                                      ║
╚═══════════════════════════════════════════════════════════════════════════════╝
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ STEP 1: BUILD                                                                   │
│ ┌─────────────────────────────────────────────────────────────────────────────┐ │
│ │  $ NODE_ENV=production npm run build                                        │ │
│ │                                                                             │ │
│ │  • Next.js compiles TypeScript → JavaScript                                 │ │
│ │  • Bundles React components                                                 │ │
│ │  • Optimizes for production (minification, tree-shaking)                    │ │
│ │  • Output: .next/ directory (~30 seconds)                                   │ │
│ │                                                                             │ │
│ │  NOTE: NEXT_PHASE=phase-production-build prevents scheduler from starting   │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ STEP 2: STOP OLD PROCESS                                                        │
│ ┌─────────────────────────────────────────────────────────────────────────────┐ │
│ │  $ pm2 delete nahidarbx 2>/dev/null || true                                 │ │
│ │                                                                             │ │
│ │  • Gracefully stops the old Next.js server                                  │ │
│ │  • Releases port 4747                                                       │ │
│ │  • Old requests complete (5s kill_timeout)                                  │ │
│ │  • Tunnel stays connected! (separate process)                               │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ STEP 3: START NEW PROCESS                                                       │
│ ┌─────────────────────────────────────────────────────────────────────────────┐ │
│ │  $ pm2 start ecosystem.config.js --env production                           │ │
│ │                                                                             │ │
│ │  • PM2 launches: npm run start                                              │ │
│ │  • Next.js server binds to PORT=4747                                        │ │
│ │  • Environment: NODE_ENV=production, FETCH_INTERVAL_MS=30000                │ │
│ │  • App loads → Dashboard route initializes → Scheduler starts               │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ STEP 4: SCHEDULER INITIALIZATION                                                │
│ ┌─────────────────────────────────────────────────────────────────────────────┐ │
│ │  When /api/dashboard route is first loaded:                                 │ │
│ │                                                                             │ │
│ │  1. Check: is this build-time? → Skip scheduler                             │ │
│ │  2. Check: is scheduler running? → Skip if already running                  │ │
│ │  3. Start background sync scheduler                                         │ │
│ │                                                                             │ │
│ │  Scheduler loop (every 30s):                                                │ │
│ │    → Fetch fixtures from all providers                                      │ │
│ │    → Match events across providers                                          │ │
│ │    → Fetch odds & store in atoms                                            │ │
│ │    → Detect arbitrage opportunities                                         │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
╔═══════════════════════════════════════════════════════════════════════════════╗
║                              READY TO SERVE                                    ║
║                                                                                ║
║   localhost:4747 ◄───► Cloudflare Tunnel ◄───► nahidarbx.store                ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

## What Happens When Code Changes

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          CODE CHANGE DEPLOYMENT                                  │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│   1. YOU EDIT CODE                                                              │
│      └── Save changes to any .ts/.tsx file                                      │
│                                                                                 │
│   2. RUN DEPLOY                                                                 │
│      └── $ npm run deploy                                                       │
│      └── Builds new version with your changes                                   │
│                                                                                 │
│   3. ZERO-DOWNTIME RESTART                                                      │
│      └── Old server stops (5s graceful shutdown)                                │
│      └── New server starts immediately                                          │
│      └── Tunnel reconnects to new server                                        │
│                                                                                 │
│   4. USERS SEE CHANGES                                                          │
│      └── Next browser refresh shows new code                                    │
│      └── No manual tunnel restart needed                                        │
│                                                                                 │
│   Timeline: ~30-40 seconds total                                                │
│   Downtime: ~1-2 seconds (between old stop and new start)                       │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## PM2 Process Management

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            PM2 PROCESS TREE                                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│   PM2 Daemon (always running in background)                                     │
│   ├── nahidarbx (Next.js app)                                                   │
│   │   ├── Status: online                                                        │
│   │   ├── Port: 4747                                                            │
│   │   ├── Memory: ~300-500MB                                                    │
│   │   ├── Auto-restart: on crash                                                │
│   │   ├── Max restarts: 50                                                      │
│   │   └── Max memory: 1GB (auto-restart if exceeded)                            │
│   │                                                                             │
│   └── tunnel (cloudflared)                                                      │
│       ├── Status: online                                                        │
│       ├── Connects to: Cloudflare Network                                       │
│       ├── Routes: nahidarbx.store → localhost:4747                              │
│       └── Auto-restart: on crash                                                │
│                                                                                 │
│   Commands:                                                                     │
│   ├── pm2 list         → Show all processes                                     │
│   ├── pm2 logs         → View real-time logs                                    │
│   ├── pm2 restart all  → Restart everything                                     │
│   └── pm2 monit        → CPU/Memory monitor                                     │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## File Structure Overview

```
nahidArbX/
├── app/                      # Next.js pages & API routes
│   ├── admin/               # Dashboard page
│   ├── login/               # Auth pages
│   └── api/
│       ├── dashboard/       # Main data API
│       └── auth/            # Auth endpoints
│
├── lib/                      # Core logic
│   ├── adapters/            # Provider adapters (Pinnacle, 9W)
│   ├── atoms/               # Odds storage & arbitrage detection
│   ├── auth/                # Authentication (JWT, sessions)
│   ├── background/          # Sync scheduler
│   ├── matching/            # Event matching algorithm
│   └── store.ts             # In-memory data store
│
├── components/              # React components
│   ├── auth/               # Auth UI (login, profile)
│   └── spreadsheet/        # Dashboard table
│
├── sessions/                # Cached tokens & sessions (gitignored)
│   └── betjili/
│       ├── pinnacle-token.json
│       ├── pinnacle-url.txt
│       └── browser-state.json
│
├── ecosystem.config.js      # PM2 configuration
└── .env.local              # Secrets (gitignored)
```

## Key Metrics

| Metric          | Value      | Location                  |
| --------------- | ---------- | ------------------------- |
| Sync interval   | 30 seconds | `ecosystem.config.js`     |
| Match threshold | 85%        | `lib/matching/matcher.ts` |
| Token expiry    | ~1 hour    | Pinnacle JWT              |
| Session expiry  | 24 hours   | Auth JWT                  |
| Min arb profit  | 0.5%       | `lib/config.ts`           |
| Total stake     | 100        | `lib/config.ts`           |

## Monitoring Commands

```bash
# View all processes
pm2 list

# Real-time logs
pm2 logs

# Process details
pm2 show nahidarbx

# Resource usage
pm2 monit

# Health check
curl http://localhost:4747/api/health
```
