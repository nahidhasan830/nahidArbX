/**
 * NW Sportsbook Debug Script
 *
 * Wrapper to test market mapping with breakpoint debugging support.
 * Reads raw data from rawData/nwSbRawResponse.json
 */

import * as fs from "fs";
import { mapSportsbookToAtom } from "../lib/atoms/mappings/ninewickets-sportsbook";
import { matchTeamSide, getTeamMatchScore } from "../lib/shared/team-matching";

// ============================================
// Configuration
// ============================================

const RAW_DATA_PATH = "rawData/nwSbRawResponse.json";

// ============================================
// Helper: Parse event name to extract teams
// ============================================

function parseEventName(
  eventName: string,
): { home: string; away: string } | null {
  const separators = [/ v /i, / vs /i, / - /];
  for (const sep of separators) {
    const parts = eventName.split(sep);
    if (parts.length === 2) {
      return { home: parts[0].trim(), away: parts[1].trim() };
    }
  }
  return null;
}

// ============================================
// Main Debug Function
// ============================================

/**
 * Debug a specific market from raw data
 * SET BREAKPOINT HERE or inside mapSportsbookToAtom
 *
 * @param marketName - Market name to debug (e.g., "Match Result")
 * @param overrideHome - Override home team name (for testing Pinnacle names)
 * @param overrideAway - Override away team name (for testing Pinnacle names)
 */
function debugMarket(
  marketName: string,
  overrideHome?: string,
  overrideAway?: string,
) {
  // Load raw data
  if (!fs.existsSync(RAW_DATA_PATH)) {
    console.error(`Raw data not found: ${RAW_DATA_PATH}`);
    console.error(
      "Copy raw response from browser DevTools to this file first.",
    );
    return;
  }

  const rawData = JSON.parse(fs.readFileSync(RAW_DATA_PATH, "utf-8"));

  // Extract event info
  const eventName = rawData.eventName || "Unknown";
  const teams = parseEventName(eventName);
  const homeTeam = overrideHome || teams?.home || "Unknown";
  const awayTeam = overrideAway || teams?.away || "Unknown";

  console.log("=".repeat(60));
  console.log("NW Sportsbook Debug");
  console.log("=".repeat(60));
  console.log(`Event: ${eventName}`);
  console.log(`Home: ${homeTeam}${overrideHome ? " (OVERRIDE)" : ""}`);
  console.log(`Away: ${awayTeam}${overrideAway ? " (OVERRIDE)" : ""}`);
  console.log("=".repeat(60));

  // Find the target market
  const markets = rawData.geniusSportsMarkets || [];
  const market = markets.find(
    (m: { marketName: string }) =>
      m.marketName.toLowerCase() === marketName.toLowerCase(),
  );

  if (!market) {
    console.log(`\nMarket "${marketName}" not found.`);
    console.log("\nAvailable markets:");
    markets.slice(0, 20).forEach((m: { marketName: string }) => {
      console.log(`  - ${m.marketName}`);
    });
    return;
  }

  console.log(`\n=== ${market.marketName} ===`);
  console.log(`  apiSiteMarketType: ${market.apiSiteMarketType}`);
  console.log(`  apiSiteStatus: ${market.apiSiteStatus || "N/A"}`);

  const selections = market.geniusSportsSelection || [];
  console.log(`  selections: ${selections.length}`);
  console.log("");

  for (const sel of selections) {
    // >>> SET BREAKPOINT ON THIS LINE <<<
    const atomId = mapSportsbookToAtom(
      market.apiSiteMarketType,
      sel.selectionName,
      market.marketName,
      homeTeam,
      awayTeam,
    );

    // Show team matching scores for debugging
    const homeScore = getTeamMatchScore(sel.selectionName, homeTeam);
    const awayScore = getTeamMatchScore(sel.selectionName, awayTeam);
    const side = matchTeamSide(sel.selectionName, homeTeam, awayTeam);

    const status = sel.isActive ? "ACTIVE" : "INACTIVE";
    const icon = atomId ? "✅" : "⚠️";
    console.log(
      `  ${icon} ${sel.selectionName}: odds=${sel.odds} [${status}] → ${atomId || "NULL"}`,
    );
    console.log(
      `      Match scores: home=${homeScore.toFixed(3)} away=${awayScore.toFixed(3)} → ${side || "NULL"}`,
    );
  }
}

/**
 * List all markets in raw data
 */
function listMarkets() {
  if (!fs.existsSync(RAW_DATA_PATH)) {
    console.error(`Raw data not found: ${RAW_DATA_PATH}`);
    return;
  }

  const rawData = JSON.parse(fs.readFileSync(RAW_DATA_PATH, "utf-8"));
  const markets = rawData.geniusSportsMarkets || [];

  console.log("=".repeat(60));
  console.log(`Found ${markets.length} markets:`);
  console.log("=".repeat(60));

  for (const m of markets) {
    const status =
      m.apiSiteStatus === "OPEN"
        ? "🟢"
        : m.apiSiteStatus === "SUSPENDED"
          ? "🟡"
          : "🔴";
    console.log(`${status} ${m.marketName}`);
  }
}

// ============================================
// CLI Entry Point
// ============================================

const args = process.argv.slice(2);

if (args.includes("--list")) {
  listMarkets();
} else {
  // Parse --home and --away flags for team name overrides
  let overrideHome: string | undefined;
  let overrideAway: string | undefined;
  const filteredArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--home" && args[i + 1]) {
      overrideHome = args[++i];
    } else if (args[i] === "--away" && args[i + 1]) {
      overrideAway = args[++i];
    } else {
      filteredArgs.push(args[i]);
    }
  }

  const marketName =
    filteredArgs.length > 0 ? filteredArgs.join(" ") : "Match Result";
  debugMarket(marketName, overrideHome, overrideAway);
}

/*
============================================
USAGE
============================================

1. SETUP: Copy raw NW Sportsbook API response to:
   rawData/nwSbRawResponse.json

2. RUN FROM TERMINAL:
   npx tsx scripts/NW_SB_DEBUG.ts                    # Debug "Match Result"
   npx tsx scripts/NW_SB_DEBUG.ts "Draw No Bet"     # Debug specific market
   npx tsx scripts/NW_SB_DEBUG.ts --list            # List all markets

3. TEST WITH DIFFERENT TEAM NAMES (simulate Pinnacle names):
   npx tsx scripts/NW_SB_DEBUG.ts "Match Result" --home "Neftchi" --away "Qabala"

   This helps debug why UI shows different results - the NormalizedEvent
   uses team names from Pinnacle which may differ from NW Sportsbook names.

4. DEBUG WITH BREAKPOINTS (VSCode):
   a) Open this file in VSCode
   b) Set breakpoint on line with mapSportsbookToAtom() call
   c) Open Command Palette (Cmd+Shift+P)
   d) Select "Debug: JavaScript Debug Terminal"
   e) In that terminal, run: npx tsx scripts/NW_SB_DEBUG.ts "Match Result"
   f) Debugger will pause at your breakpoint
   g) Step into mapSportsbookToAtom to trace the mapping

5. ALTERNATIVE DEBUG (VSCode launch.json):
   Add to .vscode/launch.json:
   {
     "type": "node",
     "request": "launch",
     "name": "Debug NW_SB",
     "runtimeExecutable": "npx",
     "runtimeArgs": ["tsx", "${workspaceFolder}/scripts/NW_SB_DEBUG.ts"],
     "args": ["Match Result"],
     "cwd": "${workspaceFolder}"
   }
*/
