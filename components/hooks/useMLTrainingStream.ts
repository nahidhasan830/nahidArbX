"use client";

/**
 * useMLTrainingStream — SSE hook for real-time ML training updates.
 *
 * Connects to the existing /api/value-bets/stream SSE endpoint and
 * listens specifically for `ml:training:update` events. Returns the
 * latest training status for the UI to render.
 *
 * Designed to be used alongside the existing usePipeline() polling
 * hook — this provides instant updates, while usePipeline provides
 * the full pipeline snapshot.
 *
 * **Persistence**: On page refresh, the hook itself starts empty.
 * The dashboard hydrates it from the polled pipeline API data
 * (which queries ml_models for active training rows). SSE provides
 * incremental real-time updates on top of that baseline.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import type { MLTrainingUpdate } from "@/lib/events/event-bus";

export type { MLTrainingUpdate };

export interface MLTrainingState {
  /** Whether we have an active connection to the SSE stream. */
  isConnected: boolean;
  /** The current training update (null when no training is active). */
  currentTraining: MLTrainingUpdate | null;
  /** History of training updates for the current session (most recent first). */
  trainingLog: MLTrainingUpdate[];
  /** Whether a model is actively training. */
  isTraining: boolean;
  /** Seed training state from polled pipeline data (called on mount/refresh). */
  hydrateFromPipeline: (
    info: {
      modelId: string;
      version: number;
      status: string;
      trainingStage: string | null;
      progressMessage: string | null;
      lastHeartbeatAt: string | null;
      estimatedRemainingMs: number | null;
      startedAt: string;
      elapsedMs: number | null;
    } | null,
  ) => void;
}

const TERMINAL_PHASES = new Set(["completed", "failed", "rejected"]);
const MAX_LOG_ENTRIES = 50;

export function useMLTrainingStream(enabled = true): MLTrainingState {
  const [isConnected, setIsConnected] = useState(false);
  const [currentTraining, setCurrentTraining] =
    useState<MLTrainingUpdate | null>(null);
  const [trainingLog, setTrainingLog] = useState<MLTrainingUpdate[]>([]);

  const sourceRef = useRef<EventSource | null>(null);
  /** Track whether we've received at least one SSE update (takes precedence over hydration). */
  const hasSSEUpdateRef = useRef(false);

  /**
   * Seed training state from polled pipeline data.
   * Only applies if we haven't received a more recent SSE update.
   */
  const hydrateFromPipeline = useCallback(
    (
      info: {
        modelId: string;
        version: number;
        status: string;
        trainingStage: string | null;
        progressMessage: string | null;
        lastHeartbeatAt: string | null;
        estimatedRemainingMs: number | null;
        startedAt: string;
        elapsedMs: number | null;
      } | null,
    ) => {
      if (!info) {
        setCurrentTraining((prev) =>
          prev && !TERMINAL_PHASES.has(prev.phase) ? null : prev,
        );
        hasSSEUpdateRef.current = false;
        return;
      }

      // Don't overwrite SSE-driven state — SSE is more granular
      if (hasSSEUpdateRef.current) return;

      const update: MLTrainingUpdate = {
        version: info.version,
        phase: phaseFromStage(info.trainingStage),
        stage: info.trainingStage ?? undefined,
        message:
          info.progressMessage ??
          `LightGBM training in progress (v${info.version})`,
        updatedAt: Date.now(),
        modelId: info.modelId,
        elapsedMs: info.elapsedMs ?? undefined,
        lastHeartbeatAt: info.lastHeartbeatAt ?? undefined,
        estimatedRemainingMs: info.estimatedRemainingMs ?? undefined,
      };

      setCurrentTraining((prev) => {
        // Only set if no current training or same model
        if (!prev || prev.modelId === info.modelId) return update;
        return prev;
      });
    },
    [],
  );

  const connect = useCallback(() => {
    if (!enabled) return;

    // Close any existing connection
    sourceRef.current?.close();

    const es = new EventSource("/api/value-bets/stream");
    sourceRef.current = es;

    es.addEventListener("connected", () => {
      setIsConnected(true);
    });

    es.addEventListener("ml:training:update", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        const update = data.training as MLTrainingUpdate;
        if (!update) return;

        // Mark that we've received an SSE update — takes precedence over hydration
        hasSSEUpdateRef.current = true;

        // Update current training state
        if (TERMINAL_PHASES.has(update.phase)) {
          // Terminal state — keep it visible for 30 seconds then clear
          setCurrentTraining(update);
          setTimeout(() => {
            setCurrentTraining((prev) =>
              prev?.modelId === update.modelId ? null : prev,
            );
            // Reset the SSE flag so next hydration works
            hasSSEUpdateRef.current = false;
          }, 30_000);
        } else {
          setCurrentTraining(update);
        }

        // Append to log
        setTrainingLog((prev) => {
          const next = [update, ...prev].slice(0, MAX_LOG_ENTRIES);
          return next;
        });
      } catch {
        // Ignore malformed events
      }
    });

    es.onerror = () => {
      setIsConnected(false);
    };

    es.onopen = () => {
      setIsConnected(true);
    };

    return es;
  }, [enabled]);

  useEffect(() => {
    const es = connect();
    return () => {
      es?.close();
      sourceRef.current = null;
      setIsConnected(false);
    };
  }, [connect]);

  const isTraining =
    currentTraining != null && !TERMINAL_PHASES.has(currentTraining.phase);

  return {
    isConnected,
    currentTraining,
    trainingLog,
    isTraining,
    hydrateFromPipeline,
  };
}

function phaseFromStage(stage: string | null): MLTrainingUpdate["phase"] {
  switch (stage) {
    case "loading":
      return "loading";
    case "gate":
      return "validating";
    case "export":
      return "exporting";
    case "complete":
      return "completed";
    case "failed":
      return "failed";
    case "rejected":
      return "rejected";
    default:
      return "training";
  }
}
