import { NextResponse } from "next/server";
import {
  listAutoPlaceStates,
  setAutoPlaceEnabled,
} from "@/lib/betting/auto-place-config";
import { getBettingProvider } from "@/lib/betting/registry";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  return NextResponse.json({ providers: listAutoPlaceStates() });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { provider, enabled } = (body ?? {}) as {
    provider?: string;
    enabled?: boolean;
  };
  if (!provider || typeof enabled !== "boolean") {
    return NextResponse.json(
      { error: "Body must be { provider: string, enabled: boolean }" },
      { status: 400 },
    );
  }
  if (!getBettingProvider(provider)) {
    return NextResponse.json(
      { error: `Unknown provider: ${provider}` },
      { status: 404 },
    );
  }
  setAutoPlaceEnabled(provider, enabled);
  return NextResponse.json({
    provider,
    enabled,
    providers: listAutoPlaceStates(),
  });
}
