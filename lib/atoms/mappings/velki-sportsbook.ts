/**
 * Velki Sportsbook → atoms mapping.
 *
 * Velki and 9W Sportsbook are sister deployments of the same Genius
 * Sports platform. Verified empirically (scripts/test-velki-mapping-
 * verify.ts, 2026-04-26): all market name conventions, selection
 * naming, line / handicap formatting are identical. Markets that the
 * 9W mapping handles (Match Result, Asian Handicap, Total Cards O/U,
 * Team Total Cards, Draw No Bet, Second Half Result, Odd/Even, etc.)
 * map identically for Velki — zero invalid atoms produced.
 *
 * Notable difference: Velki does NOT expose `apiSiteMarketType` on
 * its market objects (always undefined). The 9W mapping uses that
 * field to override time-scope detection for known HT market types;
 * for Velki we fall back to name-prefix matching ("Second Half ...",
 * "Half-Time ...") which works correctly for the markets we map.
 * If apiSiteMarketType ever appears on Velki responses, we'll get a
 * free accuracy boost — no code change needed.
 *
 * Unmapped market families (Last Goalscorer, Anytime Goalscorer, Hat-
 * trick, Correct Score, Half-time/Full-time, European 3-way
 * Handicap, Total Goals Bands, etc.) are intentionally unsupported
 * across the entire codebase, not a Velki-specific gap.
 */

export {
  mapSportsbookToAtom,
  extractSportsbookOdds,
  SPORTSBOOK_MARKET_TYPES,
} from "./ninewickets-sportsbook";

export type {
  SportsbookSelection,
  SportsbookMarket,
  SportsbookMarketType,
} from "./ninewickets-sportsbook";
