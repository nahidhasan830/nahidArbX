import { describe, expect, it } from "vitest";
import { selectPreferredGeniusEntries } from "../../lib/atoms/adapters/genius-market-dedupe";
import type { NormalizedOddsEntry } from "../../lib/atoms/types";

function entry(odds: number): NormalizedOddsEntry {
  return {
    provider: "velki-sportsbook",
    event_id: "event-1",
    family_id: "ft_total_2_5",
    atom_id: "ft_total_over_2_5",
    odds,
    timestamp: 1,
  };
}

function underEntry(odds: number): NormalizedOddsEntry {
  return {
    provider: "velki-sportsbook",
    event_id: "event-1",
    family_id: "ft_total_2_5",
    atom_id: "ft_total_under_2_5",
    odds,
    timestamp: 1,
  };
}

describe("selectPreferredGeniusEntries", () => {
  it("prefers live explicit total markets over compact duplicate totals", () => {
    const selected = selectPreferredGeniusEntries([
      {
        entry: entry(1.35),
        order: 0,
        market: {
          id: "compact",
          marketName: "Over/Under +2.5",
          apiSiteStatus: "OPEN",
          marketLive: 0,
          selectionTs: 20,
        },
      },
      {
        entry: entry(1.6),
        order: 1,
        market: {
          id: "live",
          marketName: "Total Goals Over / Under 2.50",
          apiSiteStatus: "OPEN",
          marketLive: 1,
          selectionTs: 10,
        },
      },
      {
        entry: underEntry(2.35),
        order: 2,
        market: {
          id: "live",
          marketName: "Total Goals Over / Under 2.50",
          apiSiteStatus: "OPEN",
          marketLive: 1,
          selectionTs: 10,
        },
      },
    ]);

    expect(selected).toHaveLength(2);
    expect(selected[0].entry.odds).toBe(1.6);
    expect(selected[0].market.id).toBe("live");
  });

  it("keeps compact totals when they are the only available surface", () => {
    const selected = selectPreferredGeniusEntries([
      {
        entry: entry(2.95),
        order: 0,
        market: {
          id: "compact",
          marketName: "Over/Under +2.5",
          apiSiteStatus: "OPEN",
          marketLive: 0,
          selectionTs: 10,
        },
      },
    ]);

    expect(selected).toHaveLength(1);
    expect(selected[0].entry.odds).toBe(2.95);
  });

  it("keeps a family on one complete open market surface", () => {
    const selected = selectPreferredGeniusEntries([
      {
        entry: entry(1),
        order: 0,
        market: {
          id: "closed-live",
          marketName: "Total Goals Over / Under 2.50",
          apiSiteStatus: "CLOSED",
          marketLive: 1,
          selectionTs: 20,
        },
      },
      {
        entry: underEntry(1),
        order: 1,
        market: {
          id: "closed-live",
          marketName: "Total Goals Over / Under 2.50",
          apiSiteStatus: "CLOSED",
          marketLive: 1,
          selectionTs: 20,
        },
      },
      {
        entry: entry(1.45),
        order: 2,
        market: {
          id: "compact-open",
          marketName: "Over/Under +2.5",
          apiSiteStatus: "OPEN",
          marketLive: 0,
          selectionTs: 10,
        },
      },
      {
        entry: underEntry(2.75),
        order: 3,
        market: {
          id: "compact-open",
          marketName: "Over/Under +2.5",
          apiSiteStatus: "OPEN",
          marketLive: 0,
          selectionTs: 10,
        },
      },
    ]);

    expect(selected).toHaveLength(2);
    expect(selected.map((item) => item.market.id)).toEqual([
      "compact-open",
      "compact-open",
    ]);
    expect(selected.map((item) => item.entry.odds).sort()).toEqual([
      1.45, 2.75,
    ]);
  });
});
