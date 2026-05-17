/**
 * GET /api/ai-providers → returns all AI providers from DB
 *
 * Returns provider list with config and quota data.
 */

import { NextResponse } from "next/server";
import {
  getAllProviders,
  seedProvidersIfEmpty,
} from "@/lib/db/repositories/ai-provider-config";

export async function GET() {
  try {
    // Ensure providers are seeded on first call
    await seedProvidersIfEmpty();

    const providers = await getAllProviders();
    return NextResponse.json(providers);
  } catch (err) {
    console.error("[ai-providers] GET failed:", err);
    return NextResponse.json(
      { error: "Failed to load providers" },
      { status: 500 },
    );
  }
}