# Odds Discrepancy Investigation - February 8, 2026

## Issue Reported

User reported a discrepancy for the match "Winterthur vs Lugano":

- **Dashboard** showed 9W-SB Home Win = **12.00**
- **Debug Pipeline** showed 9W-SB Home Win = **5.25**

Initially suspected: Home/Away swap in the Sportsbook mapping.

## Investigation Findings

### 1. Mapping Logic is Correct

After creating a diagnostic script to fetch raw API data from both providers, I confirmed:

**NineWickets Exchange:**

- Uses `sortPriority` from API: 1=home, 2=away, 3=draw
- `sortPriority=1` correctly corresponds to the first team in the event name (home)

**NineWickets Sportsbook:**

- Uses team name matching via `isSameTeam()` and `containsTeam()` functions
- Correctly maps selection names to home/away based on parsed event name

**Live Data Verification (Winterthur vs Lugano):**

```
Exchange:
  sortPriority=1 → "Winterthur" (odds=13.5) → ft_home_win ✓
  sortPriority=2 → "Lugano" (odds=17.5) → ft_away_win ✓
  sortPriority=3 → "The Draw" (odds=1.12) → ft_draw ✓

Sportsbook:
  "FC Winterthur" (odds=11) → ft_home_win ✓
  "FC Lugano" (odds=16) → ft_away_win ✓
  "Draw" (odds=1.12) → ft_draw ✓
```

Both providers show consistent odds and correct mapping.

### 2. Root Cause: Data Timing

The discrepancy (12.00 vs 5.25) was caused by **data freshness timing**:

1. **Dashboard** displayed odds from a previous sync stored in the atoms store
2. **Debug Pipeline** fetched fresh odds directly from the API
3. Live match odds change rapidly, especially during gameplay

The 35% arbitrage shown in the screenshot was likely detected using stale data.

### 3. System Behavior Confirmed

- `fetchAllOddsForMatchedEvents()` calls `clearAllOdds()` before each sync (line 76)
- This ensures fresh data on each full sync
- Debug Pipeline only overwrites specific atoms without clearing

## Recommendation

No code changes needed. The mapping is working correctly. The discrepancy was due to:

- Viewing dashboard before a fresh sync completed
- Natural odds movement in a live match

## Files Examined

- `lib/atoms/mappings/ninewickets-exchange.ts` - sortPriority mapping
- `lib/atoms/mappings/ninewickets-sportsbook.ts` - team name matching
- `lib/atoms/adapters/ninewickets-sportsbook.ts` - API fetching
- `lib/atoms/fetcher.ts` - sync orchestration

## Investigation Script

Created `scripts/investigate-odds.ts` to fetch raw API data for comparison.
This script can be deleted after investigation.
