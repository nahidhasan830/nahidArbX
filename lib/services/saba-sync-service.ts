import { getAtomsAdapter } from "../adapters/unified-registry";
import { sabaSocketClient } from "../betting/saba/socket-client";
import { syncBus } from "../events/event-bus";
import { isProviderRuntimeEnabled } from "../providers/runtime-state";
import { logger } from "../shared/logger";
import { getMatchedEvents } from "../store";
import { singleton } from "@/lib/util/singleton";

const PROVIDER_ID = "saba-sportsbook";
const RESCAN_INTERVAL_MS = 60_000;
const EVENT_DELAY_MS = 350;
const EMPTY_DELAY_MS = 5_000;
const ERROR_DELAY_MS = 5_000;

interface SabaSyncEntity {
  id: string;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  providers: {
    "saba-sportsbook"?: {
      eventId: string;
    };
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SabaSyncService {
  private running = false;
  private loopRunning = false;
  private rescanTimer?: NodeJS.Timeout;
  private busUnsubscribe?: () => void;
  private entities = new Map<string, SabaSyncEntity>();

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info("SabaSync", "Starting SABA Socket.IO odds sync service");

    this.syncTrackedEntities();
    this.runLoop().catch((err) => {
      logger.error(
        "SabaSync",
        `Main loop failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    this.rescanTimer = setInterval(() => {
      this.syncTrackedEntities();
    }, RESCAN_INTERVAL_MS);

    this.busUnsubscribe = syncBus.subscribe((event) => {
      if (event.type === "fixtures:complete") this.syncTrackedEntities();
    });
  }

  stop(): void {
    this.running = false;
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.rescanTimer = undefined;
    this.busUnsubscribe?.();
    this.busUnsubscribe = undefined;
    this.entities.clear();
    sabaSocketClient.deactivate();
    logger.info("SabaSync", "Stopped SABA Socket.IO odds sync service");
  }

  getStatus(): { activeEvents: number; connected: boolean; pending: number } {
    const socket = sabaSocketClient.getConnectionStatus();
    return {
      activeEvents: this.entities.size,
      connected: socket.connected,
      pending: socket.pendingRequests,
    };
  }

  private syncTrackedEntities(): void {
    if (!this.running) return;

    if (!isProviderRuntimeEnabled(PROVIDER_ID)) {
      this.entities.clear();
      sabaSocketClient.deactivate();
      return;
    }

    const tracked = getMatchedEvents() as SabaSyncEntity[];
    const next = new Map<string, SabaSyncEntity>();

    for (const entity of tracked) {
      if (!entity.providers["saba-sportsbook"]?.eventId) continue;
      next.set(entity.id, entity);
    }

    this.entities = next;
    if (this.entities.size === 0) {
      sabaSocketClient.deactivate();
    }
  }

  private async runLoop(): Promise<void> {
    if (this.loopRunning) return;
    this.loopRunning = true;

    const adapter = getAtomsAdapter(PROVIDER_ID);
    const baseAdapter = adapter as unknown as
      | {
          processRawOdds?: (
            rawData: unknown,
            ctx: Record<string, unknown>,
          ) => number;
        }
      | undefined;

    while (this.running) {
      if (!isProviderRuntimeEnabled(PROVIDER_ID)) {
        await sleep(EMPTY_DELAY_MS);
        continue;
      }

      const entities = Array.from(this.entities.values());
      if (
        entities.length === 0 ||
        typeof baseAdapter?.processRawOdds !== "function"
      ) {
        sabaSocketClient.deactivate();
        await sleep(EMPTY_DELAY_MS);
        continue;
      }

      for (const entity of entities) {
        if (!this.running) break;
        const mapping = entity.providers["saba-sportsbook"];
        if (!mapping?.eventId) continue;

        try {
          const snapshot = await sabaSocketClient.requestFullMatchOdds(
            mapping.eventId,
          );
          baseAdapter.processRawOdds(
            { rows: snapshot.rows },
            {
              providerEventId: mapping.eventId,
              normalizedEventId: entity.id,
              homeTeam: entity.homeTeam,
              awayTeam: entity.awayTeam,
              options: {},
            },
          );
        } catch (err) {
          logger.warn(
            "SabaSync",
            `Odds fetch failed for ${mapping.eventId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          await sleep(ERROR_DELAY_MS);
        }

        await sleep(EVENT_DELAY_MS);
      }
    }

    this.loopRunning = false;
  }
}

export const sabaSyncService = singleton(
  "saba:sync-service",
  () => new SabaSyncService(),
);
