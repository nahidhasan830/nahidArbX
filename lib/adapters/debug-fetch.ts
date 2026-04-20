/**
 * Debug Fetch Types for Fixtures
 *
 * Type definitions for capturing raw HTTP request/response data
 * during debug fixture fetching. Used by debug adapters only.
 */

import type { NormalizedEvent } from "../types";
import type {
  DebugHttpRequest,
  DebugHttpResponse,
} from "../shared/debug-types";

// Re-export shared types for backward compatibility
export type { DebugHttpRequest, DebugHttpResponse };

export interface DebugFixturesFetchResult {
  provider: string;
  providerRequests: DebugHttpRequest[];
  rawResponses: DebugHttpResponse[];
  normalizedEvents: NormalizedEvent[];
  eventCount: number;
}
