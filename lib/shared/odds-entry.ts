
import { getFamilyIdByAtom } from "../atoms/registry";
import type { NormalizedOddsEntry, ProviderKey } from "../atoms/types";

export function buildOddsEntry(
  provider: ProviderKey,
  eventId: string,
  atomId: string | null | undefined,
  odds: number,
  timestamp: number,
  suspended?: boolean,
): NormalizedOddsEntry | null {
  if (!atomId) return null;

  if (odds <= 1) return null;

  const familyId = getFamilyIdByAtom(atomId);
  if (!familyId) return null;

  return {
    provider,
    event_id: eventId,
    family_id: familyId,
    atom_id: atomId,
    odds,
    timestamp,
    suspended,
  };
}

export function buildOddsEntries(
  provider: ProviderKey,
  eventId: string,
  mappings: Array<{ atomId: string | null | undefined; odds: number }>,
  timestamp: number,
): NormalizedOddsEntry[] {
  return mappings
    .map((m) => buildOddsEntry(provider, eventId, m.atomId, m.odds, timestamp))
    .filter((entry): entry is NormalizedOddsEntry => entry !== null);
}
