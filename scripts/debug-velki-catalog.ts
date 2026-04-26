/**
 * Probe the Velki catalog response for a single event so we can see
 * what resolveProviderRefs is iterating over. We compare the catalog
 * (version=0) with the full odds response (version=N) — the
 * atomsAdapter uses the second one, resolveProviderRefs uses the first.
 */
import "dotenv/config";
import {
  queryGeniusSportsCatalog,
  queryGeniusSportsOdds,
} from "../lib/betting/velki/events-client";
import { mapSportsbookToAtom } from "../lib/atoms/mappings/velki-sportsbook";

const EVENT_ID = "35525730"; // Banga Gargzdai vs Hegelmann
const HOME = "Banga Gargzdai";
const AWAY = "Hegelmann";
const TARGET_ATOM = "ft_away_under_0_5";

async function main() {
  console.log(`=== catalog (version=0) for ${EVENT_ID} ===`);
  const catalog = await queryGeniusSportsCatalog(EVENT_ID);
  const cMarkets = catalog.geniusSportsMarkets ?? [];
  console.log(`catalog: ${cMarkets.length} markets`);

  const cWithSelections = cMarkets.filter(
    (m) => (m.geniusSportsSelection ?? []).length > 0,
  );
  console.log(`catalog: ${cWithSelections.length} markets WITH selections`);

  console.log(
    `\n=== odds (version=${catalog.version ?? 0}) for ${EVENT_ID} ===`,
  );
  const odds = await queryGeniusSportsOdds(
    EVENT_ID,
    catalog.version ?? 0,
    cMarkets.map((m) => m.id),
    cMarkets.map((m) => m.selectionTs ?? -1),
  );
  const oMarkets = odds.geniusSportsMarkets ?? [];
  console.log(`odds: ${oMarkets.length} markets`);
  const oWithSelections = oMarkets.filter(
    (m) => (m.geniusSportsSelection ?? []).length > 0,
  );
  console.log(`odds: ${oWithSelections.length} markets WITH selections`);

  console.log(`\n=== probing mapSportsbookToAtom against catalog markets ===`);
  let catalogHits = 0;
  for (const market of cMarkets) {
    const sels = market.geniusSportsSelection ?? [];
    for (const sel of sels) {
      const atomId = mapSportsbookToAtom(
        market.apiSiteMarketType ?? 0,
        sel.selectionName,
        market.marketName,
        HOME,
        AWAY,
      );
      if (atomId === TARGET_ATOM) {
        catalogHits++;
        console.log(
          `  HIT: market='${market.marketName}' apiSiteMarketType=${market.apiSiteMarketType} sel='${sel.selectionName}' selId=${(sel as { id?: number }).id}`,
        );
      }
    }
  }
  console.log(`  total catalog hits for ${TARGET_ATOM}: ${catalogHits}`);

  console.log(`\n=== probing mapSportsbookToAtom against odds markets ===`);
  let oddsHits = 0;
  for (const market of oMarkets) {
    const sels = market.geniusSportsSelection ?? [];
    for (const sel of sels) {
      const atomId = mapSportsbookToAtom(
        market.apiSiteMarketType ?? 0,
        sel.selectionName,
        market.marketName,
        HOME,
        AWAY,
      );
      if (atomId === TARGET_ATOM) {
        oddsHits++;
        console.log(
          `  HIT: market='${market.marketName}' apiSiteMarketType=${market.apiSiteMarketType} sel='${sel.selectionName}' selId=${(sel as { id?: number }).id}`,
        );
      }
    }
  }
  console.log(`  total odds hits for ${TARGET_ATOM}: ${oddsHits}`);

  // Dump any market with "team total" or "0.5" to see naming patterns
  console.log(`\n=== catalog markets matching /team total|0\\.5/ ===`);
  for (const m of cMarkets) {
    const name = String(m.marketName ?? "");
    if (/team total|0\.5/i.test(name)) {
      const sels = m.geniusSportsSelection ?? [];
      console.log(
        `  '${name}' (apiSiteMarketType=${m.apiSiteMarketType}, ${sels.length} selections)`,
      );
      for (const s of sels.slice(0, 4)) {
        console.log(`    - '${s.selectionName}' odds=${s.odds}`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
