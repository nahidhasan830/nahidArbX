/**
 * Shared Debug Fetch Types
 *
 * Common type definitions for capturing raw HTTP request/response data
 * during debug fetching. Used by both fixtures and atoms debug adapters.
 */

export interface DebugHttpRequest {
  label?: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface DebugHttpResponse {
  status: number;
  data: unknown;
  durationMs: number;
}
