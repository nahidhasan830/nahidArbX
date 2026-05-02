/**
 * Engine Proxy Client
 *
 * Used by Next.js API routes to forward requests to the engine's
 * HTTP API (port 3001) for data that only exists in the engine
 * process's memory.
 *
 * Falls back gracefully when the engine is unreachable (returns null).
 */

const ENGINE_PORT = parseInt(process.env.ENGINE_PORT || "3001", 10);
const ENGINE_BASE = `http://127.0.0.1:${ENGINE_PORT}`;

/** Exported for display in boot notifications. */
export const ENGINE_BASE_URL = ENGINE_BASE;

/** Timeout for engine requests (ms) */
const TIMEOUT_MS = 8_000;

/**
 * GET request to engine HTTP API.
 * Returns parsed JSON or null if engine is unreachable.
 */
export async function engineGet<T = unknown>(
  path: string,
): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(`${ENGINE_BASE}${path}`, {
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * POST request to engine HTTP API.
 * Returns parsed JSON or null if engine is unreachable.
 */
export async function enginePost<T = unknown>(
  path: string,
  body: unknown,
): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(`${ENGINE_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const errBody = await res.json().catch(() => null);
      return errBody as T;
    }
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Proxy an SSE stream from the engine to the client.
 * Returns a ReadableStream that pipes engine SSE events through.
 */
export function engineSSEProxy(): ReadableStream | null {
  try {
    const url = `${ENGINE_BASE}/engine/stream`;
    
    return new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        
        try {
          const res = await fetch(url, {
            cache: "no-store",
            // No timeout for SSE — it's long-lived
          });

          if (!res.ok || !res.body) {
            controller.close();
            return;
          }

          const reader = res.body.getReader();
          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                controller.close();
                return;
              }
              try {
                controller.enqueue(value);
              } catch {
                // Controller closed by client disconnect
                reader.cancel();
                return;
              }
            }
          };
          pump();
        } catch {
          try {
            // Engine unreachable — send error event then close
            controller.enqueue(
              encoder.encode(
                `event: error\ndata: ${JSON.stringify({ error: "Engine unreachable" })}\n\n`,
              ),
            );
            controller.close();
          } catch {
            // Already closed
          }
        }
      },
    });
  } catch {
    return null;
  }
}

/**
 * Check if the engine HTTP API is reachable.
 */
export async function isEngineReachable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    const res = await fetch(`${ENGINE_BASE}/engine/health`, {
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}
