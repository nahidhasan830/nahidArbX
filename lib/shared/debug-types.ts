
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
