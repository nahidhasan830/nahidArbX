import { NextRequest, NextResponse } from "next/server";
import {
  readLatestEventMatcherRunJob,
  startEventMatcherRunJob,
} from "@/lib/event-matcher";
import { logger } from "@/lib/shared/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const tag = "MatcherLabJobs";

function parseDecisionIds(value: unknown) {
  return Array.isArray(value)
    ? value.filter((id: unknown): id is string => {
        return typeof id === "string" && id.trim().length > 0;
      })
    : undefined;
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const activeOnly = url.searchParams.get("active") === "1";
    const job = await readLatestEventMatcherRunJob({ activeOnly });
    return NextResponse.json({ job });
  } catch (err) {
    logger.error(tag, `GET failed: ${(err as Error).message}`);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const decisionIds = parseDecisionIds(body.decisionIds);
    const job = await startEventMatcherRunJob({
      decisionIds,
      useDeepSeek:
        typeof body.useDeepSeek === "boolean" ? body.useDeepSeek : undefined,
    });
    logger.info(tag, `Queued matcher job ${job.id}`);
    return NextResponse.json({ job }, { status: 202 });
  } catch (err) {
    logger.error(tag, `POST failed: ${(err as Error).message}`);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
