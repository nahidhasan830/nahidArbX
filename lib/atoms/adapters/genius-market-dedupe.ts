import type { NormalizedOddsEntry } from "../types";

export interface GeniusMarketMetadata {
  id?: string | number;
  marketName?: string;
  apiSiteStatus?: string;
  marketLive?: number | boolean;
  live?: boolean;
  min?: number;
  max?: number;
  selectionTs?: number;
}

export interface GeniusEntryCandidate {
  entry: NormalizedOddsEntry;
  market: GeniusMarketMetadata;
  order: number;
}

export interface PreferredGeniusEntry {
  entry: NormalizedOddsEntry;
  market: GeniusMarketMetadata;
}

interface MarketGroup {
  market: GeniusMarketMetadata;
  entries: NormalizedOddsEntry[];
  order: number;
}

function marketRank(group: MarketGroup): number[] {
  const { market } = group;
  const status = (market.apiSiteStatus ?? "").toUpperCase();
  const statusRank = status === "OPEN" ? 2 : status === "SUSPENDED" ? 1 : 0;
  const liveRank =
    market.marketLive === 1 || market.marketLive === true || market.live === true
      ? 1
      : 0;
  const marketName = (market.marketName ?? "").toLowerCase();
  const compactTotalRank = marketName.startsWith("over/under") ? 0 : 1;
  const selectionTs =
    typeof market.selectionTs === "number" ? market.selectionTs : 0;

  return [
    new Set(group.entries.map((entry) => entry.atom_id)).size,
    statusRank,
    liveRank,
    compactTotalRank,
    selectionTs,
  ];
}

function compareGroup(a: MarketGroup, b: MarketGroup): number {
  const aRank = marketRank(a);
  const bRank = marketRank(b);
  for (let i = 0; i < aRank.length; i++) {
    if (aRank[i] !== bRank[i]) return aRank[i] - bRank[i];
  }
  return a.order - b.order;
}

export function selectPreferredGeniusEntries(
  candidates: GeniusEntryCandidate[],
): PreferredGeniusEntry[] {
  const groupsByFamily = new Map<string, Map<string, MarketGroup>>();

  for (const candidate of candidates) {
    let familyGroups = groupsByFamily.get(candidate.entry.family_id);
    if (!familyGroups) {
      familyGroups = new Map();
      groupsByFamily.set(candidate.entry.family_id, familyGroups);
    }

    const marketKey =
      candidate.market.id != null
        ? String(candidate.market.id)
        : `${candidate.market.marketName ?? "unknown"}|${candidate.market.selectionTs ?? candidate.order}`;
    const group = familyGroups.get(marketKey);
    if (group) {
      group.entries.push(candidate.entry);
      group.order = Math.min(group.order, candidate.order);
    } else {
      familyGroups.set(marketKey, {
        market: candidate.market,
        entries: [candidate.entry],
        order: candidate.order,
      });
    }
  }

  const preferred: PreferredGeniusEntry[] = [];

  for (const familyGroups of groupsByFamily.values()) {
    let bestGroup: MarketGroup | null = null;
    for (const group of familyGroups.values()) {
      if (!bestGroup || compareGroup(group, bestGroup) > 0) {
        bestGroup = group;
      }
    }
    if (!bestGroup) continue;
    for (const entry of bestGroup.entries) {
      preferred.push({ entry, market: bestGroup.market });
    }
  }

  return preferred;
}
