import { logger } from "../shared/logger";
import { getMatchedEvents } from "../store";
import { isProviderRuntimeEnabled } from "../providers/runtime-state";
import { singleton } from "@/lib/util/singleton";
import { getAtomsAdapter } from "../adapters/unified-registry";
import {
  queryGeniusSportsCatalog as queryVelkiCatalog,
  queryGeniusSportsOdds as queryVelkiOdds,
} from "../betting/velki/events-client";
import { overlayAuthenticatedLimits } from "../atoms/adapters/ninewickets-sportsbook";

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
}

export class GeniusSportsSyncService {
  private isRunning = false;
  private intervalId?: NodeJS.Timeout;

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
  }

  public stop() {
    this.isRunning = false;
    if (this.intervalId) clearInterval(this.intervalId);

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entity: any, // NormalizedEvent
    state: SyncState,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    catalogFn: (id: string) => Promise<any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    oddsFn: (id: string, version: number, markets: string[], tsList: number[]) => Promise<any>,
  ) {
    const adapter = getAtomsAdapter(providerId);
    if (!adapter) return;

    // Access processRawOdds from BaseAtomsAdapter
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const baseAdapter = adapter as any;

    // Initial catalog fetch
    try {
      if (!state.isRunning) return;
      const catalog = await catalogFn(providerEventId);
      const allMarkets = catalog.geniusSportsMarkets || [];
      if (allMarkets.length > 0) {
        state.version = catalog.version || 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        state.marketIds = allMarkets.map((m: any) => String(m.id));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        state.selectionTsList = allMarkets.map((m: any) => m.selectionTs ?? -1);
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const m of oddsData.geniusSportsMarkets as any[]) {
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
              oddsData.geniusSportsMarkets,
            );
            state.lastLimitsOverlayTs = now;
          } else if (providerId === "ninewickets-sportsbook") {
            // Strip guest-tier limits so we don't overwrite valid account limits
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for (const m of oddsData.geniusSportsMarkets as any[]) {
              delete m.min;
              delete m.max;
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
