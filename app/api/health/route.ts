/**
 * Health Check API Endpoint
 *
 * Uses engine HTTP API for detailed health when in web-only mode.
 *
 * Endpoints:
 * - GET /api/health - Full health check (detailed, proxied from engine)
 * - GET /api/health?simple=true - Simple health check (always OK if responding)
 *
 * Response codes:
 * - 200: Healthy
 * - 503: Unhealthy
 */

import { NextResponse } from "next/server";
import { engineGet, enginePost } from "@/lib/engine-proxy";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const simple = searchParams.get("simple") === "true";

  // Simple check: if this endpoint responds, the web server is up
  if (simple) {
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  // Full health check — proxy from engine
  const engineHealth = await engineGet<Record<string, unknown>>("/engine/health");

  if (engineHealth) {
    return NextResponse.json(
      { ...engineHealth, engineConnected: true },
      { status: 200 },
    );
  }

  // Engine unreachable — return degraded status
  return NextResponse.json(
    {
      status: "degraded",
      engineConnected: false,
      timestamp: new Date().toISOString(),
      error: "Engine process unreachable — in-memory data unavailable",
    },
    { status: 200 },
  );
}

/**
 * POST /api/health - Trigger healing actions (proxied to engine)
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action } = body;

    if (action === "restart") {
      // Restart is local to this process
      console.log("[Health] Restart requested via API");
      setTimeout(() => process.exit(0), 100);
      return NextResponse.json({ ok: true, message: "Restart initiated" });
    }

    // Forward heal actions to engine
    const result = await enginePost("/engine/health", body);
    if (result === null) {
      return NextResponse.json(
        { ok: false, error: "Engine unreachable" },
        { status: 503 },
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
