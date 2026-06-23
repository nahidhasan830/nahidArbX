
import { NextResponse } from "next/server";
import {
  getProviderConfigs,
  setProviderEnabled,
} from "@/lib/db/repositories/ai-provider-config";
import { getGroundingEngine } from "@/lib/ai/grounding";
import { db } from "@/lib/db/client";
import { aiProviderConfig } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

const SEARCH_PROVIDER_NAMES = new Set(["vertex", "brave", "tavily"]);

const NAME_MAP: Record<string, string> = {
  deepseek: "deepseek-flash",
  gemini: "gemini-lite",
};

export async function GET() {
  try {
    const configs = await getProviderConfigs();
    return NextResponse.json(configs);
  } catch (err) {
    console.error("[ai-engine-config] GET failed:", err);
    return NextResponse.json(
      { error: "Failed to load engine configs" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { name, enabled, reason } = body as {
      name: string;
      enabled: boolean;
      reason?: string;
    };

    if (!name || typeof enabled !== "boolean") {
      return NextResponse.json(
        { error: "name (string) and enabled (boolean) are required" },
        { status: 400 },
      );
    }

    const dbName = NAME_MAP[name] ?? name;
    const isMappedName = NAME_MAP[name] !== undefined;

    if (isMappedName) {
      try {
        await db
          .delete(aiProviderConfig)
          .where(eq(aiProviderConfig.name, name))
          .returning({ name: aiProviderConfig.name });
      } catch {
      }
    }

    await setProviderEnabled(dbName, enabled, reason);

    if (SEARCH_PROVIDER_NAMES.has(name)) {
      try {
        getGroundingEngine().toggleProvider(name, enabled);
      } catch (err) {
        console.warn(
          `[ai-engine-config] Provider toggle for ${name} failed (non-fatal):`,
          (err as Error).message,
        );
      }
    }

    return NextResponse.json({
      ok: true,
      name: dbName, // Return the DB name that was actually updated
      enabled,
      reason: enabled ? null : (reason ?? "manual"),
    });
  } catch (err) {
    console.error("[ai-engine-config] POST failed:", err);
    return NextResponse.json(
      { error: "Failed to update engine config" },
      { status: 500 },
    );
  }
}
