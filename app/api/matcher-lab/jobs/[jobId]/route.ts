import { NextRequest, NextResponse } from "next/server";
import { readEventMatcherRunJob } from "@/lib/event-matcher";
import { logger } from "@/lib/shared/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const tag = "MatcherLabJob";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await params;
    const job = await readEventMatcherRunJob(jobId);
    if (!job) {
      return NextResponse.json(
        { error: "Matcher job not found" },
        { status: 404 },
      );
    }
    return NextResponse.json({ job });
  } catch (err) {
    logger.error(tag, `GET failed: ${(err as Error).message}`);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
