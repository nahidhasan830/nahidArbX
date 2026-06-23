import { getEnabledAdapters } from "../adapters";
import { getProviderPolicy } from "../shared/circuit-breaker";
import {
  setEvents,
  setProviderStatus,
  setSyncStatus,
  setValueBets,
  getEvents,
  getMatchedEvents,
  getAllProviderStatus,
  markProviderAttempt,
} from "../store";
import { matchEvents } from "../matching";

import type { NormalizedEvent, Provider } from "../types";

import { logger } from "../shared/logger";
import {
  getPinnacleToken,
  getTokenTTL,
  refreshTokenIfNeeded,
} from "../auth/token-manager";
import {
  FIXTURE_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
} from "../shared/constants";
import { buildConnectionHealth } from "../shared/engine-health-builder";
import { triggerDetection } from "./reactive-detector";
import { invalidateResponseCache } from "../cache/response-cache";
import { signalFixturesChanged } from "../cache/delta";
import { registerEventMappings } from "../scores/multi-source-store";
import { startBCScorePolling, stopBCScorePolling } from "../scores/bc-poller";
import type { ScoreSource } from "../scores/types";
import { syncBus } from "../events/event-bus";
import {
  onReconnect as onBCReconnect,
  onFatalFailure as onBCFatalFailure,
  getConnectionHealth as getBCConnectionHealth,
  reconnect as bcReconnect,
} from "../adapters/betconstruct/client";
import {
  registerHealthProvider,
  registerHealingAction,
  onFatalFailure as onHealthFatalFailure,
  startHealthMonitoring,
  stopHealthMonitoring,
  failureCountToStatus,
} from "../shared/health-manager";
import {
  isScoreWebSocketConnected,
  reconnect as scoresReconnect,
  getConnectionHealth as getScoresConnectionHealth,
  onReconnect as onScoresReconnect,
} from "../scores/websocket";
import { reconcilePendingBets } from "../betting/ninewickets/reconciler";
import { pinnacleWsClient } from "../adapters/pinnacle/ws-client";
import { singleton } from "../util/singleton";
import { notify } from "../notifier";
import { isProviderRuntimeEnabled } from "../providers/runtime-state";
import { getBettingSettings } from "../db/repositories/betting-settings";
import { getEventMatcherSchedulerSettings } from "../db/repositories/event-matcher-scheduler-settings";
import { getMarketPhase } from "../betting/market-phase";
import {
  captureProviderSnapshots,
  readReliabilityStats,
  runEventMatcher,
} from "../event-matcher";
import { notifyProviderHealthTransitions } from "../providers/health-telegram";

const RECONCILE_INTERVAL_MS = 30_000;

interface FixtureFetchResult {
  provider: Provider;
  events: NormalizedEvent[];
  stale: boolean;
}

function getStoredEventsForProvider(provider: Provider): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  const seen = new Set<string>();

  for (const event of getEvents()) {
    const providerInfo = event.providers[provider];
    if (!providerInfo) continue;

    const providerEvent: NormalizedEvent = {
      ...event,
      id: `${provider}-${providerInfo.eventId}`,
      providers: {
        [provider]: { ...providerInfo },
      },
      matchSource: undefined,
      matchConfidence: undefined,
    };

    if (seen.has(providerEvent.id)) continue;
    seen.add(providerEvent.id);
    events.push(providerEvent);
  }

  return events;
}

const sch = singleton("fetcher:scheduler", () => ({
  active: false,
  fixtureTimer: null as ReturnType<typeof setTimeout> | null,
  reconcileTimer: null as ReturnType<typeof setTimeout> | null,
  mlTimer: null as ReturnType<typeof setTimeout> | null,
  fixtureInterval: FIXTURE_INTERVAL_MS,
  fixturesSyncing: false,
  onFixDone: null as (() => void) | null,
  paused: false,
}));

export function pauseScheduler(): void {
  if (sch.active && !sch.paused) {
    sch.paused = true;
    logger.info(
      "Sync",
      "Scheduler paused — syncs will be skipped until resumed",
    );
  }
}

export function resumeScheduler(): void {
  if (sch.paused) {
    sch.paused = false;
    logger.info("Sync", "Scheduler resumed");
  }
}

export function isSchedulerPausedState(): boolean {
  return sch.paused;
}

export async function syncFixturesOnly(): Promise<NormalizedEvent[]> {
  if (sch.fixturesSyncing) {
    logger.debug("Sync", "Fixtures sync already in progress, skipping");
    return getMatchedEvents();
  }

  sch.fixturesSyncing = true;
  const startTime = Date.now();

  try {
    const ttl = getTokenTTL();
    if (ttl !== null && ttl > 0) {
      const mins = Math.round(ttl / 60000);
      if (mins < 20) {
        logger.info(
          "Sync",
          `Pinnacle token expires in ${mins}m, refreshing proactively`,
        );
        await refreshTokenIfNeeded();
      }
    }

    setSyncStatus({
      isSyncing: true,
      lastSyncStart: new Date(),
      currentPhase: "fixtures",
      phaseProgress: null,
    });

    const adapters = getEnabledAdapters();

    if (adapters.length === 0) {
      logger.info("Sync", "No adapters enabled");
      setSyncStatus({
        isSyncing: false,
        currentPhase: "idle",
        phaseProgress: null,
      });
      return [];
    }

    const allEvents: NormalizedEvent[] = [];

    const results = await Promise.allSettled<FixtureFetchResult>(
      adapters.map(async (adapter) => {
        const policy = getProviderPolicy(adapter.name);
        markProviderAttempt(adapter.name);
        try {
          const events = await policy.execute(() => adapter.fetchEvents());

          setProviderStatus(adapter.name, {
            status: "ok",
            lastFetch: new Date(),
          });

          return { provider: adapter.name, events, stale: false };
        } catch (error) {
          logger.error("Sync", `${adapter.name} error:`, error);
          setProviderStatus(adapter.name, {
            status: "error",
            lastFetch: new Date(),
            error: error instanceof Error ? error.message : "Unknown error",
          });
          const preservedEvents = getStoredEventsForProvider(adapter.name);
          if (preservedEvents.length > 0) {
            logger.warn(
              "Sync",
              `${adapter.name} fixture fetch failed; preserving ${preservedEvents.length} stored provider mappings for matching/subscriptions`,
            );
          }
          return {
            provider: adapter.name,
            events: preservedEvents,
            stale: preservedEvents.length > 0,
          };
        }
      }),
    );

    const fetchBatchId = `fixtures-${Date.now()}`;
    const snapshotInputs: Parameters<typeof captureProviderSnapshots>[0] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        allEvents.push(...result.value.events);
        if (result.value.stale) continue;

        for (const event of result.value.events) {
          const providerInfo = event.providers[result.value.provider];
          snapshotInputs.push({
            event,
            provider: result.value.provider,
            providerEventId: providerInfo?.eventId ?? event.id,
            fetchedAt: providerInfo?.fetchedAt,
            fetchBatchId,
            rawStartTime: event.startTime.toISOString(),
            parseStrategy: "adapter-normalized-date",
            providerMetadata: {
              provider: result.value.provider,
              suspended: event.suspended ?? false,
            },
          });
        }
      }
    }

    logger.info("Sync", `Total raw events: ${allEvents.length}`);
    captureProviderSnapshots(snapshotInputs).catch((err) => {
      logger.warn(
        "EventMatcher",
        `Snapshot capture failed: ${(err as Error).message}`,
      );
    });

    const existingEventCount = getMatchedEvents().length;
    if (allEvents.length === 0 && existingEventCount > 0) {
      logger.warn(
        "Sync",
        `All fixture adapters returned 0 events (had ${existingEventCount}) — skipping setEvents to preserve existing data`,
      );
      setSyncStatus({
        isSyncing: false,
        currentPhase: "idle",
        phaseProgress: null,
        lastSyncEnd: new Date(),
        lastSyncDuration: Date.now() - startTime,
      });
      notifyProviderHealthTransitions(
        buildConnectionHealth().providerAlerts,
      ).catch((err) => {
        logger.warn(
          "ProviderHealth",
          `Provider health notification pass failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
      return getMatchedEvents();
    }

    setSyncStatus({ currentPhase: "matching", phaseProgress: null });

    const matchedEvents = await matchEvents(allEvents);

    const multiProviderCount = matchedEvents.filter(
      (e) => Object.keys(e.providers).length > 1,
    ).length;

    logger.info(
      "Sync",
      `Matched: ${multiProviderCount} events across providers`,
    );

    registerScoreEventMappings(matchedEvents);

    startBCScorePollingForLiveEvents(matchedEvents);

    setEvents(matchedEvents, allEvents.length);

    if (matchedEvents.length === 0) {
      setValueBets([]);
    }


    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info("Sync", `Fixtures complete in ${duration}s`);

    syncBus.emitBus({
      type: "fixtures:complete",
      matchedEvents: multiProviderCount,
      rawEvents: allEvents.length,
    });

    const fixturesDelta = signalFixturesChanged(syncBus.version);
    syncBus.emitBus({ type: "data:delta", delta: fixturesDelta });

    const nowMs = Date.now();
    const closingCaptureGraceMs = 5 * 60 * 1000;
    const inPlayOddsWindowMs = 3 * 60 * 60 * 1000;
    const { row: bettingSettings } = await getBettingSettings();
    const detectionPhases = bettingSettings.valueDetectionPhases;
    const filteredEvents = matchedEvents
      .filter((e) => Object.keys(e.providers).length > 1)
      .filter((e) => {
        const startMs = new Date(e.startTime).getTime();
        if (!Number.isFinite(startMs)) return false;
        if (startMs > nowMs) return detectionPhases.includes("pre_match");
        if (startMs > nowMs - closingCaptureGraceMs) {
          return (
            detectionPhases.includes("pre_match") ||
            detectionPhases.includes("in_play")
          );
        }
        return (
          getMarketPhase(e.startTime, nowMs) === "in_play" &&
          detectionPhases.includes("in_play") &&
          startMs > nowMs - inPlayOddsWindowMs
        );
      });
    setSyncStatus({
      isSyncing: false,
      currentPhase: "idle",
      phaseProgress: null,
      lastSyncEnd: new Date(),
      lastSyncDuration: Date.now() - startTime,
    });
    notifyProviderHealthTransitions(
      buildConnectionHealth().providerAlerts,
    ).catch((err) => {
      logger.warn(
        "ProviderHealth",
        `Provider health notification pass failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
    return filteredEvents;
  } finally {
    sch.fixturesSyncing = false;

    if (sch.onFixDone) {
      sch.onFixDone();
    }
  }
}

export async function syncAll(): Promise<void> {
  const startTime = Date.now();

  await syncFixturesOnly();

  triggerDetection();

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info("Sync", `Full sync complete in ${duration}s`);
}

export function startScheduler(): void {
  if (sch.active) {
    logger.debug("Sync", "Scheduler already active");
    return;
  }

  sch.active = true;
  setSyncStatus({
    isSchedulerActive: true,
    syncInterval: HEARTBEAT_INTERVAL_MS,
  });

  logger.info(
    "Sync",
    `Scheduler started (fixtures: ${sch.fixtureInterval / 1000}s, detection: event-driven)`,
  );


  if (isProviderRuntimeEnabled("betconstruct")) {
    registerHealthProvider("betconstruct", () => {
      const health = getBCConnectionHealth();
      const failures = health.consecutiveTimeouts;
      return {
        status:
          health.connected && failures < 5
            ? failureCountToStatus(failures)
            : "unhealthy",
        lastCheck: Date.now(),
        consecutiveFailures: failures,
        details: {
          connected: health.connected,
          sessionId: health.sessionId,
          isReconnecting: health.isReconnecting,
          pendingRequests: health.pendingRequests,
        },
      };
    });
  }

  registerHealthProvider("scores", () => {
    const health = getScoresConnectionHealth();
    return {
      status: health.connected
        ? "healthy"
        : failureCountToStatus(health.consecutiveFailures),
      lastCheck: Date.now(),
      consecutiveFailures: health.consecutiveFailures,
      details: {
        connected: health.connected,
        subscribedEvents: health.subscribedEvents,
      },
    };
  });

  registerHealthProvider("pinnacle", () => {
    const ttl = getTokenTTL();
    const hasValidToken = ttl !== null && ttl > 0;
    const isExpiringSoon = ttl !== null && ttl < 300000;

    const ws = pinnacleWsClient.getConnectionStatus();
    const wsDisconnected = ws.subscribedEvents > 0 && !ws.connected;
    const wsSilent =
      ws.subscribedEvents > 0 &&
      ws.connected &&
      ws.lastMessageAt !== null &&
      Date.now() - ws.lastMessageAt > 300000;

    const unhealthy = !hasValidToken || wsDisconnected;
    const degraded = isExpiringSoon || wsSilent;

    return {
      status: unhealthy ? "unhealthy" : degraded ? "degraded" : "healthy",
      lastCheck: Date.now(),
      consecutiveFailures: unhealthy ? 1 : 0,
      details: {
        hasToken: hasValidToken,
        tokenTTL: ttl,
        expiresIn: ttl !== null ? `${Math.round(ttl / 60000)}m` : null,
        wsConnected: ws.connected,
        subscribedEvents: ws.subscribedEvents,
        lastMessageAt: ws.lastMessageAt
          ? new Date(ws.lastMessageAt).toISOString()
          : null,
      },
    };
  });

  registerHealthProvider("ninewickets-exchange", () => {
    const providerStatus = getAllProviderStatus();
    const nwExchange = providerStatus["ninewickets-exchange"];
    const isOk = nwExchange?.status === "ok";
    const lastFetch = nwExchange?.lastFetch;
    const isStale = lastFetch
      ? Date.now() - new Date(lastFetch).getTime() > 300000
      : true;

    return {
      status: isOk && !isStale ? "healthy" : isOk ? "degraded" : "unhealthy",
      lastCheck: Date.now(),
      consecutiveFailures: isOk ? 0 : 1,
      details: {
        status: nwExchange?.status ?? "unknown",
        lastFetch: lastFetch?.toISOString() ?? null,
        error: nwExchange?.error ?? null,
      },
    };
  });

  registerHealthProvider("ninewickets-sportsbook", () => {
    const providerStatus = getAllProviderStatus();
    const nwSportsbook = providerStatus["ninewickets-sportsbook"];
    const isOk = nwSportsbook?.status === "ok";
    const lastFetch = nwSportsbook?.lastFetch;
    const isStale = lastFetch
      ? Date.now() - new Date(lastFetch).getTime() > 300000
      : true;

    return {
      status: isOk && !isStale ? "healthy" : isOk ? "degraded" : "unhealthy",
      lastCheck: Date.now(),
      consecutiveFailures: isOk ? 0 : 1,
      details: {
        status: nwSportsbook?.status ?? "unknown",
        lastFetch: lastFetch?.toISOString() ?? null,
        error: nwSportsbook?.error ?? null,
      },
    };
  });

  registerHealthProvider("scheduler", () => {
    return {
      status: sch.active ? "healthy" : "unhealthy",
      lastCheck: Date.now(),
      consecutiveFailures: 0,
      details: {
        fixturesSyncing: sch.fixturesSyncing,
      },
    };
  });


  registerHealingAction("betconstruct", async () => {
    logger.info("Sync", "Healing BetConstruct connection...");
    try {
      await bcReconnect();
      return true;
    } catch (error) {
      logger.error("Sync", "BetConstruct healing failed:", error);
      return false;
    }
  });

  registerHealingAction("scores", async () => {
    logger.info("Sync", "Healing Scores WebSocket connection...");
    try {
      await scoresReconnect();
      return isScoreWebSocketConnected();
    } catch (error) {
      logger.error("Sync", "Scores healing failed:", error);
      return false;
    }
  });

  registerHealingAction("pinnacle", async () => {
    logger.info("Sync", "Healing Pinnacle (token + WebSocket)...");
    try {
      await getPinnacleToken(true);
      const ttl = getTokenTTL();
      const tokenOk = ttl !== null && ttl > 0;
      if (!tokenOk) return false;

      const ws = pinnacleWsClient.getConnectionStatus();
      const wsSilent =
        ws.connected &&
        ws.lastMessageAt !== null &&
        Date.now() - ws.lastMessageAt > 300000;
      if (ws.subscribedEvents > 0 && (!ws.connected || wsSilent)) {
        await pinnacleWsClient.forceReconnect();
      }
      return true;
    } catch (error) {
      logger.error("Sync", "Pinnacle healing failed:", error);
      return false;
    }
  });

  onHealthFatalFailure(() => {
    logger.error(
      "Sync",
      "FATAL: Health manager detected unrecoverable state - restarting server",
    );
    process.exit(1);
  });

  startHealthMonitoring();


  if (isProviderRuntimeEnabled("betconstruct")) {
    onBCReconnect(() => {
      logger.info(
        "Sync",
        "BetConstruct reconnected - re-subscribing all events",
      );
      invalidateResponseCache();
      import("../services/betconstruct-sync-service").then(
        ({ betconstructSyncService }) => {
          betconstructSyncService.resubscribeAll();
        },
      );
      triggerDetection();
    });

    onBCFatalFailure(() => {
      logger.error(
        "Sync",
        "FATAL: BetConstruct connection unrecoverable after 5 attempts - restarting server",
      );
      process.exit(1);
    });
  }

  onScoresReconnect(() => {
    logger.info(
      "Sync",
      "Scores WebSocket reconnected - subscriptions restored",
    );
  });


  syncAll().catch((err) => {
    logger.error(
      "Sync",
      `Initial sync failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });


  function scheduleNextFixtures(delayMs: number = sch.fixtureInterval): void {
    if (!sch.active) return;

    sch.fixtureTimer = setTimeout(async () => {
      if (!sch.active) return;
      if (sch.paused) {
        scheduleNextFixtures();
        return;
      }

      const syncStart = Date.now();
      await syncFixturesOnly();

      if (sch.active) {
        triggerDetection();
      }

      if (sch.active) {
        const elapsed = Date.now() - syncStart;
        scheduleNextFixtures(Math.max(0, sch.fixtureInterval - elapsed));
      }
    }, delayMs);
  }

  function scheduleNextReconcile(
    delayMs: number = RECONCILE_INTERVAL_MS,
  ): void {
    if (!sch.active) return;

    sch.reconcileTimer = setTimeout(async () => {
      if (!sch.active) return;
      if (sch.paused) {
        scheduleNextReconcile();
        return;
      }

      const start = Date.now();
      try {
        const report = await reconcilePendingBets();
        if (report.ticketsAttached > 0 || report.orphansPurged > 0) {
          logger.info(
            "Sync",
            `Reconcile: +${report.ticketsAttached} ticket(s), -${report.orphansPurged} orphan(s), ${report.pendingAfter} still pending`,
          );
        }
      } catch (err) {
        logger.warn(
          "Sync",
          `reconcilePendingBets threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (sch.active) {
        scheduleNextReconcile(
          Math.max(0, RECONCILE_INTERVAL_MS - (Date.now() - start)),
        );
      }
    }, delayMs);
  }

  function scheduleNextMl(delayMs = 60_000): void {
    if (!sch.active) return;

    sch.mlTimer = setTimeout(async () => {
      if (!sch.active) return;
      if (sch.paused) {
        scheduleNextMl();
        return;
      }

      const start = Date.now();
      let intervalMs = 60_000;
      try {
        const { row: matcherSchedule } =
          await getEventMatcherSchedulerSettings();
        intervalMs = matcherSchedule.intervalSeconds * 1000;
        if (!matcherSchedule.enabled) {
          return;
        }
        const reliability = await readReliabilityStats(200);
        const useDeepSeek = matcherSchedule.useDeepSeek && reliability.healthy;
        if (matcherSchedule.useDeepSeek && !reliability.healthy) {
          logger.warn(
            "EventMatcherScheduler",
            `Disabling DeepSeek for this run: ${reliability.degradationReason}`,
          );
        }

        const result = await runEventMatcher({
          trigger: "cron",
          mode: "apply",
          applyMerges: true,
          useDeepSeek,
          groundedReviewSkipReason:
            matcherSchedule.useDeepSeek && !reliability.healthy
              ? "degraded"
              : undefined,
          groundedReviewDegradationReason:
            matcherSchedule.useDeepSeek && !reliability.healthy
              ? reliability.degradationReason
              : null,
        });
        const merged = result.autoMerged;
        const rejected = result.autoRejected;
        const escalated = result.humanReview;
        if (result.status === "completed" && escalated > 0) {
          await notify({
            type: "ml:run_completed",
            at: new Date().toISOString(),
            processed: result.candidateCount,
            generated: result.generatedCandidateCount,
            skipped: result.skippedCandidateCount,
            merged,
            rejected,
            escalated,
            durationMs: result.durationMs,
          });
        }
      } catch (_err) {
      } finally {
        if (sch.active) {
          scheduleNextMl(Math.max(0, intervalMs - (Date.now() - start)));
        }
      }
    }, delayMs);
  }

  scheduleNextFixtures();
  scheduleNextReconcile();
  scheduleNextMl();
}

export function restartScheduler(fixtureIntervalMs?: number): void {
  if (fixtureIntervalMs !== undefined) {
    sch.fixtureInterval = fixtureIntervalMs;
  }

  stopScheduler();

  startScheduler();
}

export function stopScheduler(): void {
  stopHealthMonitoring();

  sch.active = false;

  if (sch.fixtureTimer) {
    clearTimeout(sch.fixtureTimer);
    sch.fixtureTimer = null;
  }
  if (sch.reconcileTimer) {
    clearTimeout(sch.reconcileTimer);
    sch.reconcileTimer = null;
  }
  if (sch.mlTimer) {
    clearTimeout(sch.mlTimer);
    sch.mlTimer = null;
  }

  sch.onFixDone = null;

  setSyncStatus({ isSchedulerActive: false });
  logger.info("Sync", "Scheduler stopped");
}

export function isSchedulerRunning(): boolean {
  return sch.active;
}


function registerScoreEventMappings(events: NormalizedEvent[]): void {
  let registered = 0;

  for (const event of events) {
    if (Object.keys(event.providers).length < 2) continue;

    const mappings: Partial<Record<ScoreSource, string>> = {};

    if (event.providers.pinnacle?.eventId) {
      mappings.pinnacle = event.providers.pinnacle.eventId;
    }
    if (event.providers.betconstruct?.eventId) {
      mappings.betconstruct = event.providers.betconstruct.eventId;
    }

    if (Object.keys(mappings).length > 0) {
      registerEventMappings(event.id, mappings);
      registered++;
    }
  }

  if (registered > 0) {
    logger.debug(
      "Sync",
      `Registered ${registered} events for multi-source scores`,
    );
  }
}

function startBCScorePollingForLiveEvents(events: NormalizedEvent[]): void {
  const now = Date.now();
  const THREE_HOURS = 3 * 60 * 60 * 1000;

  const bcEventIds: string[] = [];

  for (const event of events) {
    const bcId = event.providers.betconstruct?.eventId;
    if (!bcId) continue;

    const startTime = new Date(event.startTime).getTime();
    const isLiveOrNear =
      startTime < now + THREE_HOURS && startTime > now - THREE_HOURS;

    if (isLiveOrNear) {
      bcEventIds.push(bcId);
    }
  }

  if (bcEventIds.length > 0) {
    startBCScorePolling(bcEventIds);
    logger.debug("Sync", `BC score polling: ${bcEventIds.length} events`);
  } else {
    stopBCScorePolling();
  }
}
