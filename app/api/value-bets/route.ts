import { NextResponse } from "next/server";
import {
  getEvents,
  getAllProviderStatus,
  getLastUpdate,
  getMatchingStats,
  getSyncStatus,
  getValueBets,
  getCachedStats,
} from "@/lib/store";
import {
  getCachedResponse,
  setCachedResponse,
  checkETag,
  getResponseETag,
} from "@/lib/cache/response-cache";
import {
  startScheduler,
  stopScheduler,
  restartScheduler,
  pauseScheduler,
  resumeScheduler,
  isSchedulerPausedState,
  syncAll,
} from "@/lib/background/fetcher";
import { type ProviderKey } from "@/lib/providers/registry";
import { getFamiliesForEvent, getAllOddsForAtom } from "@/lib/atoms/store";
import { getFamily } from "@/lib/atoms/registry";
import { getCachedVigData } from "@/lib/atoms/value-detector";
import { formatFamilyLabel, formatAtomLabel } from "@/lib/formatting/labels";
import type { ValueBet } from "@/lib/atoms/types";
import type { SyncStatus } from "@/lib/store";
import {
  getDisplayScore,
  getMultiSourceDisplayScore,
  subscribeToScores,
  type DisplayScore,
  type MultiSourceDisplayScore,
  type ScoreSource,
  type ScoreConfidence,
} from "@/lib/scores";
import { getConnectionHealth as getBCConnectionHealth } from "@/lib/adapters/betconstruct/client";
import { isScoreWebSocketConnected } from "@/lib/scores/websocket";
import { isBCPollingActive, getBCPollingCount } from "@/lib/scores/bc-poller";
import { getTokenTTL } from "@/lib/auth/token-manager";

// ============================================
// Serialization Helpers
// ============================================

function serializeSyncStatus(syncStatus: SyncStatus) {
  return {
    ...syncStatus,
    lastSyncStart: syncStatus.lastSyncStart?.toISOString() || null,
    lastSyncEnd: syncStatus.lastSyncEnd?.toISOString() || null,
  };
}

// ============================================
// Response Types (for analyzed data)
// ============================================

interface AtomOddsByProvider {
  odds: number;
  timestamp: number;
  isBest: boolean;
  suspended?: boolean;
}

interface BulkAtomResult {
  atomId: string;
  label: string;
  oddsByProvider: Partial<Record<ProviderKey, AtomOddsByProvider>>;
  bestOdds: number | null;
  bestProvider: string | null;
  // Value bet info (if this atom has positive EV at any soft bookmaker)
  valueBet?: {
    // Core identifiers
    softProvider: string;
    sharpProvider: string;
    // Odds data
    softOdds: number;
    sharpOdds: number;
    // Probability data
    trueProb: number; // Vig-removed probability (0-1)
    trueOdds: number; // 1 / trueProb
    impliedProb: number; // 1 / softOdds
    // Value metrics
    evPct: number;
    edge: number; // Raw edge as decimal
    kellyFraction: number; // Full Kelly fraction
    kellyStake: number;
    // Timestamp for freshness
    timestamp: number;
    // Full family odds for manual verification
    familyOdds?: {
      totalImpliedProb: number; // Sum of 1/odds (e.g., 1.056)
      vigPct: number; // Family vig %
      atoms: {
        atomId: string;
        label: string;
        rawOdds: number;
        rawProb: number; // 1/odds
        trueProb: number; // After vig removal
      }[];
    };
  };
}

interface BulkFamilyResult {
  familyId: string;
  label: string;
  marketType: string;
  timeScope: string;
  line?: number;
  atoms: BulkAtomResult[];
}

interface ValueBetEvent {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  startTime: string;
  providers: string[];
  providerEventIds: Record<string, string>;
  families: BulkFamilyResult[];
  /** Live score data with multi-source info (only for live/in-play events) */
  liveScore?: {
    home: number;
    away: number;
    minute: number;
    period: string;
    homeRedCards: number;
    awayRedCards: number;
    // Multi-source metadata
    primarySource: ScoreSource;
    confidence: ScoreConfidence;
    hasDiscrepancy: boolean;
    alternativeScore?: {
      source: ScoreSource;
      home: number;
      away: number;
    };
  };
  /** Event-level suspension (all markets blocked) - from BetConstruct is_blocked */
  suspended?: boolean;
  /** How this event was matched (tier1-auto, tier2-deep, etc.) */
  matchSource?: string;
  /** Match confidence (0-100) */
  matchConfidence?: number;
}

// ============================================
// Analyze Events (read from store, no fetching)
// ============================================

interface AnalyzeOptions {
  selectedProviders: Set<ProviderKey> | null; // null = all providers
  selectedMarketTypes: Set<string> | null; // null = all market types
  minProviderCount: number;
}

function analyzeEvents(
  matchedEvents: ReturnType<typeof getEvents>,
  valuesByAtom: Map<string, ValueBet>,
  options: AnalyzeOptions = {
    selectedProviders: null,
    selectedMarketTypes: null,
    minProviderCount: 1,
  },
): {
  events: ValueBetEvent[];
  summary: {
    totalEvents: number;
    eventsWithOdds: number;
    totalFamilies: number;
    totalValueBets: number;
    bestEvPct: number | null;
  };
} {
  const eventResults: ValueBetEvent[] = [];
  let totalFamilies = 0;
  let eventsWithOdds = 0;
  let totalValueBetsInView = 0;
  let bestEvPct: number | null = null;

  for (const event of matchedEvents) {
    // Get families with odds for this event
    const familyIds = getFamiliesForEvent(event.id);
    if (familyIds.length > 0) eventsWithOdds++;

    // Build family results
    const familyResults: BulkFamilyResult[] = [];

    for (const familyId of familyIds) {
      const family = getFamily(familyId);
      if (!family) continue;

      // Filter by market type (server-side)
      if (
        options.selectedMarketTypes &&
        !options.selectedMarketTypes.has(family.market_type)
      )
        continue;

      totalFamilies++;
      const atomResults: BulkAtomResult[] = [];

      for (const atomId of family.atoms) {
        const allOdds = getAllOddsForAtom(event.id, familyId, atomId);

        const oddsByProvider: Partial<Record<ProviderKey, AtomOddsByProvider>> =
          {};
        let bestOddsVal: number | null = null;
        let bestProviderVal: ProviderKey | null = null;

        for (const [provider, record] of allOdds) {
          // Filter by selected providers (server-side)
          if (
            options.selectedProviders &&
            !options.selectedProviders.has(provider)
          )
            continue;

          const isBest = bestOddsVal === null || record.odds > bestOddsVal;
          if (isBest && !record.suspended) {
            bestOddsVal = record.odds;
            bestProviderVal = provider;
          }

          oddsByProvider[provider] = {
            odds: record.odds,
            timestamp: record.timestamp,
            isBest: false, // Will be set below
            suspended: record.suspended,
          };
        }

        // Mark the best provider
        if (bestProviderVal && oddsByProvider[bestProviderVal]) {
          oddsByProvider[bestProviderVal]!.isBest = true;
        }

        // Skip atoms with fewer providers than required
        if (Object.keys(oddsByProvider).length < options.minProviderCount)
          continue;

        // Look up value bet for this atom (key: eventId:familyId:atomId)
        const valueKey = `${event.id}:${familyId}:${atomId}`;
        const valueBet = valuesByAtom.get(valueKey);

        const atomResult: BulkAtomResult = {
          atomId,
          label: formatAtomLabel(atomId),
          oddsByProvider,
          bestOdds: bestOddsVal,
          bestProvider: bestProviderVal,
        };

        // Add value bet info if exists
        if (valueBet) {
          // Use pre-computed vig data from detection phase (no re-calculation)
          const familyTrueOdds = getCachedVigData(event.id, familyId) ?? null;

          atomResult.valueBet = {
            // Core identifiers
            softProvider: valueBet.softProvider,
            sharpProvider: valueBet.sharpProvider,
            // Odds data
            softOdds: valueBet.softOdds,
            sharpOdds: valueBet.sharpOdds,
            // Probability data
            trueProb: valueBet.trueProb,
            trueOdds: valueBet.trueOdds,
            impliedProb: valueBet.impliedProb,
            // Value metrics
            evPct: valueBet.evPct,
            edge: valueBet.edge,
            kellyFraction: valueBet.kellyFraction,
            kellyStake: valueBet.kellyStake,
            // Timestamp for freshness
            timestamp: valueBet.timestamp,
            // Full family odds for verification
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
          totalValueBetsInView++;
          if (bestEvPct === null || valueBet.evPct > bestEvPct) {
            bestEvPct = valueBet.evPct;
          }
        }

        atomResults.push(atomResult);
      }

      // Skip families with no atoms (all filtered out by provider/min count)
      if (atomResults.length === 0) continue;

      const familyResult: BulkFamilyResult = {
        familyId,
        label: formatFamilyLabel(familyId),
        marketType: family.market_type,
        timeScope: family.time_scope,
        line: family.line,
        atoms: atomResults,
      };

      familyResults.push(familyResult);
    }

    // Build provider event IDs map for raw data fetching
    const providerEventIds: Record<string, string> = {};
    for (const [provider, data] of Object.entries(event.providers)) {
      if (data?.eventId) {
        providerEventIds[provider] = data.eventId;
      }
    }

    // Get live score with multi-source fallback
    // First try multi-source store (keyed by normalized event ID)
    // Falls back to legacy Pinnacle-only store
    let liveScore: ValueBetEvent["liveScore"] | undefined;
    const multiScore = getMultiSourceDisplayScore(event.id);
    if (multiScore) {
      liveScore = multiScore;
    } else {
      // Fallback to legacy Pinnacle-only score
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

  return {
    events: eventResults,
    summary: {
      totalEvents: matchedEvents.length,
      eventsWithOdds,
      totalFamilies,
      totalValueBets: totalValueBetsInView,
      bestEvPct,
    },
  };
}

// ============================================
// GET Handler - Returns everything
// ============================================

export async function GET(request: Request) {
  // Fast path: ETag check before doing ANY work
  // If client already has the latest data version, return 304 (zero computation)
  const notModified = checkETag(request);
  if (notModified) return notModified;

  // Parse query params
  const url = new URL(request.url);
  // Pagination params
  const page = parseInt(url.searchParams.get("page") || "0");
  const pageSize = parseInt(url.searchParams.get("pageSize") || "50");
  const search = (url.searchParams.get("search") || "").toLowerCase().trim();

  // Value bet filter params (server-side filtering)
  const showOnlyValue = url.searchParams.get("showOnlyValue") === "true";
  const evMin = parseFloat(url.searchParams.get("evMin") || "0");
  const evMax = parseFloat(url.searchParams.get("evMax") || "100");
  const oddsMin = parseFloat(url.searchParams.get("oddsMin") || "1.0");
  const oddsMax = parseFloat(url.searchParams.get("oddsMax") || "10.0");
  const softProvidersParam = url.searchParams.get("softProviders");
  const softProviders = softProvidersParam
    ? softProvidersParam.split(",").filter(Boolean)
    : [];

  // Server-side display filters (provider exclusion, time, market types, min providers)
  const providersParam = url.searchParams.get("providers");
  const selectedProviders: Set<ProviderKey> | null = providersParam
    ? new Set(providersParam.split(",").filter(Boolean) as ProviderKey[])
    : null; // null = all providers
  const timeFilter = (url.searchParams.get("timeFilter") || "all") as
    | "all"
    | "live"
    | "upcoming";
  const marketTypesParam = url.searchParams.get("marketTypes");
  const selectedMarketTypes: Set<string> | null = marketTypesParam
    ? new Set(marketTypesParam.split(",").filter(Boolean))
    : null; // null = all market types
  const minProviderCount = parseInt(
    url.searchParams.get("minProviderCount") || "1",
  );

  // Field-selection: when ?fields= is provided, only compute/return requested sections.
  // When absent, return everything (backward compatible).
  const VALID_FIELDS = new Set([
    "events",
    "summary",
    "providerCounts",
    "providerStatus",
    "connectionHealth",
    "syncStatus",
    "stats",
    "pagination",
  ]);
  const fieldsParam = url.searchParams.get("fields");
  const requestedFields: Set<string> | null = fieldsParam
    ? new Set(
        fieldsParam
          .split(",")
          .map((f) => f.trim())
          .filter((f) => VALID_FIELDS.has(f)),
      )
    : null; // null means "return everything"

  // Helper: check if a field is needed (always true when no fields param)
  const needsField = (field: string) =>
    requestedFields === null || requestedFields.has(field);

  // Determine if we need the expensive event analysis (events or summary require it)
  const needsEventAnalysis =
    needsField("events") || needsField("summary") || needsField("pagination");

  // Always fetch fresh (real-time status) — but only if requested
  const providerStatus =
    needsField("providerStatus") || needsField("connectionHealth")
      ? getAllProviderStatus()
      : undefined;
  const lastUpdate = needsField("syncStatus") ? getLastUpdate() : undefined;
  const syncStatus = needsField("syncStatus") ? getSyncStatus() : undefined;

  // Get connection health for all providers (only if requested)
  let connectionHealth: Record<string, unknown> | undefined;
  if (needsField("connectionHealth")) {
    const ps = providerStatus ?? getAllProviderStatus();
    const bcHealth = getBCConnectionHealth();
    const pinnacleTokenTTL = getTokenTTL();
    const nwExchangeStatus = ps["ninewickets-exchange"];
    const nwSportsbookStatus = ps["ninewickets-sportsbook"];

    connectionHealth = {
      betconstruct: {
        connected: bcHealth.connected,
        consecutiveTimeouts: bcHealth.consecutiveTimeouts,
        isReconnecting: bcHealth.isReconnecting,
        pendingRequests: bcHealth.pendingRequests,
      },
      pinnacle: {
        hasToken: pinnacleTokenTTL !== null && pinnacleTokenTTL > 0,
        tokenTTL: pinnacleTokenTTL,
        expiresIn:
          pinnacleTokenTTL !== null
            ? `${Math.round(pinnacleTokenTTL / 60000)}m`
            : null,
      },
      "ninewickets-exchange": {
        status: nwExchangeStatus?.status ?? "unknown",
        lastFetch: nwExchangeStatus?.lastFetch?.toISOString() ?? null,
        error: nwExchangeStatus?.error ?? null,
      },
      "ninewickets-sportsbook": {
        status: nwSportsbookStatus?.status ?? "unknown",
        lastFetch: nwSportsbookStatus?.lastFetch?.toISOString() ?? null,
        error: nwSportsbookStatus?.error ?? null,
      },
      // Score providers (separate from odds providers)
      scores: {
        pinnacleWs: {
          connected: isScoreWebSocketConnected(),
        },
        bcPoller: {
          active: isBCPollingActive(),
          eventCount: getBCPollingCount(),
        },
      },
    };
  }

  // Fast path for field-selected requests that don't need event analysis
  // Skip cache and heavy computation entirely
  if (
    requestedFields !== null &&
    !needsEventAnalysis &&
    !needsField("providerCounts") &&
    !needsField("stats")
  ) {
    const response: Record<string, unknown> = {};
    if (needsField("providerStatus") && providerStatus)
      response.providerStatus = providerStatus;
    if (needsField("connectionHealth") && connectionHealth)
      response.connectionHealth = connectionHealth;
    if (needsField("syncStatus") && syncStatus) {
      response.lastUpdate = lastUpdate?.toISOString() || null;
      response.syncStatus = serializeSyncStatus(syncStatus);
    }
    return NextResponse.json(response, {
      headers: {
        ETag: getResponseETag(),
        "Cache-Control": "private, no-cache",
      },
    });
  }

  // Check response cache first
  // Only use cache for default filters (first page, no search, no value filters, no display filters)
  const hasDisplayFilters =
    selectedProviders !== null ||
    timeFilter !== "all" ||
    selectedMarketTypes !== null ||
    minProviderCount > 1;
  const canUseCache =
    requestedFields === null &&
    page === 0 &&
    !search &&
    !showOnlyValue &&
    !hasDisplayFilters;
  const cached = canUseCache ? getCachedResponse(true) : null;
  if (cached) {
    // Return cached data with fresh status
    return NextResponse.json(
      {
        ...cached,
        providerStatus: providerStatus ?? getAllProviderStatus(),
        connectionHealth:
          connectionHealth ??
          (() => {
            // Compute connectionHealth on cache hit (cheap status data)
            const ps = providerStatus ?? getAllProviderStatus();
            const bcH = getBCConnectionHealth();
            const pTTL = getTokenTTL();
            const nwE = ps["ninewickets-exchange"];
            const nwS = ps["ninewickets-sportsbook"];
            return {
              betconstruct: {
                connected: bcH.connected,
                consecutiveTimeouts: bcH.consecutiveTimeouts,
                isReconnecting: bcH.isReconnecting,
                pendingRequests: bcH.pendingRequests,
              },
              pinnacle: {
                hasToken: pTTL !== null && pTTL > 0,
                tokenTTL: pTTL,
                expiresIn:
                  pTTL !== null ? `${Math.round(pTTL / 60000)}m` : null,
              },
              "ninewickets-exchange": {
                status: nwE?.status ?? "unknown",
                lastFetch: nwE?.lastFetch?.toISOString() ?? null,
                error: nwE?.error ?? null,
              },
              "ninewickets-sportsbook": {
                status: nwS?.status ?? "unknown",
                lastFetch: nwS?.lastFetch?.toISOString() ?? null,
                error: nwS?.error ?? null,
              },
              scores: {
                pinnacleWs: { connected: isScoreWebSocketConnected() },
                bcPoller: {
                  active: isBCPollingActive(),
                  eventCount: getBCPollingCount(),
                },
              },
            };
          })(),
        lastUpdate: (lastUpdate ?? getLastUpdate())?.toISOString() || null,
        syncStatus: serializeSyncStatus(syncStatus ?? getSyncStatus()),
      },
      {
        headers: {
          ETag: getResponseETag(),
          "Cache-Control": "private, no-cache",
        },
      },
    );
  }

  // Cache miss - compute response
  const allEvents = needsEventAnalysis ? getEvents() : [];
  const cachedStats =
    needsField("summary") || needsField("providerCounts")
      ? getCachedStats()
      : undefined;

  // Get pre-computed value bets (already sorted by EV% at sync-time)
  const allValueBets = needsEventAnalysis ? getValueBets() : [];

  // Build lookup map: "eventId:familyId:atomId" -> best value bet for that atom
  // If multiple soft books have value, we keep the one with highest EV%
  // Apply value bet filters when showOnlyValue is enabled
  const valuesByAtom = new Map<string, ValueBet>();
  const eventIdsWithValue = new Set<string>();
  for (const vb of allValueBets) {
    // Apply value bet filters (only when showOnlyValue is active)
    if (showOnlyValue) {
      // Filter by EV range
      if (vb.evPct < evMin || vb.evPct > evMax) continue;
      // Filter by soft odds range
      if (vb.softOdds < oddsMin || vb.softOdds > oddsMax) continue;
      // Filter by soft provider (empty array means all)
      if (softProviders.length > 0 && !softProviders.includes(vb.softProvider))
        continue;
    }

    const key = `${vb.eventId}:${vb.familyId}:${vb.atomId}`;
    const existing = valuesByAtom.get(key);
    // Keep highest EV% for each atom (already sorted, so first one wins)
    if (!existing || vb.evPct > existing.evPct) {
      valuesByAtom.set(key, vb);
    }
    eventIdsWithValue.add(vb.eventId);
  }

  // Choose which events to analyze
  const eventsWithValue = allEvents.filter((e) => eventIdsWithValue.has(e.id));
  let eventsToAnalyze: typeof allEvents;
  if (showOnlyValue) {
    eventsToAnalyze = eventsWithValue;
  } else {
    eventsToAnalyze = allEvents;
  }

  // Apply time filter (server-side)
  if (timeFilter !== "all") {
    const now = Date.now();
    eventsToAnalyze = eventsToAnalyze.filter((e) => {
      const eventStart = e.startTime.getTime();
      if (timeFilter === "live") return eventStart <= now;
      if (timeFilter === "upcoming") return eventStart > now;
      return true;
    });
  }

  // Apply search filter
  let totalBeforePagination = eventsToAnalyze.length;
  if (search) {
    eventsToAnalyze = eventsToAnalyze.filter(
      (e) =>
        e.homeTeam.toLowerCase().includes(search) ||
        e.awayTeam.toLowerCase().includes(search) ||
        e.competition.toLowerCase().includes(search),
    );
    totalBeforePagination = eventsToAnalyze.length;
  }

  // Sort by start time
  eventsToAnalyze.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  // Apply pagination
  let hasMore = false;
  {
    const start = page * pageSize;
    const end = start + pageSize;
    hasMore = end < eventsToAnalyze.length;
    eventsToAnalyze = eventsToAnalyze.slice(start, end);
  }

  // Analyze events (with server-side provider/market/minProvider filtering)
  const analyzed = needsEventAnalysis
    ? analyzeEvents(eventsToAnalyze, valuesByAtom, {
        selectedProviders,
        selectedMarketTypes,
        minProviderCount,
      })
    : {
        events: [],
        summary: {
          totalEvents: 0,
          eventsWithOdds: 0,
          totalFamilies: 0,
          totalValueBets: 0,
          bestEvPct: null,
        },
      };

  // Subscribe to live score updates for live events (only when events are analyzed)
  if (needsEventAnalysis) {
    const now = Date.now();
    const liveEventIds = analyzed.events
      .filter((e) => {
        const startTime = new Date(e.startTime).getTime();
        return startTime <= now && now - startTime < 3 * 60 * 60 * 1000;
      })
      .map((e) => e.providerEventIds["pinnacle"])
      .filter((id): id is string => !!id);

    if (liveEventIds.length > 0) {
      subscribeToScores(liveEventIds);
    }
  }

  // Build cacheable response (only include requested fields when field-selection is active)
  const cacheableResponse: Record<string, unknown> = {};

  if (needsField("events")) {
    cacheableResponse.events = analyzed.events;
  }
  if (needsField("summary") && cachedStats) {
    cacheableResponse.summary = {
      totalEvents: cachedStats.totalEvents,
      matchedEvents: cachedStats.matchedCount,
      eventsWithValue: eventIdsWithValue.size,
      eventsWithOdds: analyzed.summary.eventsWithOdds,
      totalValueBets: allValueBets.length,
      bestEvPct: allValueBets.length > 0 ? allValueBets[0].evPct : null,
    };
  }
  if (needsField("providerCounts") && cachedStats) {
    cacheableResponse.providerCounts = cachedStats.providerCounts;
  }
  if (needsField("stats")) {
    cacheableResponse.stats = getMatchingStats();
  }
  // Pagination metadata
  if (needsField("pagination")) {
    cacheableResponse.pagination = {
      page,
      pageSize,
      hasMore,
      totalCount: totalBeforePagination,
      search: search || undefined,
    };
  }

  // Cache for next request (only when returning full response with default filters)
  if (
    requestedFields === null &&
    !showOnlyValue &&
    !hasDisplayFilters &&
    page === 0 &&
    !search
  ) {
    setCachedResponse(cacheableResponse, true);
  }

  // Add real-time status fields (only if requested)
  const response: Record<string, unknown> = { ...cacheableResponse };
  if (needsField("providerStatus")) {
    response.providerStatus = providerStatus ?? getAllProviderStatus();
  }
  if (needsField("connectionHealth")) {
    response.connectionHealth = connectionHealth;
  }
  if (needsField("syncStatus")) {
    response.lastUpdate =
      (lastUpdate ?? getLastUpdate())?.toISOString() || null;
    response.syncStatus = serializeSyncStatus(syncStatus ?? getSyncStatus());
  }

  return NextResponse.json(response, {
    headers: {
      ETag: getResponseETag(),
      "Cache-Control": "private, no-cache",
    },
  });
}

// ============================================
// POST Handler - Actions (sync, scheduler)
// ============================================

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, interval } = body;

    switch (action) {
      case "startScheduler":
        startScheduler();
        break;
      case "stopScheduler":
        stopScheduler();
        break;
      case "restartScheduler":
        restartScheduler(interval);
        break;
      case "pauseScheduler":
        pauseScheduler();
        break;
      case "resumeScheduler":
        resumeScheduler();
        break;
      case "syncNow":
        // Fire-and-forget
        syncAll();
        break;
      default:
        return NextResponse.json(
          { ok: false, error: "Unknown action" },
          { status: 400 },
        );
    }

    const syncStatus = getSyncStatus();
    return NextResponse.json({
      ok: true,
      syncStatus: serializeSyncStatus(syncStatus),
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request" },
      { status: 400 },
    );
  }
}
