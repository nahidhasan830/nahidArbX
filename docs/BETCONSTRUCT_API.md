# BetConstruct API Documentation

> **Last Updated:** 2026-02-14
> **Verified With:** Live testing (1590 events including scheduled, 58 markets per game)

This document describes the BetConstruct Swarm WebSocket API structure used for fetching soccer betting odds.

---

## Table of Contents

1. [Authentication](#authentication)
2. [Connection](#connection)
3. [Commands](#commands)
4. [Response Structure](#response-structure)
5. [Data Types](#data-types)
6. [Market Types](#market-types)
7. [Event Types](#event-types)
8. [Mapping Logic](#mapping-logic)
9. [Code Examples](#code-examples)

---

## Authentication

**No authentication required.** BetConstruct Swarm API is publicly accessible.

### Session Flow

```
1. Connect to WebSocket
2. Send `request_session` → Receive `sid` (session ID)
3. Use `sid` in all subsequent requests
4. Optional: Subscribe for real-time updates (we use polling instead)
```

---

## Connection

### WebSocket URL

```
wss://eu-swarm-newm.betconstruct.com/
```

### Required Headers

| Header       | Value                 |
| ------------ | --------------------- |
| `Origin`     | `https://bc.cc2ps.cc` |
| `User-Agent` | Standard browser UA   |

### Site ID

```
1848
```

### Connection Example

```typescript
import WebSocket from "ws";

const ws = new WebSocket("wss://eu-swarm-newm.betconstruct.com/", {
  headers: {
    Origin: "https://bc.cc2ps.cc",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  },
});
```

---

## Commands

All commands are JSON messages with a `command` field and `rid` (request ID) for matching responses.

### 1. Request Session

Establishes a session and returns a `sid`.

```json
{
  "command": "request_session",
  "params": {
    "language": "en",
    "site_id": "1848"
  },
  "rid": "req-1"
}
```

**Response:**

```json
{
  "code": 0,
  "rid": "req-1",
  "data": {
    "sid": "1c2a38a7-9f52-4a40-7836-e8481382a7f8-1"
  }
}
```

### 2. Get All Events (Optimized Query)

Fetches ALL events (live, prematch, and scheduled) with a single optimized query.

**Key optimizations (40% faster than separate live/prematch queries):**

- Use empty arrays `sport: [], region: []` - no fields needed from them
- Remove `market` and `event` from `what` - filter still works without them
- Remove `game.type` filter - returns all types (0, 1, 2)

```json
{
  "command": "get",
  "params": {
    "source": "betting",
    "what": {
      "sport": [],
      "region": [],
      "competition": ["name"],
      "game": [
        [
          "id",
          "team1_name",
          "team2_name",
          "start_ts",
          "type",
          "is_blocked",
          "info",
          "markets_count"
        ]
      ]
    },
    "where": {
      "sport": { "alias": "Soccer" },
      "market": { "display_key": "WINNER", "display_sub_key": "MATCH" }
    },
    "subscribe": false
  },
  "rid": "req-2",
  "sid": "<session_id>"
}
```

**Game Types Returned:**

| `game.type` | Description         | Typical Count |
| ----------- | ------------------- | ------------- |
| `0`         | Prematch events     | ~140          |
| `1`         | Live/in-play events | ~80           |
| `2`         | Scheduled events    | **~1370**     |
| **Total**   | All events          | **~1590**     |

> **Note:** Most events are type=2 (scheduled). Previous queries that only fetched type=0 and type=1 missed 85% of available events!

### 3. Get Full Markets for Game

Fetches all markets and odds for a specific game (up to 399 markets for big matches).

```json
{
  "command": "get",
  "params": {
    "source": "betting",
    "what": {
      "sport": ["name"],
      "region": ["name"],
      "competition": ["name"],
      "game": [
        [
          "id",
          "stats",
          "info",
          "markets_count",
          "type",
          "start_ts",
          "team1_id",
          "team1_name",
          "team2_id",
          "team2_name",
          "is_blocked"
        ]
      ],
      "market": [
        "id",
        "group_id",
        "group_name",
        "type",
        "name",
        "base",
        "display_key",
        "express_id"
      ],
      "event": ["id", "type_1", "price", "name", "base", "order"]
    },
    "where": {
      "game": { "id": 29025881 },
      "sport": { "alias": "Soccer" }
    },
    "subscribe": false
  },
  "rid": "req-3",
  "sid": "<session_id>"
}
```

### 4. Unsubscribe (if using subscriptions)

```json
{
  "command": "unsubscribe",
  "params": { "subid": "<subscription_id>" },
  "rid": "req-4"
}
```

---

## Response Structure

### Top-Level Response

```typescript
{
  code: number,       // 0 = success
  rid: string,        // Request ID (matches request)
  data: {
    subid?: string,   // Subscription ID (if subscribe: true)
    data: NestedData  // Actual payload
  }
}
```

### Nested Data Structure

Response data is deeply nested: `sport > region > competition > game > market > event`

```typescript
data: {
  sport: {
    [sportId: string]: {
      name: string,           // "Soccer"
      alias: string,          // "Soccer"
      region: {
        [regionId: string]: {
          name: string,       // "England"
          competition: {
            [compId: string]: {
              name: string,   // "Premier League"
              game: {
                [gameId: string]: Game
              }
            }
          }
        }
      }
    }
  }
}
```

---

## Data Types

### Game Object

```typescript
interface BCGame {
  id: number; // Unique game identifier
  team1_name: string; // Home team
  team2_name: string; // Away team (undefined for outrights)
  team1_id?: number; // Home team ID
  team2_id?: number; // Away team ID
  start_ts: number; // Unix timestamp (seconds)
  markets_count: number; // Number of available markets
  is_blocked: number; // 0 = open, 1 = suspended
  type: number; // 0 = prematch, 1 = live, 2 = scheduled
  info?: GameInfo; // Live match info
  stats?: GameStats; // Match statistics
  market?: Record<string, Market>;
}
```

### Game Info (Live Events)

```typescript
interface GameInfo {
  current_game_state?: string; // "set1", "set2", "Half Time", "notstarted"
  current_game_time?: string; // Current minute (e.g., "48")
  score1?: string; // Home score
  score2?: string; // Away score
  add_minutes?: string; // Stoppage time
}
```

**Game States:**

| State        | Description       |
| ------------ | ----------------- |
| `notstarted` | Match not started |
| `set1`       | First half        |
| `Half Time`  | Half time break   |
| `set2`       | Second half       |

### Game Stats

```typescript
interface GameStats {
  [statType: string]: {
    team1_value: number | null;
    team2_value: number | null;
  };
}
```

**Available Stats:**

| Stat Type         | Description       |
| ----------------- | ----------------- |
| `goal`            | Goals scored      |
| `corner`          | Corners           |
| `yellow_card`     | Yellow cards      |
| `red_card`        | Red cards         |
| `shot_on_target`  | Shots on target   |
| `shot_off_target` | Shots off target  |
| `possession`      | Ball possession % |

### Market Object

```typescript
interface BCMarket {
  id: number; // Unique market identifier
  type: string; // Market type (e.g., "P1XP2", "OverUnder")
  name: string; // Display name
  base?: number; // Line value (for handicap/totals)
  display_key?: string; // Market category (e.g., "WINNER")
  express_id?: number; // Express bet identifier
  event?: Record<string, Event>; // Selections/outcomes
}
```

### Event/Selection Object

```typescript
interface BCEvent {
  id: number; // Selection identifier
  type_1: string; // Selection type ("W1", "W2", "X", "Over", "Under")
  price: number; // Decimal odds
  name: string; // Display name
  base?: number; // Line value (for specific selection)
  order: number; // Display order
}
```

---

## Market Types

### P1XP2 (Match Result / 1X2)

Three-way betting on match outcome.

```typescript
// Market
{
  type: "P1XP2",
  display_key: "WINNER",
  event: {
    "123": { type_1: "W1", price: 1.85, name: "NK Olimpija Ljubljana" },
    "124": { type_1: "X",  price: 3.40, name: "Draw" },
    "125": { type_1: "W2", price: 4.50, name: "FC Rukh Lviv" }
  }
}
```

**Mapping:**

| `type_1` | Atom ID       |
| -------- | ------------- |
| `W1`     | `ft_home_win` |
| `X`      | `ft_draw`     |
| `W2`     | `ft_away_win` |

### OverUnder (Total Goals)

Betting on total goals in the match.

```typescript
// Market (Over/Under 2.5)
{
  type: "OverUnder",
  base: 2.5,
  event: {
    "126": { type_1: "Over",  price: 1.90, name: "Over 2.5" },
    "127": { type_1: "Under", price: 1.95, name: "Under 2.5" }
  }
}
```

**Mapping:**

| `type_1` + `base` | Atom ID              |
| ----------------- | -------------------- |
| `Over` + `2.5`    | `ft_total_over_2_5`  |
| `Under` + `2.5`   | `ft_total_under_2_5` |

**Supported Lines:** 0.5, 1.5, 2.5, 3.5, 4.5, 5.5

### BothTeamsToScore (BTTS)

```typescript
{
  type: "BothTeamsToScore",
  event: {
    "128": { type_1: "Yes", price: 1.75, name: "Yes" },
    "129": { type_1: "No",  price: 2.10, name: "No" }
  }
}
```

**Mapping:**

| Selection | Atom ID       |
| --------- | ------------- |
| `Yes`     | `ft_btts_yes` |
| `No`      | `ft_btts_no`  |

### AsianHandicap

```typescript
// Home -0.5 handicap
{
  type: "AsianHandicap",
  base: -0.5,
  event: {
    "130": { type_1: "W1", price: 1.85, name: "NK Olimpija Ljubljana -0.5" },
    "131": { type_1: "W2", price: 2.00, name: "FC Rukh Lviv +0.5" }
  }
}
```

**Mapping:**

| Selection + `base` | Atom ID                |
| ------------------ | ---------------------- |
| `W1` + `-0.5`      | `ft_home_ah_minus_0_5` |
| `W2` + `-0.5`      | `ft_away_ah_plus_0_5`  |

**Supported Lines:** -2.5 to +2.5 in 0.5 increments

### 1X12X2 (Double Chance)

```typescript
{
  type: "1X12X2",
  event: {
    "132": { type_1: "1X", price: 1.25, name: "1X" },
    "133": { type_1: "12", price: 1.35, name: "12" },
    "134": { type_1: "X2", price: 1.55, name: "X2" }
  }
}
```

**Mapping:**

| `type_1` | Atom ID    |
| -------- | ---------- |
| `1X`     | `ft_dc_1x` |
| `12`     | `ft_dc_12` |
| `X2`     | `ft_dc_x2` |

### HalfTimeResult

Same as P1XP2 but for first half.

**Mapping:**

| `type_1` | Atom ID       |
| -------- | ------------- |
| `W1`     | `1h_home_win` |
| `X`      | `1h_draw`     |
| `W2`     | `1h_away_win` |

### SecondHalfResult

Same as P1XP2 but for second half.

**Mapping:**

| `type_1` | Atom ID       |
| -------- | ------------- |
| `W1`     | `2h_home_win` |
| `X`      | `2h_draw`     |
| `W2`     | `2h_away_win` |

### HalfTimeOverUnder (1H Total Goals)

```typescript
{
  type: "HalfTimeOverUnder",
  base: 0.5,
  event: {
    "140": { type_1: "Over",  price: 1.55, name: "Over 0.5" },
    "141": { type_1: "Under", price: 2.40, name: "Under 0.5" }
  }
}
```

**Supported Lines:** 0.5, 1.5, 2.5

### 2ndHalfTotalOver/Under (2H Total Goals)

Same structure as HalfTimeOverUnder.

**Supported Lines:** 0.5, 1.5, 2.5

### Team1OverUnder (Home Team Total)

```typescript
{
  type: "Team1OverUnder",
  base: 0.5,
  event: {
    "142": { type_1: "Over",  price: 1.40, name: "Over 0.5" },
    "143": { type_1: "Under", price: 2.85, name: "Under 0.5" }
  }
}
```

**Mapping:** `ft_home_over_X_X`, `ft_home_under_X_X`

**Supported Lines:** 0.5, 1.5, 2.5, 3.5

### Team2OverUnder (Away Team Total)

Same as Team1OverUnder but for away team.

**Mapping:** `ft_away_over_X_X`, `ft_away_under_X_X`

**Supported Lines:** 0.5, 1.5, 2.5, 3.5

### HalfTimeAsianHandicap (1H Asian Handicap)

Same structure as AsianHandicap but for first half.

**Mapping:** `1h_home_ah_X`, `1h_away_ah_X`

**Supported Lines:** -1.5 to +1.5

### DrawNoBet

```typescript
{
  type: "DrawNoBet",
  event: {
    "144": { type_1: "W1", price: 1.65, name: "Home" },
    "145": { type_1: "W2", price: 2.25, name: "Away" }
  }
}
```

**Mapping:**

| `type_1` | Atom ID       |
| -------- | ------------- |
| `W1`     | `ft_dnb_home` |
| `W2`     | `ft_dnb_away` |

### 1stHalfBothTeamsToScore (1H BTTS)

Same as BothTeamsToScore but for first half.

**Mapping:**

| Selection | Atom ID       |
| --------- | ------------- |
| `Yes`     | `1h_btts_yes` |
| `No`      | `1h_btts_no`  |

### CornersOverUnder (Corners Total)

```typescript
{
  type: "CornersOverUnder",
  base: 9.5,
  event: {
    "146": { type_1: "Over",  price: 1.90, name: "Over 9.5" },
    "147": { type_1: "Under", price: 1.90, name: "Under 9.5" }
  }
}
```

**Mapping:** `ft_corners_over_X_X`, `ft_corners_under_X_X`

**Supported Lines:** 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5

### 1stHalfCornersOver/Under (1H Corners Total)

Same as CornersOverUnder but for first half.

**Mapping:** `1h_corners_over_X_X`, `1h_corners_under_X_X`

**Supported Lines:** 3.5, 4.5, 5.5

### CornerHandicap (Corners Asian Handicap)

```typescript
{
  type: "CornerHandicap",
  base: -1.5,
  event: {
    "148": { type_1: "W1", price: 1.85, name: "Home -1.5" },
    "149": { type_1: "W2", price: 1.95, name: "Away +1.5" }
  }
}
```

**Mapping:** `ft_corners_home_ah_X`, `ft_corners_away_ah_X`

**Supported Lines:** -6.5 to +6.5

---

## Event Types

### Suspended Status

```typescript
// Check is_blocked field
if (game.is_blocked === 1) {
  // Market is suspended - show in UI but exclude from arb calculation
}
```

### Live vs Prematch

```typescript
// Check type field
switch (game.type) {
  case 0: // Prematch
  case 1: // Live
  case 2: // Scheduled
}
```

### Outright Detection

```typescript
// Outrights don't have team2_name
if (!game.team2_name) {
  // Skip - this is an outright market
}
```

---

## Market Groups

BetConstruct organizes markets into groups:

| Group       | Market Types                                       |
| ----------- | -------------------------------------------------- |
| `Match`     | P1XP2, DoubleChance, DrawNoBet, BTTS, CorrectScore |
| `Totals`    | OverUnder, Team1OverUnder, Team2OverUnder          |
| `Handicaps` | AsianHandicap, GoalsHandicap                       |
| `Halves`    | HalfTimeResult, HalfTimeOverUnder                  |
| `Corners`   | CornersOverUnder, CornerHandicap                   |
| `Players`   | PlayerToScore, PlayerToScoreByHeader               |
| `Minutes`   | First10MinutesGoals, 1-30Result                    |

---

## Mapping Logic

### Supported Market Types (17 total)

```typescript
const SUPPORTED_MARKET_TYPES = [
  // Match Result (3)
  "P1XP2", // Full Time Match Result
  "HalfTimeResult", // 1st Half Match Result
  "SecondHalfResult", // 2nd Half Match Result

  // Total Goals (3)
  "OverUnder", // Full Time Total Goals
  "HalfTimeOverUnder", // 1st Half Total Goals
  "2ndHalfTotalOver/Under", // 2nd Half Total Goals

  // Team Totals (2)
  "Team1OverUnder", // Home Team Total
  "Team2OverUnder", // Away Team Total

  // BTTS (2)
  "BothTeamsToScore", // Full Time BTTS
  "1stHalfBothTeamsToScore", // 1st Half BTTS

  // Asian Handicap (2)
  "AsianHandicap", // Full Time Asian Handicap
  "HalfTimeAsianHandicap", // 1st Half Asian Handicap

  // Other (2)
  "DrawNoBet", // Draw No Bet
  "1X12X2", // Double Chance

  // Corners (3)
  "CornersOverUnder", // Full Time Corners Total
  "1stHalfCornersOver/Under", // 1st Half Corners Total
  "CornerHandicap", // Corners Asian Handicap
];
```

### Coverage Summary

| Category       | Markets | Notes                     |
| -------------- | ------- | ------------------------- |
| Match Result   | 3       | FT, 1H, 2H                |
| Total Goals    | 3       | FT, 1H, 2H                |
| Team Totals    | 2       | Home, Away                |
| BTTS           | 2       | FT, 1H                    |
| Asian Handicap | 2       | FT, 1H                    |
| Corners        | 3       | Total, 1H Total, Handicap |
| Other          | 2       | DNB, Double Chance        |
| **Total**      | **17**  | All functional            |

### Mapping Function

```typescript
function mapBetConstructToAtom(
  marketType: string, // "P1XP2", "OverUnder", etc.
  selectionType: string, // "W1", "Over", "Yes", etc.
  selectionName: string, // Display name
  base?: number, // Line value
  displayKey?: string, // "WINNER", etc.
): string | null;
```

### Filtering Rules

1. **Skip outrights:** `!game.team2_name`
2. **Skip same-team matches:** `game.team1_name === game.team2_name`
3. **Skip invalid odds:** `price <= 1`
4. **Skip unsupported markets:** `!SUPPORTED_MARKET_TYPES.includes(marketType)`

---

## Code Examples

### Fetching Events

```typescript
import { betconstructAdapter } from "@/lib/adapters/betconstruct";

const events = await betconstructAdapter.fetchEvents();
// Returns: BetConstructNormalizedEvent[]
// Includes: liveInfo (scores), suspended status
```

### Fetching Markets for Event

```typescript
import { fetchAndStoreBetConstructOdds } from "@/lib/atoms/adapters/betconstruct";

const oddsCount = await fetchAndStoreBetConstructOdds(
  "29025881", // BetConstruct game ID
  "betconstruct-29025881", // Normalized event ID
  "NK Olimpija Ljubljana", // Home team
  "FC Rukh Lviv", // Away team
);
// Returns: number of odds entries stored
```

### Manual WebSocket Call

```typescript
import {
  fetchGameMarkets,
  disconnect,
} from "@/lib/adapters/betconstruct/client";

const game = await fetchGameMarkets(29025881);
console.log("Markets:", Object.keys(game?.market || {}).length);

// Clean up
disconnect();
```

---

## Files Reference

| File                                   | Purpose                                  |
| -------------------------------------- | ---------------------------------------- |
| `lib/adapters/betconstruct/client.ts`  | WebSocket client with `fetchAllEvents()` |
| `lib/adapters/betconstruct/index.ts`   | Event adapter (fetchEvents)              |
| `lib/adapters/betconstruct/schemas.ts` | Zod schemas for API responses            |
| `lib/atoms/adapters/betconstruct.ts`   | Odds fetching adapter                    |
| `lib/atoms/mappings/betconstruct.ts`   | Market type to atom ID mapping           |
| `lib/providers/registry.ts`            | Provider metadata (colors, display name) |

### Key Functions

| Function                            | File      | Description                                                         |
| ----------------------------------- | --------- | ------------------------------------------------------------------- |
| `fetchAllEvents()`                  | client.ts | Fetches ALL events (live, prematch, scheduled) with optimized query |
| `fetchGameMarkets()`                | client.ts | Fetches full markets/odds for a specific game                       |
| `betconstructAdapter.fetchEvents()` | index.ts  | Main entry point for event fetching                                 |

---

## Debugging

### Test Connection

```bash
npx tsx -e "
import { betconstructAdapter } from './lib/adapters/betconstruct';
betconstructAdapter.fetchEvents().then(e => {
  console.log('Events:', e.length);
  // Should return ~1590 events (including scheduled)
});
"
```

### Test Market Fetching

```bash
npx tsx -e "
import { fetchGameMarkets, disconnect } from './lib/adapters/betconstruct/client';
fetchGameMarkets(29025881).then(g => {
  console.log('Markets:', Object.keys(g?.market || {}).length);
  disconnect();
});
"
```

### Check Live Scores

```bash
npx tsx -e "
import { betconstructAdapter } from './lib/adapters/betconstruct';
betconstructAdapter.fetchEvents().then(events => {
  const live = events.filter(e => e.liveInfo?.isLive);
  live.slice(0, 5).forEach(e => {
    console.log(e.homeTeam, e.liveInfo?.score1, '-', e.liveInfo?.score2, e.awayTeam);
  });
});
"
```

---

## Validation Results

Last validated: 2026-02-14

### Event Fetching

| Metric                    | Value    |
| ------------------------- | -------- |
| Live Events (type=1)      | 83       |
| Prematch Events (type=0)  | 139      |
| Scheduled Events (type=2) | 1368     |
| **Total Events**          | **1590** |

> **Note:** Using the optimized query without game type filter returns ALL event types, including scheduled events which make up ~85% of available matches.

### Market Extraction

| Metric                   | Value                     |
| ------------------------ | ------------------------- |
| Total Markets (per game) | 58                        |
| Supported Market Types   | 17                        |
| Atoms Coverage           | ~50 unique lines/outcomes |

### Supported Atom Families

| Family             | Atom IDs                              |
| ------------------ | ------------------------------------- |
| `ft_match_result`  | ft_home_win, ft_draw, ft_away_win     |
| `ft_total_X_X`     | ft_total_over_X_X, ft_total_under_X_X |
| `ft_btts`          | ft_btts_yes, ft_btts_no               |
| `ft_ah_X`          | ft_home_ah_X, ft_away_ah_X            |
| `ft_double_chance` | ft_dc_1x, ft_dc_12, ft_dc_x2          |
| `1h_match_result`  | 1h_home_win, 1h_draw, 1h_away_win     |

---

## Comparison with Other Providers

| Feature           | BetConstruct    | Pinnacle      | NineWickets |
| ----------------- | --------------- | ------------- | ----------- |
| Auth Required     | No              | Yes (Browser) | No          |
| Protocol          | WebSocket       | HTTP          | HTTP        |
| Live Scores       | Yes             | Via WS        | No          |
| Markets per Game  | ~58             | ~30           | ~10         |
| Suspended Status  | Yes             | Yes           | No          |
| Real-time Updates | Yes (subscribe) | Yes (WS)      | No          |

---

## Notes

- **No browser automation needed** - Unlike Pinnacle, BetConstruct works without auth
- **WebSocket connection should stay open** - Reuses session across requests
- **Session caching** - Session ID is cached to avoid re-authentication
- **Polling recommended** - We use `subscribe: false` to fit our 60s sync cycle
- **Live scores included** - `info.score1`, `info.score2` available for live matches
- **Stats available** - Corners, cards, shots, possession tracked (for future use)
- **Optimized query** - Use `fetchAllEvents()` which is 40% faster than separate live/prematch queries
- **Include scheduled events** - Don't filter by `game.type` - most events are type=2 (scheduled)
