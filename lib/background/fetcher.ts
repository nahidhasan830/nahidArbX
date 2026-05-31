import { getEnabledAdapters } from "../adapters";
import { getProviderPolicy } from "../shared/circuit-breaker";
import {
  setEvents,
  setProviderStatus,
  setSyncStatus,
  setValueBets,
  getMatchedEvents,
  getAllProviderStatus,
} from "../store";
import { matchEvents } from "../matching";

import type { NormalizedEvent } from "../types";

import { logger } from "../shared/logger";
import { getTokenTTL, refreshTokenIfNeeded } from "../auth/token-manager";
import {
  FIXTURE_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
} from "../shared/constants";
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

/**
 * How often to poll the book's myBets feed for pending-bet
 * confirmations. 30s is tight enough that confirmations feel instant
 * to the operator without hammering the book; orphan-purge uses a
 * separate 5-minute TTL (see `lib/betting/ninewickets/reconciler.ts`).
 */
const RECONCILE_INTERVAL_MS = 30_000;

// Pinned to globalThis so route-handler inspectors (isSchedulerRunning,
// isSchedulerPausedState) see the same flags as the scheduler loops
// running from instrumentation.ts. Without this, every module-context
// copy starts inactive/unpaused and POSTs from the route would start a
// second scheduler while the first keeps running.
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

/**
 * Pause the Tier 1 scheduler.
 * Current in-flight sync finishes, then syncs are skipped until resumed.
 * The scheduler timers keep ticking so resume is instant.
 */
export function pauseScheduler(): void {
  if (sch.active && !sch.paused) {
    sch.paused = true;
    logger.info(
      "Sync",
      "Scheduler paused — syncs will be skipped until resumed",
    );
  }
}

/**
 * Resume a paused Tier 1 scheduler.
 */
export function resumeScheduler(): void {
  if (sch.paused) {
    sch.paused = false;
    logger.info("Sync", "Scheduler resumed");
  }
}

export function isSchedulerPausedState(): boolean {
  return sch.paused;
}

/**
 * Phase 1-2: Fetch fixtures from all providers and match them
 * Runs every 2 minutes (events don't change often)
 */
export async function syncFixturesOnly(): Promise<NormalizedEvent[]> {
  if (sch.fixturesSyncing) {
    logger.debug("Sync", "Fixtures sync already in progress, skipping");
    return getMatchedEvents();
  }

  sch.fixturesSyncing = true;
  const startTime = Date.now();

  try {
    // Proactive token refresh - refresh Pinnacle token if expiring within 20 mins
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

    // Phase 1: Fixtures
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

    // Pull events from all providers in parallel
    const results = await Promise.allSettled(
      adapters.map(async (adapter) => {
        const policy = getProviderPolicy(adapter.name);
        try {
          const events = await policy.execute(() => adapter.fetchEvents());

          setProviderStatus(adapter.name, {
            status: "ok",
            lastFetch: new Date(),
          });

          return { provider: adapter.name, events };
        } catch (error) {
          logger.error("Sync", `${adapter.name} error:`, error);
          setProviderStatus(adapter.name, {
            status: "error",
            lastFetch: new Date(),
            error: error instanceof Error ? error.message : "Unknown error",
          });
          return { provider: adapter.name, events: [] };
        }
      }),
    );

    // Collect all events
    const fetchBatchId = `fixtures-${Date.now()}`;
    const snapshotInputs: Parameters<typeof captureProviderSnapshots>[0] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        allEvents.push(...result.value.events);
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

    // Guard: if ALL adapters returned 0 events but we previously had data,
    // this is almost certainly a transient failure (timeouts, circuit breakers,
    // network issues). Preserve the existing events store to avoid wiping the
    // table while the badge still shows stale value bet counts.
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
      return getMatchedEvents();
    }

    // Phase 2: Matching
    setSyncStatus({ currentPhase: "matching", phaseProgress: null });

    // Match events across providers
    const matchedEvents = await matchEvents(allEvents);

    // Count events with multiple providers
    const multiProviderCount = matchedEvents.filter(
      (e) => Object.keys(e.providers).length > 1,
    ).length;

    logger.info(
      "Sync",
      `Matched: ${multiProviderCount} events across providers`,
    );

    // Register event ID mappings for multi-source score tracking
    registerScoreEventMappings(matchedEvents);

    // Start BC score polling for events currently playing or about to kick off.
    //
    // This is SETTLEMENT support — we placed these bets pre-match and need
    // live scores to resolve outcomes, NOT in-play value detection. The value
    // detector / odds fetcher are gated to pre-match only (see filter below
    // and in the odds-fetch return path). See `in-play.md`.
    startBCScorePollingForLiveEvents(matchedEvents);

    // Store matched events with raw count for stats
    setEvents(matchedEvents, allEvents.length);

    // If the events store is now legitimately empty (all events expired or
    // genuinely removed), clear stale value bets to prevent the badge from
    // showing a count while the table is empty.
    if (matchedEvents.length === 0) {
      setValueBets([]);
    }

    // NOTE: we intentionally do NOT call resetValueCache() here.
    // The incremental detector already prunes events that leave the
    // active set (value-detector.ts L104-111). Resetting after
    // fixtures caused value bets to be lost: the matching phase can
    // hang for several minutes, so by the time
    // the post-fixture odds sync runs, sharp odds are stale (>90s
    // staleness gate) and the full recompute returns zero bets.
    // Removing this reset lets valid cached value bets survive across
    // fixture boundaries.

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info("Sync", `Fixtures complete in ${duration}s`);

    // Notify SSE clients
    syncBus.emitBus({
      type: "fixtures:complete",
      matchedEvents: multiProviderCount,
      rawEvents: allEvents.length,
    });

    // Fixtures changed — signal full refresh for delta tracking
    const fixturesDelta = signalFixturesChanged(syncBus.version);
    syncBus.emitBus({ type: "data:delta", delta: fixturesDelta });

    // Return matched events for odds fetching. Strategy & limits controls
    // whether value-detection odds are kept for pre-match, in-play, or both.
    // The default remains pre-match only. A small +5 min pre-match grace is
    // retained so closing-line capture succeeds for events that kick off
    // between sync cycles.
    //
    // Note: score polling and score-event-mapping registration happen
    // ABOVE this filter — they intentionally see the full matched set so
    // settlement can track scores for pre-match bets whose matches are now
    // live or finished.
    const nowMs = Date.now();
    const closingCaptureGraceMs = 5 * 60 * 1000;
    const inPlayOddsWindowMs = 3 * 60 * 60 * 1000;
    const { row: bettingSettings } = await getBettingSettings();
    const detectionPhases = bettingSettings.valueDetectionPhases;
    return matchedEvents
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
  } finally {
    sch.fixturesSyncing = false;

    // Notify queue scheduler that fixtures are done
    if (sch.onFixDone) {
      sch.onFixDone();
    }
  }
}

/**
 * Full sync: fixtures + matching, then trigger reactive detection.
 * Used for initial sync and manual "Sync Now".
 */
export async function syncAll(): Promise<void> {
  const startTime = Date.now();

  // Phase 1-2: Fixtures + Matching
  await syncFixturesOnly();

  // Trigger reactive detection immediately (consumes any dirty families
  // that accumulated during fixture sync)
  triggerDetection();

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info("Sync", `Full sync complete in ${duration}s`);
}

/**
 * Start scheduler:
 * - Fixtures every 2 minutes (events don't change often)
 * - Value detection is event-driven via reactive-detector.ts
 */
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

  // ==========================================
  // Register Health Providers
  // ==========================================

  // BetConstruct WebSocket health — only register when BC is enabled
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

  // Scores WebSocket health
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

  // Pinnacle token health
  registerHealthProvider("pinnacle", () => {
    const ttl = getTokenTTL();
    const hasValidToken = ttl !== null && ttl > 0;
    const isExpiringSoon = ttl !== null && ttl < 300000; // < 5 minutes

    return {
      status: hasValidToken
        ? isExpiringSoon
          ? "degraded"
          : "healthy"
        : "unhealthy",
      lastCheck: Date.now(),
      consecutiveFailures: hasValidToken ? 0 : 1,
      details: {
        hasToken: hasValidToken,
        tokenTTL: ttl,
        expiresIn: ttl !== null ? `${Math.round(ttl / 60000)}m` : null,
      },
    };
  });

  // NineWickets Exchange health (HTTP-based)
  registerHealthProvider("ninewickets-exchange", () => {
    const providerStatus = getAllProviderStatus();
    const nwExchange = providerStatus["ninewickets-exchange"];
    const isOk = nwExchange?.status === "ok";
    const lastFetch = nwExchange?.lastFetch;
    const isStale = lastFetch
      ? Date.now() - new Date(lastFetch).getTime() > 300000
      : true; // > 5 min

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

  // NineWickets Sportsbook health (HTTP-based)
  registerHealthProvider("ninewickets-sportsbook", () => {
    const providerStatus = getAllProviderStatus();
    const nwSportsbook = providerStatus["ninewickets-sportsbook"];
    const isOk = nwSportsbook?.status === "ok";
    const lastFetch = nwSportsbook?.lastFetch;
    const isStale = lastFetch
      ? Date.now() - new Date(lastFetch).getTime() > 300000
      : true; // > 5 min

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

  // Scheduler health (self-check)
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

  // ==========================================
  // Register Healing Actions
  // ==========================================

  // BetConstruct reconnect
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

  // Scores WebSocket reconnect
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

  // Pinnacle token refresh
  registerHealingAction("pinnacle", async () => {
    logger.info("Sync", "Healing Pinnacle token...");
    try {
      await refreshTokenIfNeeded();
      const ttl = getTokenTTL();
      return ttl !== null && ttl > 0;
    } catch (error) {
      logger.error("Sync", "Pinnacle token healing failed:", error);
      return false;
    }
  });

  // ==========================================
  // Fatal Failure Handler (Health Manager)
  // ==========================================
  onHealthFatalFailure(() => {
    logger.error(
      "Sync",
      "FATAL: Health manager detected unrecoverable state - restarting server",
    );
    process.exit(1);
  });

  // ==========================================
  // Start Health Monitoring
  // ==========================================
  startHealthMonitoring();

  // ==========================================
  // Provider Auto-Heal Callbacks
  // ==========================================

  // When BetConstruct reconnects after failure, re-subscribe all events
  // (Swarm subscriptions are lost when the session reconnects) and trigger detection
  if (isProviderRuntimeEnabled("betconstruct")) {
    onBCReconnect(() => {
      logger.info(
        "Sync",
        "BetConstruct reconnected - re-subscribing all events",
      );
      invalidateResponseCache();
      // Lazy import to avoid circular dependency
      import("../services/betconstruct-sync-service").then(
        ({ betconstructSyncService }) => {
          betconstructSyncService.resubscribeAll();
        },
      );
      triggerDetection();
    });

    // When BetConstruct fails catastrophically (5+ consecutive reconnect failures),
    // restart the entire server process
    onBCFatalFailure(() => {
      logger.error(
        "Sync",
        "FATAL: BetConstruct connection unrecoverable after 5 attempts - restarting server",
      );
      // Exit with code 1 - process manager (pm2, docker, systemd) will restart us
      process.exit(1);
    });
  }

  // When Scores WebSocket reconnects, log it (subscriptions auto-restore)
  onScoresReconnect(() => {
    logger.info(
      "Sync",
      "Scores WebSocket reconnected - subscriptions restored",
    );
  });

  // Event matcher runs in-process against provider snapshots captured during
  // fixture sync. The lab can run the same path manually.

  // Initial fixture sync (reactive detector handles value detection)
  syncAll();

  // ==========================================
  // Queue-Based Scheduler (setTimeout chains)
  // No cycles are ever skipped. After each task
  // completes, the next run is scheduled with
  // the remaining interval time.
  // ==========================================

  function scheduleNextFixtures(): void {
    if (!sch.active) return;

    sch.fixtureTimer = setTimeout(async () => {
      if (!sch.active) return;
      if (sch.paused) {
        // Skip this cycle but keep scheduling
        scheduleNextFixtures();
        return;
      }

      const syncStart = Date.now();
      await syncFixturesOnly();

      // After fixtures complete, trigger reactive detection
      // (new events may have new dirty families)
      if (sch.active) {
        triggerDetection();
      }

      // Schedule next fixture run after remaining interval time
      // (accounts for how long this cycle took)
      if (sch.active) {
        const elapsed = Date.now() - syncStart;
        const wait = Math.max(0, sch.fixtureInterval - elapsed);
        sch.fixtureTimer = setTimeout(() => {
          scheduleNextFixtures();
        }, wait);
      }
    }, sch.fixtureInterval);
  }

  // Pending-bet reconciliation loop. Independent of the fixtures/odds
  // cadence — bets placed with async confirmation need their own faster
  // tick so we surface ticket ids (and fire Telegram) within ~30s of the
  // book confirming them. Orphaned pendings older than the TTL are
  // deleted in the same pass.
  function scheduleNextReconcile(): void {
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
        const wait = Math.max(0, RECONCILE_INTERVAL_MS - (Date.now() - start));
        sch.reconcileTimer = setTimeout(() => {
          scheduleNextReconcile();
        }, wait);
      }
    }, RECONCILE_INTERVAL_MS);
  }

  function scheduleNextMl(): void {
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
        // Silent catch for matcher errors
      } finally {
        if (sch.active) {
          const wait = Math.max(0, intervalMs - (Date.now() - start));
          sch.mlTimer = setTimeout(() => {
            scheduleNextMl();
          }, wait);
        }
      }
    }, 60000);
  }

  scheduleNextFixtures();
  scheduleNextReconcile();
  scheduleNextMl();
}

export function restartScheduler(fixtureIntervalMs?: number): void {
  if (fixtureIntervalMs !== undefined) {
    sch.fixtureInterval = fixtureIntervalMs;
  }

  // Stop existing scheduler
  stopScheduler();

  // Restart with new intervals
  startScheduler();
}

export function stopScheduler(): void {
  // Stop health monitoring
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

  // Release any state
  sch.onFixDone = null;

  setSyncStatus({ isSchedulerActive: false });
  logger.info("Sync", "Scheduler stopped");
}

export function isSchedulerRunning(): boolean {
  return sch.active;
}

// ============================================
// Multi-Source Score Integration
// ============================================

/**
 * Register provider event ID mappings for all matched events
 * This allows the multi-source score store to correlate scores across providers
 */
function registerScoreEventMappings(events: NormalizedEvent[]): void {
  let registered = 0;

  for (const event of events) {
    // Only register events with multiple providers
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

/**
 * Start BC score polling for live events with both Pinnacle and BC
 */
function startBCScorePollingForLiveEvents(events: NormalizedEvent[]): void {
  const now = Date.now();
  const THREE_HOURS = 3 * 60 * 60 * 1000;

  // Find live events with BC provider
  const bcEventIds: string[] = [];

  for (const event of events) {
    // Must have BC provider
    const bcId = event.providers.betconstruct?.eventId;
    if (!bcId) continue;

    // Check if event is live or about to start (within 3 hours)
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
