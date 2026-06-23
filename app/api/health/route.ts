
import { NextResponse } from "next/server";
import { engineGet, enginePost } from "@/lib/engine-proxy";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const simple = searchParams.get("simple") === "true";

  if (simple) {
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  const engineHealth =
    await engineGet<Record<string, unknown>>("/engine/health");

  if (engineHealth) {
    return NextResponse.json(
      { ...engineHealth, engineConnected: true },
      { status: 200 },
    );
  }

  return NextResponse.json(
    {
      status: "degraded",
      engineConnected: false,
      timestamp: new Date().toISOString(),
      providerAlerts: [],
      error: "Engine process unreachable — in-memory data unavailable",
    },
    { status: 200 },
  );
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action } = body;

    if (action === "restart") {
      console.log("[Health] Restart requested via API");
      setTimeout(() => process.exit(0), 100);
      return NextResponse.json({ ok: true, message: "Restart initiated" });
    }

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
