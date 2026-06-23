
import type { NormalizedEvent } from "../types";
import type {
  DebugHttpRequest,
  DebugHttpResponse,
} from "../shared/debug-types";

export type { DebugHttpRequest, DebugHttpResponse };

export interface DebugFixturesFetchResult {
  provider: string;
  providerRequests: DebugHttpRequest[];
  rawResponses: DebugHttpResponse[];
  normalizedEvents: NormalizedEvent[];
  eventCount: number;
}
