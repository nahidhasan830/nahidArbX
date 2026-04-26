/**
 * End-to-end Velki pipeline smoke test:
 *   1. Event adapter → list normalized events
 *   2. Atoms adapter → fetch & store odds for one event
 *   3. Read back the stored odds entries
 *
 * Run with:  npx tsx scripts/test-velki-pipeline.ts
 */
import "dotenv/config";
import { invalidateSession } from "../lib/betting/velki/session";
import { velkiSportsbookAdapter } from "../lib/adapters/velki-sportsbook";
import { VelkiSportsbookAtomsAdapter } from "../lib/atoms/adapters/velki-sportsbook";
import { getFamiliesForEvent } from "../lib/atoms/store";

async function main() {
  invalidateSession();

  console.log("→ event adapter — fetchEvents()");
  const events = await velkiSportsbookAdapter.fetchEvents();
  console.log(`✓ ${events.length} events normalized`);
  if (events.length === 0) return;
  console.log("  first 3 sample:");
  for (const ev of events.slice(0, 3)) {
    console.log(
      `    ${ev.competition} — ${ev.homeTeam} v ${ev.awayTeam} @ ${ev.startTime.toISOString()}`,
    );
  }

  // Try the third event so we get a different fixture from the smoke test
  // — events arrive in openDateTime order so [2] is typically live/early.
  const first = events[2] ?? events[0];
  const providerEntry = first.providers["velki-sportsbook"];
  if (!providerEntry) {
    console.log("[!] first event has no velki-sportsbook providerEntry");
    return;
  }
  const providerEventId = providerEntry.eventId;
  console.log(
    `\n→ atoms adapter — fetchAndStoreOdds(${providerEventId}, ${first.id})`,
  );
  const atoms = new VelkiSportsbookAtomsAdapter();
  const count = await atoms.fetchAndStoreOdds(
    providerEventId,
    first.id,
    first.homeTeam,
    first.awayTeam,
  );
  console.log(`✓ stored ${count} odds entries`);

  if (count > 0) {
    const families = getFamiliesForEvent(first.id);
    console.log(`  families touched for this event: ${families.length}`);
    console.log("  family ids (first 10):", families.slice(0, 10).join(", "));
  }
}

main().catch((err) => {
  console.error("✗ failed:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
