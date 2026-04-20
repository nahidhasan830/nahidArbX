/**
 * Debug Fetch Types
 *
 * Type definitions for capturing raw HTTP request/response data
 * during debug market fetching. Used by debug adapters only.
 */

import type {
  DebugHttpRequest,
  DebugHttpResponse,
} from "../../shared/debug-types";

// Re-export shared types for backward compatibility
export type { DebugHttpRequest, DebugHttpResponse };

export interface DebugFetchResult {
  internalPayload: {
    provider: string;
    providerEventId: string;
    canonicalEventId: string;
  };
  providerRequests: DebugHttpRequest[];
  rawResponses: DebugHttpResponse[];
  normalizedOdds: unknown[];
  oddsCount: number;
}
