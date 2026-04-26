import { mapSportsbookToAtom } from "../lib/atoms/mappings/ninewickets-sportsbook";

// Real Velki market names from the catalog dump
const realCases = [
  { name: "Total Goals Over / Under 2.00", sel: "Over", type: 0 },
  { name: "Total Goals Over / Under 2.00", sel: "Under", type: 0 },
  { name: "Sporting CP Goals Over / Under 1.75", sel: "Over", type: 0 },
  { name: "Second Half Total Goals Over / Under 4.00", sel: "Over", type: 0 },
  { name: "Second Half Total Goals Over / Under 4.50", sel: "Over", type: 0 },
  { name: "AVS Futebol SAD Goals Over / Under 1.75", sel: "Over", type: 0 },
  {
    name: "Sporting CP Team Total Goals Over/Under +3.75",
    sel: "Over",
    type: 0,
  },
  {
    name: "Match Result and Total Goals Over / Under 2.50",
    sel: "Over",
    type: 0,
  },
  // Standard half-goal lines (if they exist)
  { name: "Total Goals Over / Under 2.5", sel: "Over", type: 0 },
  { name: "Total Goals Over / Under 2.50", sel: "Over", type: 0 },
  { name: "Total Goals Over / Under 3.5", sel: "Over", type: 0 },
  { name: "Total Goals Over / Under 1.5", sel: "Over", type: 0 },
];

for (const tc of realCases) {
  const atomId = mapSportsbookToAtom(
    tc.type,
    tc.sel,
    tc.name,
    "Sporting CP",
    "AVS Futebol SAD",
  );
  const status = atomId ? `✓ ${atomId}` : "✗ null";
  console.log(`${status}  ← "${tc.name}" sel="${tc.sel}"`);
}
