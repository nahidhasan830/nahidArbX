
import {
  getEvents,
  getAllProviderStatus,
  getLastUpdate,
  getSyncStatus,
  getValueBets,
  getCachedStats,
  getMatchingStats,
} from "../store";
import type { SyncStatus } from "../store";
import { getFamiliesForEvent, getAllOddsForAtom } from "../atoms/store";
import { getFamily } from "../atoms/registry";
import { getMovementSummary } from "../atoms/odds-history";
import { getCachedVigData } from "../atoms/value-detector";
import { formatFamilyLabel, formatAtomLabel } from "../formatting/labels";
import type { ValueBet } from "../atoms/types";
import type { ProviderKey } from "../providers/registry";
import {
  getDisplayScore,
  getMultiSourceDisplayScore,
  subscribeToScores,
} from "../scores";
import { buildConnectionHealth } from "./engine-health-builder";
import { getResponseETag } from "../cache/response-cache";

function serializeSyncStatus(syncStatus: SyncStatus) {
  return {
    ...syncStatus,
    lastSyncStart: syncStatus.lastSyncStart?.toISOString() || null,
    lastSyncEnd: syncStatus.lastSyncEnd?.toISOString() || null,
  };
}

export async function analyzeAndSerialize(
  params: URLSearchParams,
): Promise<Record<string, unknown>> {
  const page = parseInt(params.get("page") || "0");
  const pageSize = parseInt(params.get("pageSize") || "50");
  const search = (params.get("search") || "").toLowerCase().trim();
  const showOnlyValue = params.get("showOnlyValue") === "true";
  const evMin = parseFloat(params.get("evMin") || "0");
  const evMax = parseFloat(params.get("evMax") || "100");
  const oddsMin = parseFloat(params.get("oddsMin") || "1.0");
  const oddsMax = parseFloat(params.get("oddsMax") || "10.0");
  const softProvidersParam = params.get("softProviders");
  const softProviders = softProvidersParam
    ? softProvidersParam.split(",").filter(Boolean)
    : [];

  const providersParam = params.get("providers");
  const selectedProviders: Set<ProviderKey> | null = providersParam
    ? new Set(providersParam.split(",").filter(Boolean) as ProviderKey[])
    : null;
  const timeFilter = (params.get("timeFilter") || "all") as
    | "all"
    | "live"
    | "upcoming";
  const marketTypesParam = params.get("marketTypes");
  const selectedMarketTypes: Set<string> | null = marketTypesParam
    ? new Set(marketTypesParam.split(",").filter(Boolean))
    : null;

  const allEvents = getEvents();
  const cachedStats = getCachedStats();
  const allValueBets = getValueBets();

  const valuesByAtom = new Map<string, ValueBet>();
  const eventIdsWithValue = new Set<string>();
  for (const vb of allValueBets) {
    if (vb.evPct < evMin || vb.evPct > evMax) continue;
    if (vb.softOdds < oddsMin || vb.softOdds > oddsMax) continue;
    if (softProviders.length > 0 && !softProviders.includes(vb.softProvider))
      continue;
    const key = `${vb.eventId}:${vb.familyId}:${vb.atomId}`;
    const existing = valuesByAtom.get(key);
    if (!existing || vb.evPct > existing.evPct) {
      valuesByAtom.set(key, vb);
    }
    eventIdsWithValue.add(vb.eventId);
  }

  const eventsWithValue = allEvents.filter((e) => eventIdsWithValue.has(e.id));
  let eventsToAnalyze = showOnlyValue ? eventsWithValue : [...allEvents];

  if (timeFilter !== "all") {
    const now = Date.now();
    eventsToAnalyze = eventsToAnalyze.filter((e) => {
      const eventStart = e.startTime.getTime();
      if (timeFilter === "live") return eventStart <= now;
      if (timeFilter === "upcoming") return eventStart > now;
      return true;
    });
  }

  if (selectedMarketTypes) {
    eventsToAnalyze = eventsToAnalyze.filter((e) => {
      const familyIds = getFamiliesForEvent(e.id);
      return familyIds.some((fid) => {
        const family = getFamily(fid);
        return family && selectedMarketTypes.has(family.market_type);
      });
    });
  }

  let totalBeforePagination = eventsToAnalyze.length;
  if (search) {
    eventsToAnalyze = eventsToAnalyze.filter((e) => {
      if (
        e.homeTeam.toLowerCase().includes(search) ||
        e.awayTeam.toLowerCase().includes(search) ||
        e.competition.toLowerCase().includes(search)
      )
        return true;
      const fids = getFamiliesForEvent(e.id);
      return fids.some((fid) =>
        formatFamilyLabel(fid).toLowerCase().includes(search),
      );
    });
    totalBeforePagination = eventsToAnalyze.length;
  }

  eventsToAnalyze.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  const start = page * pageSize;
  const end = start + pageSize;
  const hasMore = end < eventsToAnalyze.length;
  eventsToAnalyze = eventsToAnalyze.slice(start, end);

  const eventResults = [];
  let _totalFamilies = 0;
  let eventsWithOdds = 0;
  let _totalValueBetsInView = 0;
  let bestEvPct: number | null = null;

  for (const event of eventsToAnalyze) {
    const familyIds = getFamiliesForEvent(event.id);
    if (familyIds.length > 0) eventsWithOdds++;
    const familyResults = [];

    for (const familyId of familyIds) {
      const family = getFamily(familyId);
      if (!family) continue;
      if (selectedMarketTypes && !selectedMarketTypes.has(family.market_type))
        continue;
      _totalFamilies++;
      const atomResults = [];

      for (const atomId of family.atoms) {
        const allOdds = getAllOddsForAtom(event.id, familyId, atomId);
        const oddsByProvider: Record<string, unknown> = {};
        let bestOddsVal: number | null = null;
        let bestProviderVal: string | null = null;

        for (const [provider, record] of allOdds) {
          if (selectedProviders && !selectedProviders.has(provider)) continue;
          const isBest = bestOddsVal === null || record.odds > bestOddsVal;
          if (isBest && !record.suspended) {
            bestOddsVal = record.odds;
            bestProviderVal = provider;
          }
          oddsByProvider[provider] = {
            odds: record.odds,
            timestamp: record.timestamp,
            isBest: false,
            suspended: record.suspended,
            movement:
              getMovementSummary(event.id, familyId, atomId, provider) ??
              undefined,
          };
        }

        if (bestProviderVal && oddsByProvider[bestProviderVal]) {
          (oddsByProvider[bestProviderVal] as Record<string, unknown>).isBest =
            true;
        }

        const valueKey = `${event.id}:${familyId}:${atomId}`;
        const valueBet = valuesByAtom.get(valueKey);
        const atomResult: Record<string, unknown> = {
          atomId,
          label: formatAtomLabel(atomId),
          oddsByProvider,
          bestOdds: bestOddsVal,
          bestProvider: bestProviderVal,
        };

        if (valueBet) {
          const familyTrueOdds = getCachedVigData(event.id, familyId) ?? null;
          atomResult.valueBet = {
            softProvider: valueBet.softProvider,
            sharpProvider: valueBet.sharpProvider,
            softOdds: valueBet.softOdds,
            sharpOdds: valueBet.sharpOdds,
            trueProb: valueBet.trueProb,
            trueOdds: valueBet.trueOdds,
            impliedProb: valueBet.impliedProb,
            evPct: valueBet.evPct,
            edge: valueBet.edge,
            kellyFraction: valueBet.kellyFraction,
            kellyStake: valueBet.kellyStake,
            timestamp: valueBet.timestamp,
            familyOdds: familyTrueOdds
              ? {
                  totalImpliedProb: familyTrueOdds.totalImpliedProb,
                  vigPct: familyTrueOdds.vigPct,
                  atoms: familyTrueOdds.atoms.map((a) => ({
                    atomId: a.atomId,
                    label: formatAtomLabel(a.atomId),
                    rawOdds: a.rawOdds,
                    rawProb: a.rawProb,
                    trueProb: a.trueProb,
                  })),
                }
              : undefined,
          };
          _totalValueBetsInView++;
          if (bestEvPct === null || valueBet.evPct > bestEvPct)
            bestEvPct = valueBet.evPct;
        }

        atomResults.push(atomResult);
      }

      if (atomResults.length === 0) continue;
      familyResults.push({
        familyId,
        label: formatFamilyLabel(familyId),
        marketType: family.market_type,
        timeScope: family.time_scope,
        line: family.line,
        atoms: atomResults,
      });
    }

    const providerEventIds: Record<string, string> = {};
    for (const [provider, data] of Object.entries(event.providers)) {
      if (data?.eventId) providerEventIds[provider] = data.eventId;
    }

    let liveScore: unknown;
    const multiScore = getMultiSourceDisplayScore(event.id);
    if (multiScore) {
      liveScore = multiScore;
    } else {
      const pinnacleEventId = providerEventIds["pinnacle"];
      const legacyScore = pinnacleEventId
        ? getDisplayScore(pinnacleEventId)
        : undefined;
      if (legacyScore) {
        liveScore = {
          ...legacyScore,
          primarySource: "pinnacle",
          confidence: "medium",
          hasDiscrepancy: false,
        };
      }
    }

    eventResults.push({
      eventId: event.id,
      homeTeam: event.homeTeam,
      awayTeam: event.awayTeam,
      competition: event.competition,
      startTime: event.startTime.toISOString(),
      providers: Object.keys(event.providers),
      providerEventIds,
      families: familyResults,
      liveScore,
      suspended: event.suspended,
      matchSource: event.matchSource,
      matchConfidence: event.matchConfidence,
    });
  }

  const now = Date.now();
  const liveEventIds = eventResults
    .filter((e) => {
      const startTime = new Date(e.startTime).getTime();
      return startTime <= now && now - startTime < 3 * 60 * 60 * 1000;
    })
    .map((e) => e.providerEventIds["pinnacle"])
    .filter((id): id is string => !!id);
  if (liveEventIds.length > 0) subscribeToScores(liveEventIds);

  const providerStatus = getAllProviderStatus();
  const syncStatus = getSyncStatus();
  const connectionHealth = buildConnectionHealth();

  return {
    events: eventResults,
    summary: {
      totalEvents: cachedStats.totalEvents,
      matchedEvents: cachedStats.matchedCount,
      eventsWithValue: eventIdsWithValue.size,
      eventsWithOdds,
      totalValueBets: valuesByAtom.size,
      bestEvPct: allValueBets.length > 0 ? allValueBets[0].evPct : null,
    },
    providerCounts: cachedStats.providerCounts,
    stats: getMatchingStats(),
    pagination: {
      page,
      pageSize,
      hasMore,
      totalCount: totalBeforePagination,
      search: search || undefined,
    },
    providerStatus,
    connectionHealth,
    providerAlerts: connectionHealth.providerAlerts,
    lastUpdate: getLastUpdate()?.toISOString() || null,
    syncStatus: serializeSyncStatus(syncStatus),
    _etag: getResponseETag(),
  };
}
