import { logger } from "../shared/logger";
import { getMatchedEvents } from "../store";
import { isProviderRuntimeEnabled } from "../providers/runtime-state";
import { singleton } from "@/lib/util/singleton";
import { syncBus } from "../events/event-bus";
import { getAtomsAdapter } from "../adapters/unified-registry";
import {
  queryGeniusSportsCatalog as queryVelkiCatalog,
  queryGeniusSportsOdds as queryVelkiOdds,
} from "../betting/velki/events-client";
import {
  overlayAuthenticatedLimits,
  type SportsbookMarket,
} from "../atoms/adapters/ninewickets-sportsbook";

// Unauthenticated 9W endpoint
const NW_ENDPOINT =
  "https://gakvx.seofmi.live/exchange/member/playerService/queryGeniusSportsEvent";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

async function queryNwCatalog(eventId: string) {
  const body = new URLSearchParams({
    apiSiteType: "5",
    eventId,
    version: "0",
    marketIds: ",",
    selectionTsList: ",",
    isDynamicUpdate: "0",
  });
  const res = await fetch(NW_ENDPOINT, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`NW Catalog HTTP ${res.status}`);
  return res.json();
}

async function queryNwOdds(
  eventId: string,
  version: number,
  marketIds: string[],
  selectionTsList: number[],
) {
  const body = new URLSearchParams({
    apiSiteType: "5",
    eventId,
    version: String(version),
    marketIds: marketIds.join(",") + ",",
    selectionTsList: selectionTsList.join(",") + ",",
    isDynamicUpdate: "1", // Fetch deltas only
  });
  const res = await fetch(NW_ENDPOINT, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`NW Odds HTTP ${res.status}`);
  return res.json();
}

interface SyncState {
  version: number;
  marketIds: string[];
  selectionTsList: number[];
  isRunning: boolean;
  lastLimitsOverlayTs: number;
  resolvedSelections?: Record<string, string>;
}

/** Minimal shape of a NormalizedEvent consumed by the sync loop. */
interface SyncEntity {
  id: string;
  homeTeam: string;
  awayTeam: string;
  competition: string;
}

/** A single Genius Sports market as returned by the catalog/odds endpoints. */
interface GeniusMarket {
  id: string | number;
  selectionTs?: number;
  min?: number;
  max?: number;
}

interface CatalogResult {
  version?: number;
  eventName?: string;
  geniusSportsMarkets?: GeniusMarket[];
}

interface OddsResult {
  version?: number;
  geniusSportsMarkets?: GeniusMarket[];
}

export class GeniusSportsSyncService {
  private isRunning = false;
  private intervalId?: NodeJS.Timeout;
  private busUnsubscribe?: () => void;

  // Track state per normalizedEventId
  private nwStates = new Map<string, SyncState>();
  private velkiStates = new Map<string, SyncState>();

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info(
      "GeniusSync",
      "Starting continuous polling sync service for 9W and Velki",
    );

    this.syncTrackedEntities();
    this.intervalId = setInterval(() => {
      this.syncTrackedEntities();
    }, 60 * 1000); // Re-evaluate active fixtures every minute

    // React immediately when fixtures finish matching (eliminates 60s boot lag)
    this.busUnsubscribe = syncBus.subscribe((event) => {
      if (event.type === "fixtures:complete") {
        this.syncTrackedEntities();
      }
    });
  }

  public stop() {
    this.isRunning = false;
    if (this.intervalId) clearInterval(this.intervalId);
    if (this.busUnsubscribe) {
      this.busUnsubscribe();
      this.busUnsubscribe = undefined;
    }

    for (const state of this.nwStates.values()) state.isRunning = false;
    for (const state of this.velkiStates.values()) state.isRunning = false;

    this.nwStates.clear();
    this.velkiStates.clear();
    logger.info("GeniusSync", "Stopped continuous polling sync service");
  }

  private syncTrackedEntities() {
    const tracked = getMatchedEvents();
    if (!tracked || tracked.length === 0) return;

    // NW Sportsbook
    if (isProviderRuntimeEnabled("ninewickets-sportsbook")) {
      const activeIds = new Set<string>();
      for (const entity of tracked) {
        const providerMapping = entity.providers["ninewickets-sportsbook"];
        if (providerMapping) {
          activeIds.add(entity.id);
          if (!this.nwStates.has(entity.id)) {
            const state: SyncState = {
              version: 0,
              marketIds: [],
              selectionTsList: [],
              isRunning: true,
              lastLimitsOverlayTs: 0,
            };
            this.nwStates.set(entity.id, state);
            // Fire and forget
            this.startLoop(
              "ninewickets-sportsbook",
              providerMapping.eventId,
              entity,
              state,
              queryNwCatalog,
              queryNwOdds,
            ).catch((err) =>
              logger.error(
                "GeniusSync",
                `[9W] Loop failed for ${entity.id}: ${err}`,
              ),
            );
          }
        }
      }
      for (const [id, state] of this.nwStates.entries()) {
        if (!activeIds.has(id)) {
          state.isRunning = false;
          this.nwStates.delete(id);
        }
      }
    } else {
      for (const state of this.nwStates.values()) state.isRunning = false;
      this.nwStates.clear();
    }

    // Velki Sportsbook
    if (isProviderRuntimeEnabled("velki-sportsbook")) {
      const activeIds = new Set<string>();
      for (const entity of tracked) {
        const providerMapping = entity.providers["velki-sportsbook"];
        if (providerMapping) {
          activeIds.add(entity.id);
          if (!this.velkiStates.has(entity.id)) {
            const state: SyncState = {
              version: 0,
              marketIds: [],
              selectionTsList: [],
              isRunning: true,
              lastLimitsOverlayTs: 0, // Velki provides limits inherently via auth
            };
            this.velkiStates.set(entity.id, state);
            // Fire and forget
            this.startLoop(
              "velki-sportsbook",
              providerMapping.eventId,
              entity,
              state,
              queryVelkiCatalog,
              queryVelkiOdds,
            ).catch((err) =>
              logger.error(
                "GeniusSync",
                `[Velki] Loop failed for ${entity.id}: ${err}`,
              ),
            );
          }
        }
      }
      for (const [id, state] of this.velkiStates.entries()) {
        if (!activeIds.has(id)) {
          state.isRunning = false;
          this.velkiStates.delete(id);
        }
      }
    } else {
      for (const state of this.velkiStates.values()) state.isRunning = false;
      this.velkiStates.clear();
    }
  }

  private async startLoop(
    providerId: "ninewickets-sportsbook" | "velki-sportsbook",
    providerEventId: string,
    entity: SyncEntity,
    state: SyncState,
    catalogFn: (id: string) => Promise<CatalogResult>,

    oddsFn: (
      id: string,
      version: number,
      markets: string[],
      tsList: number[],
    ) => Promise<OddsResult>,
  ) {
    const adapter = getAtomsAdapter(providerId);
    if (!adapter) return;

    // Access processRawOdds from BaseAtomsAdapter
    const baseAdapter = adapter as unknown as {
      processRawOdds?: (rawData: unknown, ctx: Record<string, unknown>) => void;
    };

    // Initial catalog fetch
    try {
      if (!state.isRunning) return;
      const catalog = await catalogFn(providerEventId);
      const allMarkets = catalog.geniusSportsMarkets || [];
      if (allMarkets.length > 0) {
        state.version = catalog.version || 0;
        state.marketIds = allMarkets.map((m) => String(m.id));
        state.selectionTsList = allMarkets.map((m) => m.selectionTs ?? -1);
      }

      // Pre-resolve aliases for the soft provider's own team names (if available) so that downstream
      // sync extraction can deterministically match them against Pinnacle's names.
      if (!state.resolvedSelections && catalog.eventName) {
        const { parseTeamsFromEventName } =
          await import("../shared/team-matching");
        const { resolveTeamSurface, resolveCompetitionSurface } =
          await import("../matching/entities/resolver");

        const teams = parseTeamsFromEventName(catalog.eventName);
        if (teams) {
          const resolvedSelections: Record<string, string> = {};

          let competitionId: string | null = null;
          try {
            const compRes = await resolveCompetitionSurface({
              provider: providerId,
              surface: entity.competition,
            });
            if (compRes) competitionId = compRes.entity.id;
          } catch {}

          try {
            const homeRes = await resolveTeamSurface({
              provider: providerId,
              surface: teams.home,
              competitionId,
            });
            if (homeRes)
              resolvedSelections[teams.home] = homeRes.entity.canonicalName;
          } catch {}

          try {
            const awayRes = await resolveTeamSurface({
              provider: providerId,
              surface: teams.away,
              competitionId,
            });
            if (awayRes)
              resolvedSelections[teams.away] = awayRes.entity.canonicalName;
          } catch {}

          state.resolvedSelections = resolvedSelections;
        }
      }
    } catch (err) {
      logger.error(
        "GeniusSync",
        `[${providerId}] Catalog error for ${providerEventId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      await new Promise((r) => setTimeout(r, 5000));
      if (state.isRunning) {
        this.startLoop(
          providerId,
          providerEventId,
          entity,
          state,
          catalogFn,
          oddsFn,
        );
      }
      return;
    }

    // Continuous polling
    while (state.isRunning) {
      try {
        if (state.marketIds.length === 0) {
          await new Promise((r) => setTimeout(r, 5000));
          break; // re-fetch catalog
        }

        const oddsData = await oddsFn(
          providerEventId,
          state.version,
          state.marketIds,
          state.selectionTsList,
        );

        if (!state.isRunning) break;

        if (oddsData.version) state.version = oddsData.version;

        if (
          oddsData.geniusSportsMarkets &&
          oddsData.geniusSportsMarkets.length > 0
        ) {
          // Update timestamps for next delta request
          for (const m of oddsData.geniusSportsMarkets) {
            const idx = state.marketIds.indexOf(String(m.id));
            if (idx !== -1 && m.selectionTs !== undefined) {
              state.selectionTsList[idx] = m.selectionTs;
            }
          }

          const now = Date.now();
          // Authenticated Limits Overlay for 9W (once per minute)
          if (
            providerId === "ninewickets-sportsbook" &&
            now - state.lastLimitsOverlayTs > 60 * 1000
          ) {
            await overlayAuthenticatedLimits(
              providerEventId,
              oddsData.geniusSportsMarkets as unknown as SportsbookMarket[],
            );
            state.lastLimitsOverlayTs = now;
          } else if (providerId === "ninewickets-sportsbook") {
            // Strip guest-tier limits so we don't overwrite valid account limits
            for (const m of oddsData.geniusSportsMarkets) {
              delete (m as unknown as Record<string, unknown>)["min"];
              delete (m as unknown as Record<string, unknown>)["max"];
            }
          }

          if (typeof baseAdapter.processRawOdds === "function") {
            baseAdapter.processRawOdds(
              {
                markets: oddsData.geniusSportsMarkets,
                homeTeam: entity.homeTeam,
                awayTeam: entity.awayTeam,
              },
              {
                providerEventId,
                normalizedEventId: entity.id,
                homeTeam: entity.homeTeam,
                awayTeam: entity.awayTeam,
                options: {},
                resolvedSelections: state.resolvedSelections,
              },
            );
          }
        }

        // Sleep to avoid hammering (Cloudflare protection)
        await new Promise((r) => setTimeout(r, 1500));
      } catch (err) {
        logger.error(
          "GeniusSync",
          `[${providerId}] Odds fetch error for ${providerEventId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    if (state.isRunning) {
      this.startLoop(
        providerId,
        providerEventId,
        entity,
        state,
        catalogFn,
        oddsFn,
      );
    }
  }
  /** Get active polling loop counts for the UI engine status bar. */
  public getActiveLoopCounts(): {
    ninewickets: number;
    velki: number;
  } {
    return {
      ninewickets: this.nwStates.size,
      velki: this.velkiStates.size,
    };
  }
}

export const geniusSportsSyncService = singleton(
  "genius-sports:sync-service",
  () => new GeniusSportsSyncService(),
);
