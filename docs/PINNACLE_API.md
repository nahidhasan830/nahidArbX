# Pinnacle API Documentation

> **Last Updated:** 2026-02-07
> **Verified With:** Automated validation of 20 random fixtures (681 markets, 100% match rate)

This document describes the Pinnacle (PSLive/ps388win) API structure used for fetching soccer betting odds.

---

## Table of Contents

1. [Authentication](#authentication)
2. [API Endpoints](#api-endpoints)
3. [Response Structure](#response-structure)
4. [Data Types](#data-types)
5. [Market Types](#market-types)
6. [Period Types](#period-types)
7. [Mapping Logic](#mapping-logic)
8. [Code Examples](#code-examples)

---

## Authentication

Pinnacle API requires a Bearer token obtained via browser automation through betjili.

### Token Flow

```
1. Check stored token (sessions/betjili/pinnacle-token.json) → Use if not expired
2. Try stored URL (sessions/betjili/pinnacle-url.txt) → Navigate directly if session valid
3. Use browser session (sessions/betjili/browser-state.json) → Click PINNACLE button
4. Full betjili login → Last resort
```

### Token File Structure

```json
{
  "token": "Bearer eyJhbGciOiJIUzI1...",
  "refreshToken": "Bearer eyJhbGciOiJIUzI1...",
  "capturedAt": "2026-02-07T11:52:33.058Z",
  "expiresAt": "2026-02-07T12:52:32.000Z"
}
```

**Token Lifetime:** ~1 hour
**Session Lifetime:** ~24 hours

---

## API Endpoints

### Base URL

```
https://www.ps388win.com
```

### 1. Events List

Fetches all soccer events with basic period info.

```
GET /proteus-member-service/after-login/odds/v3/events/{params}?keySearch=
```

**URL Parameters (path-based):**

| Parameter     | Example               | Description            |
| ------------- | --------------------- | ---------------------- |
| `odds-format` | `decimal`             | Odds format            |
| `view-mode`   | `ASIAN`               | View mode              |
| `sport-id`    | `29`                  | Soccer = 29            |
| `period-type` | `TODAY`               | Filter type            |
| `country-ids` | `ALL`                 | Country filter         |
| `league-ids`  | `ALL`                 | League filter          |
| `period-id`   | `-1`                  | All periods            |
| `market-type` | `ALL`                 | All markets            |
| `tz`          | `%2B06:00`            | Timezone (URL encoded) |
| `from-date`   | `2026-02-07T00:00:00` | Start date             |
| `to-date`     | `2026-02-09T23:59:59` | End date               |
| `sort-by`     | `LEAGUE`              | Sort order             |
| `page-no`     | `1`                   | Page number            |
| `page-size`   | `50`                  | Results per page       |
| `locale`      | `en-US`               | Language               |

### 2. Single Event Markets

Fetches all markets and odds for a specific event.

```
GET /proteus-member-service/after-login/odds/v3/event/decimal/{eventId}/locale/en-US
```

**Path Parameters:**

| Parameter | Description                           |
| --------- | ------------------------------------- |
| `eventId` | Pinnacle's internal event ID (number) |

---

## Response Structure

Both endpoints return similar top-level structure but differ in the `data` field.

### Top-Level Response

```typescript
{
  code: number,        // 200 = success
  errorCode: string,   // Empty on success
  message: string,     // Empty on success
  success: boolean,    // true on success
  data: [...]          // Payload (structure differs by endpoint)
}
```

### Events List Data Structure

```typescript
data: [
  pageNo: number,      // Current page (1-based)
  pageSize: number,    // Items per page
  totalCount: number,  // Total events
  sports: Sport[]      // Array of sports
]
```

### Single Event Data Structure

```typescript
data: Sport[]  // Direct array of sports (no pagination wrapper)
```

---

## Data Types

All data is returned as **positional tuples** (arrays with fixed positions), not objects.

### Sport Tuple (4 elements)

```typescript
[
  sportId: number,           // [0] 29 = Soccer
  sportName: string,         // [1] "Soccer"
  isActive: boolean,         // [2] true
  statusGroups: StatusGroup[] // [3] Array of status groups
]
```

### StatusGroup Tuple (2 elements)

```typescript
[
  status: string,      // [0] "LIVE" | "TODAY"
  leagues: League[]    // [1] Array of leagues
]
```

**Status Values:**

- `"LIVE"` - Currently in-play matches
- `"TODAY"` - Upcoming matches today

### League Tuple (4 elements)

```typescript
[
  leagueId: number,    // [0] e.g., 2592
  leagueName: string,  // [1] "Turkey - Super League"
  events: Event[],     // [2] Array of events
  unknown: any[]       // [3] Always empty array []
]
```

### Event Tuple (8 elements)

```typescript
[
  eventId: number,         // [0] Unique event identifier
  parentEventId: number,   // [1] Usually same as eventId
  homeTeam: string,        // [2] "Karagumruk"
  awayTeam: string,        // [3] "Antalyaspor"
  unknown4: number,        // [4] 0 or 1 (purpose unknown)
  periods: Period[],       // [5] Array of periods
  unknown6: string,        // [6] Always "A"
  periodSummaries: any[]   // [7] Summary data (not used)
]
```

### Period Tuple (7 elements)

```typescript
[
  periodId: number,        // [0] Period identifier
  parentEventId: number,   // [1] Event ID this period belongs to
  startTime: string,       // [2] ISO 8601 timestamp
  periodType: string,      // [3] "Regular" | "Corners" | "Bookings" etc.
  hasMarkets: boolean,     // [4] true if markets exist
  markets: Market[],       // [5] Array of markets
  unknown6: number         // [6] Purpose unknown (e.g., 2)
]
```

### Market Tuple (19 elements)

```typescript
[
  periodId: number,        // [0]  Period this market belongs to
  halfIndicator: number,   // [1]  0 = main line, 1+ = alternative lines
  marketId: number,        // [2]  Unique market identifier
  unknown3: number,        // [3]  Usually 1
  marketType: string,      // [4]  "MONEYLINE" | "TOTAL_POINTS" | "SPREAD" | "TEAM_TOTAL_POINTS"
  unknown5: boolean,       // [5]  Usually false
  maxStake: number,        // [6]  Maximum stake allowed (e.g., 5000)
  unknown7: number,        // [7]  Usually -1
  unknown8: number,        // [8]  Usually 0
  eventId: number,         // [9]  Parent event ID
  periodType: string,      // [10] "Regular" | "Corners" etc.
  score: number,           // [11] Some numeric value (e.g., 17)
  outcomes: Outcome[],     // [12] Array of betting outcomes
  handicap: number,        // [13] Line value (e.g., 2.5 for O/U 2.5)
  identifier: string,      // [14] Unique string identifier
  side: string,            // [15] "NONE" | "HOME" | "AWAY" (for team totals)
  status: string,          // [16] "OPEN" | "SUSPENDED" etc.
  fullIdentifier: string,  // [17] Extended identifier with more context
  timestamp: number        // [18] Unix timestamp in milliseconds
]
```

### Outcome Tuple (5 elements)

```typescript
[
  odds: number | null,         // [0] Decimal odds (e.g., 1.99)
  handicap: number | null,     // [1] Line value for this outcome
  side: string,                // [2] "HOME" | "AWAY" | "DRAW" | ""
  direction: string,           // [3] "OVER" | "UNDER" | ""
  originalOdds: number | null  // [4] Original odds (usually same as odds)
]
```

---

## Market Types

### MONEYLINE (Match Result / 1X2)

Three-way betting on match outcome.

```typescript
// Example: Karagumruk vs Antalyaspor
{
  marketType: "MONEYLINE",
  handicap: 0,
  side: "NONE",
  outcomes: [
    { odds: 1.444, side: "HOME", direction: "" },   // Home Win
    { odds: 3.93,  side: "DRAW", direction: "" },   // Draw
    { odds: 8.99,  side: "AWAY", direction: "" }    // Away Win
  ]
}
```

**Mapping:**

- `side="HOME"` → `ft_home_win` / `1h_home_win`
- `side="DRAW"` → `ft_draw` / `1h_draw`
- `side="AWAY"` → `ft_away_win` / `1h_away_win`

### TOTAL_POINTS (Over/Under Goals)

Betting on total goals in the match.

```typescript
// Example: Over/Under 2.5 Goals (half-goal line)
{
  marketType: "TOTAL_POINTS",
  handicap: 2.5,
  side: "NONE",
  outcomes: [
    { odds: 1.85, handicap: 2.5, side: "", direction: "OVER" },
    { odds: 1.95, handicap: 2.5, side: "", direction: "UNDER" }
  ]
}

// Example: Over/Under 2.25 Goals (quarter-goal/split line)
{
  marketType: "TOTAL_POINTS",
  handicap: 2.25,
  side: "NONE",
  outcomes: [
    { odds: 1.617, handicap: 2.25, side: "", direction: "OVER" },
    { odds: 2.24,  handicap: 2.25, side: "", direction: "UNDER" }
  ]
}
```

**Mapping:**

- `direction="OVER"` + `handicap=2.5` → `ft_total_over_2_5`
- `direction="UNDER"` + `handicap=2.5` → `ft_total_under_2_5`

**Available Lines from API:**

| Line Type              | Examples                                                         | Currently Mapped |
| ---------------------- | ---------------------------------------------------------------- | ---------------- |
| Half-goal (.5)         | 0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5                                | ✅ Yes           |
| Quarter-goal (.25/.75) | 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75, 4.25, 4.75, 5.25, 5.75 | ✅ Yes           |
| Whole number           | 1, 2, 3, 4, 5, 6                                                 | ✅ Yes           |

**Note:** Quarter-goal lines use Asian-style split settlement (half win/lose).

### SPREAD (Asian Handicap)

Handicap betting with no draw outcome.

```typescript
// Example: Asian Handicap 0 (Draw No Bet equivalent)
{
  marketType: "SPREAD",
  handicap: 0,
  side: "NONE",
  outcomes: [
    { odds: 1.99,  handicap: 0, side: "HOME", direction: "" },
    { odds: 1.892, handicap: 0, side: "AWAY", direction: "" }
  ]
}
```

**Mapping:**

- `side="HOME"` + `handicap=-0.5` → `ft_home_ah_m0_5`
- `side="AWAY"` + `handicap=-0.5` → `ft_away_ah_p0_5`

**Supported Lines:** -3 to +3 in 0.25 increments

#### Live Handicap Adjustment (Running Ball)

**IMPORTANT:** Pinnacle uses "running ball" handicaps for live events. The line applies from the current moment forward, ignoring the existing score.

| Provider            | Live Handicap Type | Meaning                                  |
| ------------------- | ------------------ | ---------------------------------------- |
| **Pinnacle**        | Running ball       | Line applies from current moment forward |
| **Other providers** | Full match         | Line applies to entire match result      |

**Example:** Score is 1-0, Pinnacle shows "Home +0.5"

- Running ball interpretation: Home can lose by 0.5 _from now_ (they're actually +1 ahead)
- Full match equivalent: Home +1.5

**Adjustment Formula:**

```
fullMatchLine = runningBallLine - (homeScore - awayScore)
```

**Examples (Score 0-1, away leading):**

- Home +0.5 (running) → +0.5 - (0-1) = Home +1.5 (full match)
- Home -0.5 (running) → -0.5 - (0-1) = Home +0.5 (full match)

**Examples (Score 1-0, home leading):**

- Home +0.5 (running) → +0.5 - (1-0) = Home -0.5 (full match)
- Home -0.5 (running) → -0.5 - (1-0) = Home -1.5 (full match)

This adjustment is applied automatically when live scores are available from the WebSocket feed. The adjusted line is used to map to the correct atom family for cross-provider arbitrage detection.

### TEAM_TOTAL_POINTS (Team Goals Over/Under)

Betting on goals scored by a specific team.

```typescript
// Example: Home Team Over/Under 1.5 Goals
{
  marketType: "TEAM_TOTAL_POINTS",
  handicap: 1.5,
  side: "HOME",  // <-- Note: side is at market level
  outcomes: [
    { odds: 1.806, handicap: 1.5, side: "HOME", direction: "OVER" },
    { odds: 2.02,  handicap: 1.5, side: "HOME", direction: "UNDER" }
  ]
}
```

**Mapping:**

- `side="HOME"` + `direction="OVER"` + `handicap=1.5` → `ft_home_over_1_5`
- `side="AWAY"` + `direction="UNDER"` + `handicap=0.5` → `ft_away_under_0_5`

---

## Period Types

| Pinnacle Period | Normalized Period | Used For       | Notes                                      |
| --------------- | ----------------- | -------------- | ------------------------------------------ |
| `Regular`       | `ft`              | Full Time      | Main match markets                         |
| `FT`            | `ft`              | Full Time      | Alternative label                          |
| `HT`            | `1h`              | First Half     | Half-time markets                          |
| `1H`            | `1h`              | First Half     | Alternative label                          |
| `Corners`       | `corners`         | Corner markets | ✅ TOTAL_POINTS, SPREAD, TEAM_TOTAL_POINTS |
| `Bookings`      | `bookings`        | Card markets   | ✅ TOTAL_POINTS, SPREAD                    |
| `2H`            | _(skipped)_       | Second Half    | Not commonly used                          |

**Corners Period Markets (supported):**

- TOTAL_POINTS: Lines 5-13.5
- SPREAD: Lines -6.5 to +6.5
- TEAM_TOTAL_POINTS: Lines 0.5-7.5

**Bookings Period Markets (supported):**

- TOTAL_POINTS: Lines 2.5-5.5
- SPREAD: Lines -1 to +1

---

## Half Indicator (Main vs Alternative Lines)

The `halfIndicator` field (index [1] in Market tuple) distinguishes main lines from alternatives.

| halfIndicator | Meaning                    | Example              |
| ------------- | -------------------------- | -------------------- |
| `0`           | Main line (primary market) | O/U 2.5 at best odds |
| `1+`          | Alternative lines          | O/U 1.5, 3.5, etc.   |

**Important:** Only `halfIndicator=0` markets are processed. Alternative lines are skipped to avoid duplicates.

---

## Mapping Logic

### Period Normalization

```typescript
function normalizePeriod(
  periodType: string,
): "ft" | "1h" | "corners" | "bookings" | null {
  switch (periodType) {
    case "Regular":
    case "FT":
      return "ft";
    case "HT":
    case "1H":
      return "1h";
    case "Corners":
      return "corners";
    case "Bookings":
      return "bookings";
    default:
      return null; // Skip 2H
  }
}
```

### Market to Atom ID

```typescript
function mapPinnacleToAtom(
  marketType: string, // "MONEYLINE", "TOTAL_POINTS", etc.
  periodType: string, // "Regular", "HT", etc.
  handicap: number, // Line value (e.g., 2.5)
  side: string, // "HOME", "AWAY", "DRAW"
  direction: string, // "OVER", "UNDER"
  marketSide?: string, // For TEAM_TOTAL_POINTS: "HOME" | "AWAY"
): string | null;
```

### Filtering Rules

1. **Skip non-OPEN markets:** `status !== "OPEN"`
2. **Skip alternative lines:** `halfIndicator !== 0`
3. **Skip invalid odds:** `odds === null || odds <= 1`
4. **Skip unsupported periods:** `periodType` not in ["Regular", "FT", "HT", "1H", "Corners", "Bookings"]

---

## Code Examples

### Fetching Events

```typescript
import { pinnacleAdapter } from "@/lib/adapters/pinnacle";

const events = await pinnacleAdapter.fetchEvents();
// Returns: NormalizedEvent[]
```

### Fetching Markets for Event

```typescript
import { fetchAndStorePinnacleOdds } from "@/lib/atoms/adapters/pinnacle";

const oddsCount = await fetchAndStorePinnacleOdds(
  "1623250498", // Pinnacle event ID
  "pinnacle-1623250498", // Normalized event ID
);
// Returns: number of odds entries stored
```

### Manual API Call

```typescript
import axios from "axios";

const token = "Bearer eyJhbG...";
const eventId = 1623250498;

const response = await axios.get(
  `https://www.ps388win.com/proteus-member-service/after-login/odds/v3/event/decimal/${eventId}/locale/en-US`,
  { headers: { Authorization: token } },
);
```

---

## Zod Schemas

All schemas use **exact tuple lengths** (no `.rest()` for flexibility).

```typescript
// Outcome: exactly 5 elements
const OutcomeSchema = z.tuple([
  z.number().nullable(), // odds
  z.number().nullable(), // handicap
  z.string(), // side
  z.string(), // direction
  z.number().nullable(), // originalOdds
]);

// Market: exactly 19 elements
const MarketSchema = z.tuple([
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.string(),
  z.boolean(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.string(),
  z.number(),
  z.array(OutcomeSchema),
  z.number(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.number(),
]);

// Period: exactly 7 elements
const PeriodSchema = z.tuple([
  z.number(),
  z.number(),
  z.string(),
  z.string(),
  z.boolean(),
  z.array(MarketSchema),
  z.number(),
]);

// Event: exactly 8 elements
const EventSchema = z.tuple([
  z.number(),
  z.number(),
  z.string(),
  z.string(),
  z.number(),
  z.array(PeriodSchema),
  z.string(),
  z.array(z.unknown()),
]);

// League: exactly 4 elements
const LeagueSchema = z.tuple([
  z.number(),
  z.string(),
  z.array(EventSchema),
  z.array(z.unknown()),
]);

// StatusGroup: exactly 2 elements
const StatusGroupSchema = z.tuple([z.string(), z.array(LeagueSchema)]);

// Sport: exactly 4 elements
const SportSchema = z.tuple([
  z.number(),
  z.string(),
  z.boolean(),
  z.array(StatusGroupSchema),
]);
```

---

## Files Reference

| File                                   | Purpose                              |
| -------------------------------------- | ------------------------------------ |
| `lib/adapters/pinnacle.ts`             | Main adapter for fetching events     |
| `lib/atoms/adapters/pinnacle.ts`       | Market fetching and odds extraction  |
| `lib/atoms/mappings/pinnacle.ts`       | Market type to atom ID mapping       |
| `lib/auth/token-manager.ts`            | Token capture via browser automation |
| `sessions/betjili/pinnacle-token.json` | Stored token (gitignored)            |
| `sessions/betjili/pinnacle-url.txt`    | Stored session URL (gitignored)      |
| `sessions/betjili/browser-state.json`  | Browser session state (gitignored)   |

---

## Debugging

### Analyze Market Structure

```bash
npx tsx scripts/analyze-saved-samples.ts
```

### Refresh Token Manually

```bash
TOKEN_HEADLESS=false npx tsx scripts/refresh-and-fetch.ts
```

### Check Token Expiry

```bash
cat sessions/betjili/pinnacle-token.json | jq '.expiresAt'
```

### Validate API Documentation

```bash
npx tsx scripts/validate-pinnacle-docs.ts
```

---

## Validation Results

Last validated: 2026-02-07 with 20 random fixtures (681 markets).

### Overall Match Rate

**100%** of processable markets mapped successfully (429/429).

### Atoms Registry

- **158 families**
- **318 atoms**

### Match Rates by Market Type

| Market Type       | Total | Matched | Match Rate              |
| ----------------- | ----- | ------- | ----------------------- |
| MONEYLINE         | 27    | 19      | **100%** (8 filtered)   |
| SPREAD            | 294   | 184     | **100%** (110 filtered) |
| TOTAL_POINTS      | 278   | 172     | **100%** (106 filtered) |
| TEAM_TOTAL_POINTS | 82    | 54      | **100%** (28 filtered)  |

### Match Rates by Period Type

| Period Type | Total | Matched | Match Rate |
| ----------- | ----- | ------- | ---------- |
| Regular     | 565   | 351     | **100%**   |
| Corners     | 114   | 76      | **100%**   |
| Bookings    | 2     | 2       | **100%**   |

### Supported Lines

**Corners Period:**

- Totals: 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5
- Handicap: -6.5 to +6.5 (0.5 increments)
- Team Totals: 0.5, 1.5, 2, 2.5, 3.5, 4.5, 5.5, 6.5, 7, 7.5

**Bookings Period:**

- Totals: 2.5, 3, 3.5, 4, 4.5, 5, 5.5
- Handicap: -1, -0.5, 0, +0.5, +1
