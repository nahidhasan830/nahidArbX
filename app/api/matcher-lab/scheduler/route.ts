import { NextRequest, NextResponse } from "next/server";
import {
  getEventMatcherSchedulerSettings,
  updateEventMatcherSchedulerSettings,
} from "@/lib/db/repositories/event-matcher-scheduler-settings";
import { logger } from "@/lib/shared/logger";

export async function GET() {
  try {
    const result = await getEventMatcherSchedulerSettings();
    return NextResponse.json(result);
  } catch (err) {
    logger.error(
      "MatcherLabScheduler",
      `GET failed: ${(err as Error).message}`,
    );
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const patch: Parameters<typeof updateEventMatcherSchedulerSettings>[0] = {};

    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.useDeepSeek === "boolean") {
      patch.useDeepSeek = body.useDeepSeek;
    }
    if (typeof body.intervalSeconds === "number") {
      patch.intervalSeconds = Math.max(15, Math.round(body.intervalSeconds));
    }

    const row = await updateEventMatcherSchedulerSettings(patch);
    return NextResponse.json({ row, ready: true });
  } catch (err) {
    logger.error(
      "MatcherLabScheduler",
      `PUT failed: ${(err as Error).message}`,
    );
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
