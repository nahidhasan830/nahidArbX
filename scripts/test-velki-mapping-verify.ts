/**
 * Verify the velki-sportsbook → atoms mapping by running the actual
 * NW Sportsbook mapping against real Velki market+selection data.
 *
 * For each (apiSiteMarketType, marketName, selectionName) combination
 * Velki returns:
 *   ✓ if mapSportsbookToAtom() returns an atomId AND that atomId
 *     resolves to a valid atom in our registry
 *   ✗ if it returns "" (unmapped) OR an atomId that the registry
 *     doesn't recognise (silent miss — would store a bad odds entry)
 *
 * Usage: pick one in-play event with lots of markets so we exercise
 * many market types in one shot.
 *
 * Run with:  npx tsx scripts/test-velki-mapping-verify.ts
 */
import "dotenv/config";
import { invalidateSession, getSession } from "../lib/betting/velki/session";
import {
  queryGeniusSportsCatalog,
  queryGeniusSportsOdds,
} from "../lib/betting/velki/events-client";
import { velkiSportsbookAdapter } from "../lib/adapters/velki-sportsbook";
import { mapSportsbookToAtom } from "../lib/atoms/mappings/velki-sportsbook";
import { isValidAtom, getFamilyIdByAtom } from "../lib/atoms/registry";

interface Bucket {
  count: number;
  sampleSelections: Set<string>;
}

async function main() {
  invalidateSession();
  await getSession();

  const events = await velkiSportsbookAdapter.fetchEvents();
  console.log(`fetched ${events.length} events`);

  // Find an event whose catalog returns a lot of live markets.
  let chosenEventId: string | null = null;
  let chosenName = "";
  let totalMarkets = 0;
  for (const ev of events.slice(0, 10)) {
    const peId = ev.providers["velki-sportsbook"]?.eventId;
    if (!peId) continue;
    const cat = await queryGeniusSportsCatalog(peId);
    const live = cat.live ?? false;
    const ms = (cat.geniusSportsMarkets ?? []).filter(
      (m) => Boolean(m.marketLive) === live,
    );
    if (ms.length > totalMarkets) {
      totalMarkets = ms.length;
      chosenEventId = peId;
      chosenName = `${ev.homeTeam} v ${ev.awayTeam}`;
      if (ms.length >= 100) break; // good enough sample
    }
  }
  if (!chosenEventId) {
    console.log("[!] no event produced any live markets to map");
    return;
  }
  console.log(
    `\nchosen: ${chosenName} (id=${chosenEventId}) with ${totalMarkets} markets`,
  );

  const cat = await queryGeniusSportsCatalog(chosenEventId);
  // No live filter — let the odds payload tell us what's actually
  // tradeable. This is the correctness check: we want to know the
  // real shape of mappable markets, not what passes a flag we may
  // be reading wrong.
  const markets = cat.geniusSportsMarkets ?? [];
  const oddsResp = await queryGeniusSportsOdds(
    chosenEventId,
    cat.version ?? 0,
    markets.map((m) => m.id),
    markets.map((m) => m.selectionTs ?? -1),
  );
  const fullMarkets = oddsResp.geniusSportsMarkets ?? [];
  const withSelections = fullMarkets.filter(
    (m) => (m.geniusSportsSelection?.length ?? 0) > 0,
  );
  console.log(
    `got ${fullMarkets.length} markets in odds payload (${withSelections.length} have selections)`,
  );

  const ev = events.find(
    (e) => e.providers["velki-sportsbook"]?.eventId === chosenEventId,
  );
  if (!ev) {
    console.log("[!] could not re-find chosen event in normalized list");
    return;
  }

  // Bucket by (apiSiteMarketType, marketName) so we see variety.
  const handled = new Map<string, Bucket>();
  const unmapped = new Map<string, Bucket>();
  const invalidAtom = new Map<string, Bucket>();

  for (const m of fullMarkets) {
    const selections = m.geniusSportsSelection ?? [];
    for (const s of selections) {
      if (!s.isActive) continue;
      const atomId = mapSportsbookToAtom(
        m.apiSiteMarketType ?? 0,
        s.selectionName,
        m.marketName,
        ev.homeTeam,
        ev.awayTeam,
      );
      const key = `[type=${m.apiSiteMarketType}] ${m.marketName}`;
      const target = !atomId
        ? unmapped
        : isValidAtom(atomId)
          ? handled
          : invalidAtom;
      let bucket = target.get(key);
      if (!bucket) {
        bucket = { count: 0, sampleSelections: new Set() };
        target.set(key, bucket);
      }
      bucket.count++;
      if (bucket.sampleSelections.size < 3) {
        bucket.sampleSelections.add(
          atomId
            ? `${s.selectionName} → ${atomId} (family=${getFamilyIdByAtom(atomId) ?? "?"})`
            : s.selectionName,
        );
      }
    }
  }

  function report(label: string, m: Map<string, Bucket>) {
    console.log(`\n=== ${label} (${m.size} distinct market shapes) ===`);
    const sorted = [...m.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [key, bucket] of sorted) {
      console.log(`  ${key}  ×${bucket.count}`);
      for (const s of bucket.sampleSelections) {
        console.log(`    • ${s}`);
      }
    }
  }
  report("✓ HANDLED (atom maps + valid in registry)", handled);
  report("✗ UNMAPPED (mapper returned '')", unmapped);
  report("✗ INVALID ATOM (mapped but registry rejects)", invalidAtom);

  const totalSel =
    [...handled.values()].reduce((a, b) => a + b.count, 0) +
    [...unmapped.values()].reduce((a, b) => a + b.count, 0) +
    [...invalidAtom.values()].reduce((a, b) => a + b.count, 0);
  const handledCount = [...handled.values()].reduce((a, b) => a + b.count, 0);
  console.log(
    `\nsummary: ${handledCount}/${totalSel} selections (${((handledCount / totalSel) * 100).toFixed(1)}%) successfully mapped`,
  );
}

main().catch((err) => {
  console.error("✗ failed:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
