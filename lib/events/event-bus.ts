/**
 * Global Event Bus
 *
 * Singleton event emitter for cross-module communication.
 * Used by:
 * - Sync pipeline (emits phase changes, completion, arb detection)
 * - SSE endpoint (subscribes to push updates to connected browsers)
 * - Dashboard API (version tracking for ETag support)
 *
 * Survives Next.js hot reloads via globalThis.
 */

import { EventEmitter } from "events";
import { logger } from "@/lib/shared/logger";

// ============================================
// Event Types
// ============================================

export type BusEvent =
  | {
      type: "sync:phase";
      phase: string;
      progress?: { current: number; total: number };
    }
  | {
      type: "sync:complete";
      duration: number;
      valueBetCount: number;
      dirtyFamilies: number;
    }
  | { type: "fixtures:complete"; matchedEvents: number; rawEvents: number }
  | { type: "odds:updated"; changedFamilies: number }
  | { type: "value:change"; added: number; removed: number; total: number }
  | { type: "data:delta"; delta: import("../cache/delta").DeltaOrRefresh }
  | {
      type: "settle:state";
      status: import("../settle/scheduler").AutoSettleStatusSnapshot;
    }
  | {
      type: "settle:log";
      entry: import("../settle/activity-log").ActivityEntry;
    }
  | {
      type: "ml:training:update";
      training: MLTrainingUpdate;
    };

/** Real-time ML training status pushed from engine → UI via SSE. */
export interface MLTrainingUpdate {
  /** Model version being trained. */
  version: number;
  /** Current phase: started → loading → training → validating → exporting → completed | failed | rejected */
  phase:
    | "started"
    | "loading"
    | "training"
    | "validating"
    | "exporting"
    | "completed"
    | "failed"
    | "rejected";
  /** Human-readable message for the current phase. */
  message: string;
  /** Optional progress percentage [0–100] within the current phase. */
  progressPct?: number;
  /** Timestamp of this update. */
  updatedAt: number;
  /** Model ID in the ml_models table. */
  modelId: string;
  /** Training metrics (available in completed/rejected phases). */
  metrics?: {
    aucRoc?: number;
    dsr?: number;
    pbo?: number;
    trainingSamples?: number;
    permissionLevel?: string;
    rejectionReasons?: string[];
  };
  /** Duration since training started (ms). */
  elapsedMs?: number;
}

// ============================================
// Event Bus Class
// ============================================

class SyncEventBus extends EventEmitter {
  private _version = 0;
  private _connectionIds = new Map<string, () => void>();

  constructor() {
    super();
    this.setMaxListeners(100);
    this.on("error", (err) => {
      logger.error("EventBus", "Unhandled error", err);
    });
  }

  get version(): number {
    return this._version;
  }

  /** Emit a typed event and bump version for data-change events */
  emitBus(event: BusEvent): void {
    if (
      event.type === "sync:complete" ||
      event.type === "value:change" ||
      event.type === "fixtures:complete"
    ) {
      this._version++;
    }
    this.emit("bus-event", event);
  }

  /** Subscribe with automatic cleanup handle */
  subscribe(handler: (event: BusEvent) => void): () => void {
    this.on("bus-event", handler);
    return () => {
      this.off("bus-event", handler);
    };
  }

  /** Subscribe with a trackable connection ID */
  subscribeWithId(id: string, handler: (event: BusEvent) => void): () => void {
    if (this._connectionIds.has(id)) {
      this._connectionIds.get(id)!();
    }

    const wrappedHandler = (event: BusEvent) => {
      try {
        handler(event);
      } catch (err) {
        logger.error("EventBus", `Handler error for ${id}`, err);
      }
    };

    this.on("bus-event", wrappedHandler);

    const unsubscribe = () => {
      this.off("bus-event", wrappedHandler);
      this._connectionIds.delete(id);
    };

    this._connectionIds.set(id, unsubscribe);
    return unsubscribe;
  }

  /** Get listener count for monitoring */
  get clientCount(): number {
    return this.listenerCount("bus-event");
  }

  /** Diagnostic info */
  getStats() {
    return {
      version: this._version,
      listeners: this.listenerCount("bus-event"),
      connections: this._connectionIds.size,
    };
  }
}

// Singleton — survives Next.js dev-mode hot reloads via globalThis
const globalForBus = globalThis as typeof globalThis & {
  __syncBus?: SyncEventBus;
};
export const syncBus =
  globalForBus.__syncBus ?? (globalForBus.__syncBus = new SyncEventBus());
