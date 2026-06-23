import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  applyProviderSnapshot,
  clearAllOdds,
  clearOddsForEvent,
  consumeDirtyFamilies,
  getMatchedMarketsCount,
  getOdds,
  getStoreStats,
  hasDirtyFamilies,
  readdDirtyFamilies,
  setOdds,
  setOnDirtyCallback,
} from "@/lib/atoms/store";
import { getAtomHistory, pruneHistoryForEvent } from "@/lib/atoms/odds-history";
import type { NormalizedOddsEntry, ProviderKey } from "@/lib/atoms/types";

const EVENT = "test-event-odds-store";
const FAMILY = "1X2_FT";
const SHARP: ProviderKey = "pinnacle";
const SOFT: ProviderKey = "ninewickets-exchange";

function entry(
  atomId: string,
  odds: number,
  overrides: Partial<NormalizedOddsEntry> = {},
): NormalizedOddsEntry {
  return {
    provider: SHARP,
    event_id: EVENT,
    family_id: FAMILY,
    atom_id: atomId,
    odds,
    timestamp: Date.now(),
    ...overrides,
  };
}

function reset(): void {
  clearAllOdds();
  pruneHistoryForEvent(EVENT);
  consumeDirtyFamilies();
  setOnDirtyCallback(null);
}

describe("applyProviderSnapshot", () => {
  beforeEach(reset);
  afterEach(reset);

  it("identical snapshot is a no-op: no dirty families, no new ticks", () => {
    const snapshot = [
      entry("HOME", 2.1),
      entry("DRAW", 3.4),
      entry("AWAY", 3.6),
    ];
    applyProviderSnapshot(EVENT, SHARP, snapshot);
    consumeDirtyFamilies();

    const ticksBefore = getAtomHistory(
      EVENT,
      FAMILY,
      "HOME",
      SHARP,
    )?.totalTicks;
    const statsBefore = getStoreStats();

    applyProviderSnapshot(
      EVENT,
      SHARP,
      snapshot.map((e) => ({ ...e, timestamp: Date.now() + 1000 })),
    );

    expect(hasDirtyFamilies()).toBe(false);
    expect(getAtomHistory(EVENT, FAMILY, "HOME", SHARP)?.totalTicks).toBe(
      ticksBefore,
    );
    expect(getStoreStats()).toEqual(statsBefore);
  });

  it("changed odds mark the family dirty and record exactly one new tick", () => {
    applyProviderSnapshot(EVENT, SHARP, [entry("HOME", 2.1)]);
    consumeDirtyFamilies();
    const ticksBefore =
      getAtomHistory(EVENT, FAMILY, "HOME", SHARP)?.totalTicks ?? 0;

    applyProviderSnapshot(EVENT, SHARP, [entry("HOME", 2.2)]);

    const dirty = consumeDirtyFamilies();
    expect(dirty.has(`${EVENT}|${FAMILY}`)).toBe(true);
    expect(getAtomHistory(EVENT, FAMILY, "HOME", SHARP)?.totalTicks).toBe(
      ticksBefore + 1,
    );
    expect(getOdds(EVENT, FAMILY, "HOME", SHARP)?.odds).toBe(2.2);
  });

  it("suspension flips mark the family dirty", () => {
    applyProviderSnapshot(EVENT, SHARP, [entry("HOME", 2.1)]);
    consumeDirtyFamilies();

    applyProviderSnapshot(EVENT, SHARP, [
      entry("HOME", 2.1, { suspended: true }),
    ]);

    expect(consumeDirtyFamilies().has(`${EVENT}|${FAMILY}`)).toBe(true);
    expect(getOdds(EVENT, FAMILY, "HOME", SHARP)?.suspended).toBe(true);
  });

  it("atoms absent from the snapshot are deleted and the family marked dirty", () => {
    applyProviderSnapshot(EVENT, SHARP, [
      entry("HOME", 2.1),
      entry("DRAW", 3.4),
    ]);
    consumeDirtyFamilies();

    applyProviderSnapshot(EVENT, SHARP, [entry("HOME", 2.1)]);

    expect(getOdds(EVENT, FAMILY, "HOME", SHARP)?.odds).toBe(2.1);
    expect(getOdds(EVENT, FAMILY, "DRAW", SHARP)).toBeUndefined();
    expect(consumeDirtyFamilies().has(`${EVENT}|${FAMILY}`)).toBe(true);
  });

  it("new atoms in the snapshot are added", () => {
    applyProviderSnapshot(EVENT, SHARP, [entry("HOME", 2.1)]);
    consumeDirtyFamilies();

    applyProviderSnapshot(EVENT, SHARP, [
      entry("HOME", 2.1),
      entry("AWAY", 3.6),
    ]);

    expect(getOdds(EVENT, FAMILY, "AWAY", SHARP)?.odds).toBe(3.6);
    expect(consumeDirtyFamilies().has(`${EVENT}|${FAMILY}`)).toBe(true);
  });

  it("only touches the given provider's records", () => {
    setOdds(entry("HOME", 1.95, { provider: SOFT }));
    applyProviderSnapshot(EVENT, SHARP, [entry("HOME", 2.1)]);
    consumeDirtyFamilies();

    applyProviderSnapshot(EVENT, SHARP, []);

    expect(getOdds(EVENT, FAMILY, "HOME", SHARP)).toBeUndefined();
    expect(getOdds(EVENT, FAMILY, "HOME", SOFT)?.odds).toBe(1.95);
  });
});

describe("_matchedMarkets counter", () => {
  beforeEach(reset);
  afterEach(reset);

  it("increments when an atom crosses to 2 providers and decrements on 2→1", () => {
    setOdds(entry("HOME", 2.1));
    expect(getMatchedMarketsCount()).toBe(0);

    setOdds(entry("HOME", 1.95, { provider: SOFT }));
    expect(getMatchedMarketsCount()).toBe(1);

    applyProviderSnapshot(EVENT, SHARP, []);
    expect(getMatchedMarketsCount()).toBe(0);
  });

  it("does NOT decrement when removing the sole provider of an unmatched atom (1→0)", () => {
    setOdds(entry("HOME", 2.1));
    setOdds(entry("HOME", 1.95, { provider: SOFT }));
    setOdds(entry("DRAW", 3.4, { provider: SOFT }));
    expect(getMatchedMarketsCount()).toBe(1);

    applyProviderSnapshot(EVENT, SOFT, []);
    expect(getMatchedMarketsCount()).toBe(0);
  });
});

describe("clearOddsForEvent", () => {
  beforeEach(reset);
  afterEach(reset);

  it("marks removed families dirty and fires the dirty callback", () => {
    setOdds(entry("HOME", 2.1));
    consumeDirtyFamilies();

    let fired = 0;
    setOnDirtyCallback(() => {
      fired++;
    });

    clearOddsForEvent(EVENT);

    expect(fired).toBe(1);
    expect(consumeDirtyFamilies().has(`${EVENT}|${FAMILY}`)).toBe(true);
    expect(getOdds(EVENT, FAMILY, "HOME", SHARP)).toBeUndefined();
    expect(getStoreStats().totalOddsRecords).toBe(0);
  });
});

describe("readdDirtyFamilies", () => {
  beforeEach(reset);
  afterEach(reset);

  it("merges keys back into the dirty set WITHOUT firing the callback", () => {
    let fired = 0;
    setOnDirtyCallback(() => {
      fired++;
    });

    readdDirtyFamilies(new Set([`${EVENT}|${FAMILY}`]));

    expect(fired).toBe(0);
    expect(hasDirtyFamilies()).toBe(true);
    expect(consumeDirtyFamilies().has(`${EVENT}|${FAMILY}`)).toBe(true);
  });
});
