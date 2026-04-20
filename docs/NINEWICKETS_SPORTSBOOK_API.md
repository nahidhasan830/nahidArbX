# NineWickets Sportsbook API Documentation

> **Last Updated:** 2026-02-14
> **Provider:** NineWickets Sportsbook (separate provider from Exchange)

This document describes the NineWickets Sportsbook API structure used for fetching soccer betting odds.

---

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [API Endpoints](#api-endpoints)
4. [Response Structure](#response-structure)
5. [Market Types](#market-types)
6. [Mapping Logic](#mapping-logic)
7. [Team Position Verification](#team-position-verification)
8. [Code Examples](#code-examples)

---

## Overview

NineWickets Sportsbook is treated as a **separate provider** from NineWickets Exchange. This enables:

- Arbitrage detection between Exchange and Sportsbook odds
- Independent odds tracking per provider
- Cleaner provider-level status tracking

**Key Difference from Exchange:** Sportsbook uses a **2-step API flow**:

1. **Catalog Request** (version=0) - Get market structure without odds
2. **Odds Request** (with marketIds) - Get actual odds for markets

**Fixture Reuse:** Sportsbook uses the **same eventId** as Exchange from the fixtures API, so fixture data is reused.

**Dynamic Market Detection:** The implementation uses pattern matching on market names to automatically detect and map any supported market type.

---

## Authentication

**No authentication required.** The Sportsbook API is publicly accessible.

---

## API Endpoints

### Base URL

```
https://gakvx.seofmi.live
```

### Endpoint

```
POST /exchange/member/playerService/queryGeniusSportsEvent
Content-Type: application/x-www-form-urlencoded
```

The same endpoint is used for both catalog and odds requests, differentiated by parameters.

---

### Step 1: Catalog Request

Get market structure without odds. Required to obtain `marketIds` and `version` for the odds request.

**Request Parameters:**

| Parameter         | Value  | Description                |
| ----------------- | ------ | -------------------------- |
| `apiSiteType`     | `5`    | Sportsbook type            |
| `eventId`         | `{id}` | Event ID from fixtures API |
| `version`         | `0`    | Initial request (no cache) |
| `marketIds`       | `,`    | Empty (get all markets)    |
| `selectionTsList` | `,`    | Empty (get all selections) |
| `isDynamicUpdate` | `0`    | Full response              |

**Example:**

```bash
curl 'https://gakvx.seofmi.live/exchange/member/playerService/queryGeniusSportsEvent' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-raw 'apiSiteType=5&eventId=35188753&version=0&marketIds=,&selectionTsList=,&isDynamicUpdate=0'
```

---

### Step 2: Odds Request

Get actual odds using market IDs and timestamps from the catalog response.

**Request Parameters:**

| Parameter         | Value              | Description                             |
| ----------------- | ------------------ | --------------------------------------- |
| `apiSiteType`     | `5`                | Sportsbook type                         |
| `eventId`         | `{id}`             | Event ID from fixtures API              |
| `version`         | `{ts}`             | Version timestamp from catalog          |
| `marketIds`       | `{id1},{id2},...,` | Comma-separated market IDs from catalog |
| `selectionTsList` | `{ts1},{ts2},...,` | Comma-separated selection timestamps    |
| `isDynamicUpdate` | `0`                | Full response                           |

**Example:**

```bash
curl 'https://gakvx.seofmi.live/exchange/member/playerService/queryGeniusSportsEvent' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-raw 'apiSiteType=5&eventId=35188753&version=1738956289683&marketIds=1234,5678,&selectionTsList=-1,-1,&isDynamicUpdate=0'
```

---

## Response Structure

### Catalog Response

```typescript
{
  eventId: number,
  eventName: string,           // "Home Team v Away Team"
  version: number,             // Timestamp for odds request
  live: boolean,               // true if event is in-play
  geniusSportsMarkets: [
    {
      id: string,              // Market ID (use in odds request)
      marketName: string,      // "Match Result", "Over/Under 2.5", etc.
      apiSiteMarketType: number, // Market type code
      selectionTs: number,     // Selection timestamp
      live: boolean,           // true if market is for in-play
      geniusSportsSelection?: [] // Empty in catalog
    }
  ]
}
```

### Odds Response

```typescript
{
  eventId: number,
  eventName: string,
  version: number,
  live: boolean,               // true if event is in-play
  geniusSportsMarkets: [
    {
      id: string,
      marketName: string,
      apiSiteMarketType: number,
      live: boolean,           // true if market is for in-play
      geniusSportsSelection: [
        {
          selectionName: string,     // "Home Team", "Over", "Yes", etc.
          odds: number,              // Decimal odds (e.g., 1.85)
          handicap: number,          // Always 0 (line is in marketName)
          isActive: boolean,
          apiSiteSelectionId: string
        }
      ]
    }
  ]
}
```

---

## Market Types

The implementation uses **dynamic market detection** based on market name patterns. All markets are processed and mapped if they match our atoms registry.

### Core Markets (High Priority)

| apiSiteMarketType | Market Name Pattern     | Atom Format                                                  | Time Scopes |
| ----------------- | ----------------------- | ------------------------------------------------------------ | ----------- |
| `2`               | Match Result, 1x2       | `{time}_home_win`, `{time}_draw`, `{time}_away_win`          | FT, 1H, 2H  |
| `82`              | Asian Handicap          | `{time}_home_ah_{signedLine}`, `{time}_away_ah_{signedLine}` | FT, 1H      |
| `259`             | Over/Under, Total Goals | `{time}_total_over_{line}`, `{time}_total_under_{line}`      | FT, 1H, 2H  |
| `7079`            | Both Teams To Score     | `{time}_btts_yes`, `{time}_btts_no`                          | FT, 1H      |

### Additional Supported Markets

| Market Name Pattern | Atom Format                                                                  | Time Scopes |
| ------------------- | ---------------------------------------------------------------------------- | ----------- |
| Draw No Bet         | `{time}_dnb_home`, `{time}_dnb_away`                                         | FT, 1H, 2H  |
| Double Chance       | `{time}_dc_1x`, `{time}_dc_12`, `{time}_dc_x2`                               | FT, 1H, 2H  |
| Team Total Goals    | `{time}_{team}_over_{line}`, `{time}_{team}_under_{line}`                    | FT          |
| Corners Over/Under  | `{time}_corners_over_{line}`, `{time}_corners_under_{line}`                  | FT          |
| Corner Handicap     | `{time}_corners_home_ah_{signedLine}`, `{time}_corners_away_ah_{signedLine}` | FT          |
| Total Cards         | `{time}_cards_over_{line}`, `{time}_cards_under_{line}`                      | FT          |
| Odd/Even Goals      | `{time}_goals_odd`, `{time}_goals_even`                                      | FT          |
| Clean Sheet         | `{time}_home_cs_yes`, `{time}_home_cs_no`                                    | FT          |
| Win To Nil          | `{time}_home_wtn_yes`, `{time}_home_wtn_no`                                  | FT          |

### Coverage Summary (18 Market Types)

| Category          | Markets | Time Scopes | Notes            |
| ----------------- | ------- | ----------- | ---------------- |
| Match Result      | 1       | FT, 1H, 2H  | 1x2              |
| Total Goals       | 1       | FT, 1H, 2H  | Over/Under       |
| Asian Handicap    | 1       | FT, 1H, 2H  | Signed lines     |
| European Handicap | 1       | FT, 2H      | 3-way with Tie   |
| BTTS              | 1       | FT, 1H, 2H  | Yes/No           |
| DNB               | 1       | FT, 1H, 2H  | Draw No Bet      |
| Double Chance     | 1       | FT, 1H, 2H  | 1X/12/X2         |
| Team Totals       | 1       | FT          | Home/Away O/U    |
| Corners           | 2       | FT          | Total + Handicap |
| Cards             | 1       | FT          | Total O/U        |
| Odd/Even          | 1       | FT          | Goals parity     |
| Clean Sheet       | 1       | FT          | Home/Away        |
| Win To Nil        | 1       | FT          | Home/Away        |
| **Total**         | **18**  |             |                  |

### Time Scope Detection

| Pattern in Market Name                | Time Scope | Prefix |
| ------------------------------------- | ---------- | ------ |
| "Half-time", "1st Half", "First Half" | 1H         | `1h_`  |
| "Second Half", "2nd Half"             | 2H         | `2h_`  |
| (default)                             | FT         | `ft_`  |

---

## Mapping Logic

### Asian Handicap Line Format (IMPORTANT)

Asian Handicap atoms use a **signed line format** with `m` (minus) or `p` (plus) prefix:

| Market Line | Home Atom          | Away Atom          |
| ----------- | ------------------ | ------------------ |
| -0.5        | `ft_home_ah_m0_5`  | `ft_away_ah_p0_5`  |
| +0.5        | `ft_home_ah_p0_5`  | `ft_away_ah_m0_5`  |
| -1.25       | `ft_home_ah_m1_25` | `ft_away_ah_p1_25` |
| +2.5        | `ft_home_ah_p2_5`  | `ft_away_ah_m2_5`  |

**Key Rule:** Home team uses the line as-is, Away team uses the opposite sign.

### Line Extraction

```typescript
// Extract signed line for handicaps
function extractSignedLine(marketName: string): number | null {
  const match = marketName.match(/([+-]?\d+\.?\d*)\s*$/);
  if (!match) return null;
  return parseFloat(match[1]); // Preserves sign
}

// Format for atom ID
function formatHandicapLine(line: number): string {
  if (line === 0) return "0";
  const prefix = line < 0 ? "m" : "p";
  const absLine = Math.abs(line).toString().replace(".", "_");
  return `${prefix}${absLine}`;
}
```

### Team Name Matching

Selection names are matched against team names using **fuzzy matching** with multiple strategies:

```typescript
function isSameTeam(selectionName: string, teamName: string): boolean {
  const similarity = stringSimilarity.compareTwoStrings(
    selectionName.toLowerCase(),
    teamName.toLowerCase(),
  );
  return similarity >= 0.5; // Lowered threshold for variations
}

function containsTeam(selectionName: string, teamName: string): boolean {
  // Bidirectional substring check
  // Word boundary matching (4+ char words)
  // Common prefix matching (4+ chars)
}
```

**Matching Strategies (in order):**

1. Direct string similarity (threshold: 0.5)
2. Bidirectional substring match
3. Word-level matching (words > 3 chars)
4. Common prefix matching (4+ chars)

---

## Team Position Verification

### Using 1x2 Market for Cross-Verification

The **Match Result (1x2) market** serves as the source of truth for team positions:

```typescript
function extractCanonicalTeams(
  markets: Market[],
): { home: string; away: string } | null {
  const matchResult = markets.find((m) => m.apiSiteMarketType === 2);
  if (!matchResult?.geniusSportsSelection) return null;

  const selections = matchResult.geniusSportsSelection;
  const nonDraw = selections.filter(
    (s) => s.selectionName.toLowerCase() !== "draw",
  );

  return {
    home: nonDraw[0].selectionName, // First non-Draw is HOME
    away: nonDraw[1].selectionName, // Second non-Draw is AWAY
  };
}
```

This allows verification of Asian Handicap team positions against the canonical 1x2 positions.

---

## Code Examples

### Fetching Events (Reuses Exchange)

```typescript
import { ninewicketsSportsbookAdapter } from "@/lib/adapters/ninewickets-sportsbook";

const events = await ninewicketsSportsbookAdapter.fetchEvents();
// Returns: NormalizedEvent[] (same as Exchange, re-tagged)
```

### Storing Odds in Atoms

```typescript
import { fetchAndStoreNwSportsbookOdds } from "@/lib/atoms/adapters/ninewickets-sportsbook";

const oddsCount = await fetchAndStoreNwSportsbookOdds(
  "35188753", // Provider event ID
  "ninewickets-sportsbook-35188753", // Normalized event ID
);
// Returns: number of odds entries stored
```

### Dynamic Market Mapping

```typescript
import {
  mapSportsbookToAtom,
  parseTeams,
} from "@/lib/atoms/mappings/ninewickets-sportsbook";

const teams = parseTeams(eventName); // { home: "Man City", away: "Liverpool" }

const atomId = mapSportsbookToAtom(
  market.apiSiteMarketType,
  selection.selectionName,
  market.marketName,
  teams.home,
  teams.away,
);

// Example results:
// "Asian Handicap -0.5" + "Man City" → "ft_home_ah_m0_5"
// "Asian Handicap -0.5" + "Liverpool" → "ft_away_ah_p0_5"
// "Over/Under 2.5" + "Over" → "ft_total_over_2_5"
// "Both Teams To Score" + "Yes" → "ft_btts_yes"
// "Double Chance" + "Home or Draw" → "ft_dc_1x"
// "Second Half Draw No Bet" + "Man City" → "2h_dnb_home"
// "Man City Goals Over / Under 1.5" + "Over" → "ft_home_over_1_5"
// "Second Half Both Teams to Score" + "Yes" → "2h_btts_yes"
```

---

## Files Reference

| File                                           | Purpose                                |
| ---------------------------------------------- | -------------------------------------- |
| `lib/adapters/ninewickets-sportsbook.ts`       | Event adapter (delegates to Exchange)  |
| `lib/atoms/adapters/ninewickets-sportsbook.ts` | Odds fetching (2-step flow)            |
| `lib/atoms/mappings/ninewickets-sportsbook.ts` | Dynamic market type to atom ID mapping |

---

## Filtering Rules

1. **Skip empty markets:** `!geniusSportsMarkets || geniusSportsMarkets.length === 0`
2. **Skip empty selections:** `!geniusSportsSelection || geniusSportsSelection.length === 0`
3. **Skip inactive selections:** `isActive === false`
4. **Skip invalid odds:** `odds <= 1`
5. **Skip unmappable markets:** `mapSportsbookToAtom()` returns `null`
6. **Validate atom exists:** `isValidAtom(atomId)` must be `true`
7. **Filter by live status:** Match `market.live` to the event-level `live` property to avoid duplicate markets (see [Market Deduplication](#market-deduplication))

---

## Market Deduplication

The `geniusSportsMarkets` array contains **duplicate markets** — one for pre-match (`live: false`) and one for in-play (`live: true`). For example, "Asian Handicap +0.25" appears twice with different `id` values but the same `apiSiteMarketId`. Processing both sets causes duplicate atom entries where the last write wins.

**Solution:** Use the event-level `live` property to filter markets:

```typescript
const isEventLive = catalog.live ?? false;
const markets = allMarkets.filter((m) => (m.live ?? false) === isEventLive);
```

- If the event is **pre-match** (`live: false`), only use markets with `live: false`
- If the event is **in-play** (`live: true`), only use markets with `live: true`

This filtering is applied **before** the odds API call, which also reduces the payload size by roughly half.

---

## Validation

Run the validation script to test mapping accuracy:

```bash
npx tsx scripts/validate-nw-sportsbook.ts
```

Expected output:

- **Core markets (1x2, AH, O/U, BTTS):** 95%+ mapping rate
- **Team verification:** All fixtures verified via 1x2 cross-check
- **Tabular output** showing fixture summary, market breakdown, and handicap verification samples
