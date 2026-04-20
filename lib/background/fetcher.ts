import { getEnabledAdapters } from "../adapters";
import { getProviderPolicy } from "../shared/circuit-breaker";
import {
  setEvents,
  setProviderStatus,
  setSyncStatus,
  setValueBets,
  getMatchedEvents,
  getAllProviderStatus,
  getValueBets as store_getValueBets,
} from "../store";
import { matchEvents } from "../matching";
import { fetchAllOddsForMatchedEvents } from "../atoms/fetcher";
import {
  detectAllValueBets,
  detectAllValueBetsIncremental,
  resetValueCache,
} from "../atoms/value-detector";
import { persistValueBets } from "../db/repositories/value-bets";
import {
  getStoreStats,
  consumeDirtyFamilies,
  hasDirtyFamilies,
} from "../atoms/store";
import type { NormalizedEvent } from "../types";
import {
  getEnabledProviderIds,
  getProviderShortName,
  type ProviderKey,
} from "../providers/registry";
import { logger } from "../shared/logger";
import { getTokenTTL, refreshTokenIfNeeded } from "../auth/token-manager";
import { FIXTURE_INTERVAL_MS, ODDS_INTERVAL_MS } from "../shared/constants";
import { invalidateResponseCache } from "../cache/response-cache";
import { computeDelta, signalFixturesChanged } from "../cache/delta";
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
  oddsTimer: null as ReturnType<typeof setTimeout> | null,
  reconcileTimer: null as ReturnType<typeof setTimeout> | null,
  fixtureInterval: FIXTURE_INTERVAL_MS,
  oddsInterval: ODDS_INTERVAL_MS,
  fixturesSyncing: false,
  oddsSyncing: false,
  oddsQueued: false,
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
    for (const result of results) {
      if (result.status === "fulfilled") {
        allEvents.push(...result.value.events);
      }
    }

    logger.info("Sync", `Total raw events: ${allEvents.length}`);

    // Phase 2: Matching
    setSyncStatus({ currentPhase: "matching", phaseProgress: null });

    // Match events across providers
    const matchedEvents = matchEvents(allEvents);

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

    // Reset incremental cache — events changed, need full recomputation next odds sync
    resetValueCache();

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

    // Return matched events for odds fetching.
    //
    // PRE-MATCH ONLY gate: odds fetching, value detection, and atoms-store
    // refresh should never run against events whose kickoff has already
    // passed. The system is pre-match only — in-play detection requires
    // a different architecture (push feeds, sub-second comparisons, state
    // tracking). See `in-play.md` for the full rationale and the plan to
    // reintroduce in-play as a separate product later.
    //
    // A small +5 min grace is allowed so closing-line capture has a window
    // to succeed for events that kick off between sync cycles.
    //
    // Note: score polling and score-event-mapping registration happen
    // ABOVE this filter (lines 213, 216) — they intentionally see the full
    // matched set so settlement can track scores for pre-match bets whose
    // matches are now live or finished.
    const nowMs = Date.now();
    const closingCaptureGraceMs = 5 * 60 * 1000;
    return matchedEvents
      .filter((e) => Object.keys(e.providers).length > 1)
      .filter(
        (e) => new Date(e.startTime).getTime() > nowMs - closingCaptureGraceMs,
      );
  } finally {
    sch.fixturesSyncing = false;

    // Notify queue scheduler that fixtures are done
    if (sch.onFixDone) {
      sch.onFixDone();
    }
  }
}

/**
 * Phase 3-4: Fetch odds for matched events and detect value bets
 * Runs every 10-15 seconds (odds change frequently)
 */
export async function syncOddsOnly(
  matchedEvents?: NormalizedEvent[],
): Promise<void> {
  if (sch.oddsSyncing) {
    logger.debug("Sync", "Odds sync already in progress, skipping");
    return;
  }

  // Use provided events or get from store
  const events = matchedEvents ?? getMatchedEvents();

  if (events.length === 0) {
    // No matched events — clear stale value bets and set sync complete
    setValueBets([]);
    invalidateResponseCache();
    setSyncStatus({
      isSyncing: false,
      lastSyncEnd: new Date(),
      currentPhase: "idle",
      phaseProgress: null,
    });
    return;
  }

  sch.oddsSyncing = true;
  const startTime = Date.now();

  // Set sync status IMMEDIATELY when odds sync starts (before any async work)
  // This ensures the UI reflects the sync state right away
  setSyncStatus({
    isSyncing: true,
    currentPhase: "markets",
    phaseProgress: {
      current: 0,
      total: events.length,
      subPhase: getEnabledProviderIds()[0] ?? "fixtures",
    },
  });

  syncBus.emitBus({
    type: "sync:phase",
    phase: "markets",
    progress: { current: 0, total: events.length },
  });

  try {
    // Fetch all odds into atoms store
    const fetchStats = await fetchAllOddsForMatchedEvents(events, {
      onProgress: (phase: ProviderKey, current, total) => {
        setSyncStatus({
          phaseProgress: { current, total, subPhase: phase },
        });
      },
    });

    const totalOddsCount = fetchStats.totalOdds;
    const storeStats = getStoreStats();

    const parts = Object.entries(fetchStats.byProvider)
      .filter(([, s]) => s.odds > 0)
      .map(([id, s]) => `${s.odds} ${getProviderShortName(id)}`);
    logger.info(
      "Sync",
      `Odds: ${parts.join(", ")} (${totalOddsCount} total in ${storeStats.totalFamilies} families)`,
    );

    // Value Bet detection (INCREMENTAL)
    //
    // Defense-in-depth pre-match filter: the upstream fetcher already
    // excludes past-kickoff events from its return (see syncFixturesOnly).
    // We re-apply the filter here so any future caller that hands us an
    // event list from a different source still gets pre-match-only
    // behaviour. In-play detection requires a different architecture —
    // see `in-play.md`.
    const nowMs = Date.now();
    const preMatchEventIds = events
      .filter((e) => new Date(e.startTime).getTime() > nowMs)
      .map((e) => e.id);
    const skippedInPlay = events.length - preMatchEventIds.length;
    if (skippedInPlay > 0) {
      logger.debug(
        "Sync",
        `Value detection: ${preMatchEventIds.length} pre-match events, ${skippedInPlay} in-play/past-kickoff skipped`,
      );
    }

    // Consume dirty families for incremental detection
    const dirty = consumeDirtyFamilies();
    const dirtyCount = dirty.size;

    const valueBets = detectAllValueBetsIncremental(preMatchEventIds, dirty);

    if (dirtyCount > 0) {
      logger.debug(
        "Sync",
        `Incremental detection: ${dirtyCount} dirty families recomputed`,
      );
    }

    // Track previous count for change detection
    const prevValueCount = store_getValueBets().length;

    setValueBets(valueBets);
    invalidateResponseCache();

    if (valueBets.length > 0) {
      try {
        const persistResult = await persistValueBets(valueBets);
        logger.info(
          "Sync",
          `DB: +${persistResult.inserted} new, ~${persistResult.updated} updated` +
            (persistResult.skippedNoEvent ||
            persistResult.skippedNoFamily ||
            persistResult.errors
              ? ` (skip ${persistResult.skippedNoEvent + persistResult.skippedNoFamily}, err ${persistResult.errors})`
              : ""),
        );
      } catch (err) {
        logger.error(
          "Sync",
          `DB persistence failed: ${(err as Error).message} — sync continues`,
        );
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(
      "Sync",
      `Odds complete in ${duration}s - ${valueBets.length} value bets found`,
    );

    // Notify SSE clients
    syncBus.emitBus({
      type: "sync:complete",
      duration: Date.now() - startTime,
      valueBetCount: valueBets.length,
      dirtyFamilies: dirtyCount,
    });

    // Push delta update to SSE clients (avoids full data refetch)
    const delta = computeDelta(syncBus.version);
    syncBus.emitBus({ type: "data:delta", delta });

    if (valueBets.length !== prevValueCount) {
      syncBus.emitBus({
        type: "value:change",
        added: Math.max(0, valueBets.length - prevValueCount),
        removed: Math.max(0, prevValueCount - valueBets.length),
        total: valueBets.length,
      });
    }

    setSyncStatus({
      isSyncing: false,
      lastSyncEnd: new Date(),
      lastSyncDuration: Date.now() - startTime,
      lastMarketsCount: totalOddsCount,
      currentPhase: "idle",
      phaseProgress: null,
    });

    // Snapshot closing odds for matches kicking off in the next few minutes.
    // Swallow errors — missing closing data must not break odds sync.
    try {
      const { captureClosingOdds } = await import("./closing-capture");
      await captureClosingOdds();
    } catch (err) {
      logger.warn(
        "Sync",
        `Closing-odds capture failed: ${(err as Error).message}`,
      );
    }

    // Apply live strategies: match detected value bets against each strategy's
    // filters and record executions. Idempotent — safe to run every cycle.
    try {
      const { runStrategyMatcher } = await import("./strategy-matcher");
      await runStrategyMatcher();
    } catch (err) {
      logger.warn("Sync", `Strategy matcher failed: ${(err as Error).message}`);
    }
  } catch (error) {
    logger.error("Sync", "Error fetching odds:", error);
    // Clear value bets to avoid stale badges when odds fetch fails
    setValueBets([]);
    invalidateResponseCache();
    setSyncStatus({
      isSyncing: false,
      currentPhase: "idle",
      phaseProgress: null,
    });
  } finally {
    sch.oddsSyncing = false;
  }
}

/**
 * Full sync: fixtures + matching + odds + value-bet detection
 * Used for initial sync and manual "Sync Now"
 */
export async function syncAll(): Promise<void> {
  const startTime = Date.now();

  // Phase 1-2: Fixtures + Matching
  const matchedEvents = await syncFixturesOnly();

  // Phase 3-4: Odds + Value detection
  await syncOddsOnly(matchedEvents);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info("Sync", `Full sync complete in ${duration}s`);
}

/**
 * Start dual scheduler:
 * - Fixtures every 2 minutes (events don't change often)
 * - Odds every 15 seconds (odds change frequently)
 */
export function startScheduler(): void {
  if (sch.active) {
    logger.debug("Sync", "Scheduler already active");
    return;
  }

  sch.active = true;
  setSyncStatus({
    isSchedulerActive: true,
    syncInterval: sch.oddsInterval, // Show the faster interval in UI
  });

  logger.info(
    "Sync",
    `Dual scheduler started (fixtures: ${sch.fixtureInterval / 1000}s, odds: ${sch.oddsInterval / 1000}s)`,
  );

  // ==========================================
  // Register Health Providers
  // ==========================================

  // BetConstruct WebSocket health
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
        oddsSyncing: sch.oddsSyncing,
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

  // When BetConstruct reconnects after failure, trigger an odds sync
  onBCReconnect(() => {
    logger.info("Sync", "BetConstruct reconnected - triggering odds sync");
    invalidateResponseCache();
    // Fire and forget - don't await to avoid blocking
    syncOddsOnly().catch((err) => {
      logger.error("Sync", "Post-reconnect odds sync failed:", err);
    });
  });

  // When Scores WebSocket reconnects, log it (subscriptions auto-restore)
  onScoresReconnect(() => {
    logger.info(
      "Sync",
      "Scores WebSocket reconnected - subscriptions restored",
    );
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

  // Initial full sync
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

      // After fixtures complete, immediately trigger an odds sync
      // (don't wait for the regular odds interval)
      if (sch.active && !sch.oddsSyncing) {
        logger.debug("Sync", "Post-fixture odds sync triggered");
        await syncOddsOnly();
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

  function scheduleNextOdds(): void {
    if (!sch.active) return;

    sch.oddsTimer = setTimeout(async () => {
      if (!sch.active) return;
      if (sch.paused) {
        scheduleNextOdds();
        return;
      }

      if (sch.fixturesSyncing) {
        // Fixtures are running — wait for them to finish, then run odds immediately
        sch.oddsQueued = true;
        logger.debug(
          "Sync",
          "Odds deferred — waiting for fixtures to complete",
        );
        await new Promise<void>((resolve) => {
          const prev = sch.onFixDone;
          sch.onFixDone = () => {
            sch.onFixDone = prev; // restore previous callback
            resolve();
          };
        });
        sch.oddsQueued = false;

        // Fixtures just finished and already triggered a post-fixture odds sync.
        // Skip this cycle to avoid a double odds sync, and schedule the next one.
        if (sch.active) {
          scheduleNextOdds();
        }
        return;
      }

      const syncStart = Date.now();
      await syncOddsOnly();

      // Schedule next odds run after remaining interval time
      if (sch.active) {
        const elapsed = Date.now() - syncStart;
        const wait = Math.max(0, sch.oddsInterval - elapsed);
        sch.oddsTimer = setTimeout(() => {
          scheduleNextOdds();
        }, wait);
      }
    }, sch.oddsInterval);
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

  scheduleNextFixtures();
  scheduleNextOdds();
  scheduleNextReconcile();
}

export function restartScheduler(
  oddsIntervalMs?: number,
  fixtureIntervalMs?: number,
): void {
  if (oddsIntervalMs !== undefined) {
    sch.oddsInterval = oddsIntervalMs;
  }
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
  if (sch.oddsTimer) {
    clearTimeout(sch.oddsTimer);
    sch.oddsTimer = null;
  }
  if (sch.reconcileTimer) {
    clearTimeout(sch.reconcileTimer);
    sch.reconcileTimer = null;
  }

  // Release any odds sync waiting on fixtures
  sch.onFixDone = null;
  sch.oddsQueued = false;

  setSyncStatus({ isSchedulerActive: false });
  logger.info("Sync", "Scheduler stopped");
}

export function isSchedulerRunning(): boolean {
  return sch.active;
}

export function isOddsSyncInProgress(): boolean {
  return sch.oddsSyncing;
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
