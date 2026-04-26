/**
 * Probe-only version: skip matcher/store imports (they pull in
 * lib/db/client.ts which has top-level await and breaks under tsx CJS).
 *
 * Hits the live Velki catalog/odds endpoints, then runs every selection
 * through `mapSportsbookToAtom` to see whether the target atomId
 * (`ft_draw` for "Kirivong Soksen Chey vs ISI Dangkor Senchey") is
 * reachable from any market+selection combo.
 *
 * Usage:  npx tsx scripts/debug-velki-resolve.ts
 */
import "dotenv/config";
import {
  queryGeniusSportsCatalog,
  queryGeniusSportsOdds,
} from "../lib/betting/velki/events-client";
import { mapSportsbookToAtom } from "../lib/atoms/mappings/velki-sportsbook";

const TARGET = {
  nativeEventId: "35514773",
  familyId: "ft_match_result",
  atomId: "ft_draw",
  homeTeam: "Qingdao Hainiu",
  awayTeam: "Shandong Taishan",
};

async function main() {
  console.log("=== STEP 1 — fetch Velki catalog directly ===");
  const catalog = await queryGeniusSportsCatalog(TARGET.nativeEventId);
  const allMarkets = catalog.geniusSportsMarkets ?? [];
  console.log(`catalog.eventId = ${catalog.eventId}`);
  console.log(`catalog.version = ${catalog.version}`);
  console.log(`catalog markets = ${allMarkets.length}`);

  console.log("\n=== STEP 2 — fetch live odds ===");
  const oddsData = await queryGeniusSportsOdds(
    TARGET.nativeEventId,
    catalog.version ?? 0,
    allMarkets.map((m) => m.id),
    allMarkets.map((m) => m.selectionTs ?? -1),
  );
  const markets = oddsData.geniusSportsMarkets ?? allMarkets;
  console.log(`odds markets = ${markets.length}`);

  console.log(
    "\n=== STEP 3 — Match Result-ish markets (the ones that COULD map to ft_draw) ===",
  );
  for (const m of markets) {
    const name = String(m.marketName ?? "").toLowerCase();
    if (
      name === "match odds" ||
      name === "match result" ||
      name === "1x2" ||
      name === "full time result" ||
      name.includes("match result") ||
      name.includes("1x2") ||
      name.includes("match odds")
    ) {
      console.log(
        `[type=${m.apiSiteMarketType}] "${m.marketName}" id=${m.id} status=${m.apiSiteStatus ?? "?"}`,
      );
      for (const sel of m.geniusSportsSelection ?? []) {
        const atom = mapSportsbookToAtom(
          m.apiSiteMarketType ?? 0,
          sel.selectionName,
          m.marketName,
          TARGET.homeTeam,
          TARGET.awayTeam,
        );
        console.log(
          `  "${sel.selectionName}" (id=${sel.id}, isActive=${sel.isActive}, odds=${sel.odds}) → atom=${atom ?? "null"}`,
        );
      }
    }
  }

  console.log("\n=== STEP 4 — full mapping summary ===");
  let mapped = 0;
  let unmapped = 0;
  let targetMatches = 0;
  const interesting: string[] = [];
  for (const m of markets) {
    for (const sel of m.geniusSportsSelection ?? []) {
      const atom = mapSportsbookToAtom(
        m.apiSiteMarketType ?? 0,
        sel.selectionName,
        m.marketName,
        TARGET.homeTeam,
        TARGET.awayTeam,
      );
      if (atom) mapped++;
      else unmapped++;
      if (atom === TARGET.atomId) {
        targetMatches++;
        interesting.push(
          `[type=${m.apiSiteMarketType}] "${m.marketName}" → "${sel.selectionName}" (id=${sel.id}, isActive=${sel.isActive})`,
        );
      }
    }
  }
  console.log(
    `mapped=${mapped}, unmapped=${unmapped}, target "${TARGET.atomId}" matches=${targetMatches}`,
  );
  if (interesting.length > 0) {
    console.log("target matches:");
    for (const s of interesting) console.log("  " + s);
  }

  console.log(
    "\n=== STEP 5 — first 10 unmapped selections (for blind spots) ===",
  );
  let shown = 0;
  for (const m of markets) {
    if (shown >= 10) break;
    for (const sel of m.geniusSportsSelection ?? []) {
      if (shown >= 10) break;
      const atom = mapSportsbookToAtom(
        m.apiSiteMarketType ?? 0,
        sel.selectionName,
        m.marketName,
        TARGET.homeTeam,
        TARGET.awayTeam,
      );
      if (!atom) {
        console.log(
          `  [type=${m.apiSiteMarketType}] "${m.marketName}" / "${sel.selectionName}"`,
        );
        shown++;
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
