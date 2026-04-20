# NineWickets Exchange API Documentation

> **Last Updated:** 2026-02-07
> **Provider:** NineWickets Exchange (separate provider from Sportsbook)

This document describes the NineWickets Exchange API structure used for fetching soccer betting odds.

---

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [API Endpoints](#api-endpoints)
4. [Response Structure](#response-structure)
5. [Market Types](#market-types)
6. [Mapping Logic](#mapping-logic)
7. [Code Examples](#code-examples)

---

## Overview

NineWickets Exchange is treated as a **separate provider** from NineWickets Sportsbook. This enables:

- Independent event fetching and matching
- Arbitrage detection between Exchange and Sportsbook
- Cleaner provider-level status tracking

**Exchange Markets (4 total):**
| Market Type | Description |
|-------------|-------------|
| `MATCH_ODDS` | 1x2 (Home, Draw, Away) |
| `OVER_UNDER_05` | Over/Under 0.5 Goals |
| `OVER_UNDER_15` | Over/Under 1.5 Goals |
| `OVER_UNDER_25` | Over/Under 2.5 Goals |

---

## Authentication

**No authentication required.** The Exchange API is publicly accessible.

---

## API Endpoints

### Base URLs

| Purpose | URL                          |
| ------- | ---------------------------- |
| Events  | `https://gakvx.seofmi.live`  |
| Markets | `https://awskvx.seofmi.live` |

### 1. Events List (Fixtures)

Fetches all soccer events (live and upcoming).

```
POST /exchange/member/playerService/queryEvents
Content-Type: application/x-www-form-urlencoded
```

**Request Parameters:**

| Parameter         | Value      | Description            |
| ----------------- | ---------- | ---------------------- |
| `type`            | `1` or `6` | 1 = Live, 6 = Upcoming |
| `eventType`       | `1`        | Football               |
| `competitionTs`   | `-1`       | All competitions       |
| `eventTs`         | `-1`       | All events             |
| `marketTs`        | `-1`       | All markets            |
| `selectionTs`     | `-1`       | All selections         |
| `collectEventIds` | ``         | Empty string           |

**Note:** Both type=1 (live) and type=6 (upcoming) are fetched in parallel.

### 2. Markets (Odds)

Fetches all markets and odds for a specific event.

```
POST /exchange/member/playerService/queryMarkets
Content-Type: application/x-www-form-urlencoded
```

**Request Parameters:**

| Parameter     | Value  | Description          |
| ------------- | ------ | -------------------- |
| `eventId`     | `{id}` | Event ID from step 1 |
| `selectionTs` | `0`    | Get all selections   |

---

## Response Structure

### Events Response

```typescript
{
  events: [
    {
      eventId: number,           // Unique event ID
      eventName: string,         // "Team A v Team B"
      competitionId: number,     // Competition identifier
      competitionName: string,   // "England - Premier League"
      openDateTime: number,      // Unix timestamp (ms)
      eventType: number,         // 1 = Football
      status: number,            // Event status
      market?: unknown           // Optional market data
    }
  ]
}
```

### Markets Response

```typescript
{
  markets: [
    {
      eventId: number,
      marketId: string,
      marketType: string,        // "MATCH_ODDS", "OVER_UNDER_05", etc.
      marketName: string,
      status: number,
      selections?: [
        {
          selectionId: number,
          runnerName: string,    // "Home", "Away", "Draw", "Over X.X", "Under X.X"
          sortPriority: number,  // 1=home, 2=away, 3=draw
          status: number,
          availableToBack?: [    // Best back odds
            { price: number, size: number }
          ],
          availableToLay?: [     // Best lay odds (not used)
            { price: number, size: number }
          ]
        }
      ]
    }
  ]
}
```

---

## Market Types

### MATCH_ODDS (1x2)

Three-way betting on match outcome. Selection determined by `sortPriority`.

| sortPriority | Selection | Atom ID       |
| ------------ | --------- | ------------- |
| 1            | Home      | `ft_home_win` |
| 2            | Away      | `ft_away_win` |
| 3            | Draw      | `ft_draw`     |

### OVER_UNDER_05 / OVER_UNDER_15 / OVER_UNDER_25

Two-way betting on total goals. Selection determined by `runnerName`.

| Market Type     | Over Atom           | Under Atom           |
| --------------- | ------------------- | -------------------- |
| `OVER_UNDER_05` | `ft_total_over_0_5` | `ft_total_under_0_5` |
| `OVER_UNDER_15` | `ft_total_over_1_5` | `ft_total_under_1_5` |
| `OVER_UNDER_25` | `ft_total_over_2_5` | `ft_total_under_2_5` |

---

## Mapping Logic

### Event ID Format

```
ninewickets-exchange-{eventId}
```

Example: `ninewickets-exchange-12345678`

### Market to Atom Mapping

```typescript
function mapExchangeToAtom(
  marketType: string,
  sortPriority: number,
  runnerName: string,
): string | null {
  switch (marketType) {
    case "MATCH_ODDS":
      // sortPriority: 1=home, 2=away, 3=draw
      return MATCH_RESULT_ATOMS[sortPriority] || null;

    case "OVER_UNDER_05":
    case "OVER_UNDER_15":
    case "OVER_UNDER_25":
      // Extract direction from runnerName
      const direction = runnerName.toLowerCase().includes("over")
        ? "over"
        : "under";
      return TOTALS_ATOMS[marketType][direction];

    default:
      return null;
  }
}
```

### Filtering Rules

1. **Skip empty selections:** `!selections || selections.length === 0`
2. **Skip missing back prices:** `!availableToBack || availableToBack.length === 0`
3. **Skip invalid odds:** `odds <= 1`
4. **Skip unmapped markets:** `atomId === null`

---

## Code Examples

### Fetching Events

```typescript
import { ninewicketsExchangeAdapter } from "@/lib/adapters/ninewickets-exchange";

const events = await ninewicketsExchangeAdapter.fetchEvents();
// Returns: NormalizedEvent[]
```

### Fetching Markets for Event

```typescript
import { fetchMarkets } from "@/lib/adapters/ninewickets-exchange";

const markets = await fetchMarkets("12345678");
// Returns: NormalizedMarket[]
```

### Storing Odds in Atoms

```typescript
import { fetchAndStoreNwExchangeOdds } from "@/lib/atoms/adapters/ninewickets-exchange";

const oddsCount = await fetchAndStoreNwExchangeOdds(
  "12345678", // Provider event ID
  "ninewickets-exchange-12345678", // Normalized event ID
);
// Returns: number of odds entries stored
```

---

## Files Reference

| File                                         | Purpose                         |
| -------------------------------------------- | ------------------------------- |
| `lib/adapters/ninewickets-exchange.ts`       | Event + market fetching adapter |
| `lib/atoms/adapters/ninewickets-exchange.ts` | Odds storage adapter            |
| `lib/atoms/mappings/ninewickets-exchange.ts` | Market type to atom ID mapping  |

---

## Debugging

### Debug Endpoints

| Endpoint                                  | Purpose              |
| ----------------------------------------- | -------------------- |
| `/api/debug-machine/ninewickets-fixtures` | Test event fetching  |
| `/api/debug-machine/nw-exchange-markets`  | Test market fetching |

### Test Event Fetching

```bash
curl -X POST http://localhost:3000/api/debug-machine/ninewickets-fixtures
```

### Test Market Fetching

```bash
curl -X POST http://localhost:3000/api/debug-machine/nw-exchange-markets \
  -H "Content-Type: application/json" \
  -d '{"eventId": "12345678", "normalizedEventId": "ninewickets-exchange-12345678"}'
```
