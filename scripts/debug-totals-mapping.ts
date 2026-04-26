import { mapSportsbookToAtom } from "../lib/atoms/mappings/ninewickets-sportsbook";

const testCases = [
  // Standard total goals market names from NW SB / Velki
  { name: "Total Goals Over / Under 2.5", sel: "Over", type: 259 },
  { name: "Total Goals Over / Under 2.5", sel: "Under", type: 259 },
  { name: "Total Goals Over / Under 1.5", sel: "Over", type: 259 },
  { name: "Total Goals Over / Under 3.5", sel: "Over", type: 259 },
  // Half-time variants
  { name: "Half Time Total Goals Over / Under 0.5", sel: "Over", type: 7076 },
  { name: "Half Time Total Goals Over / Under 1.5", sel: "Over", type: 7076 },
  // Possible alternative formats
  { name: "Over/Under 2.5", sel: "Over", type: 259 },
  { name: "Over / Under 2.5", sel: "Over", type: 259 },
  { name: "Total Over/Under 2.5", sel: "Over", type: 259 },
  { name: "Over/Under Total Goals 2.5", sel: "Over", type: 259 },
];

for (const tc of testCases) {
  const atomId = mapSportsbookToAtom(
    tc.type,
    tc.sel,
    tc.name,
    "TeamA",
    "TeamB",
  );
  const status = atomId ? `✓ ${atomId}` : "✗ null (UNMAPPED)";
  console.log(`${status}  ← "${tc.name}" | sel="${tc.sel}" | type=${tc.type}`);
}
