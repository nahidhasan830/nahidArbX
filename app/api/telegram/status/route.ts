/**
 * GET /api/telegram/status — bot configuration + running state.
 */

import { NextResponse } from "next/server";
import { isTelegramConfigured } from "@/lib/telegram/client";
import { isTelegramBotRunning, startTelegramBot } from "@/lib/telegram/bot";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  return NextResponse.json({
    configured: isTelegramConfigured(),
    running: isTelegramBotRunning(),
  });
}

export async function POST(req: Request) {
  let body: { action?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine */
  }
  if (body.action === "start") {
    const started = startTelegramBot();
    return NextResponse.json({
      ok: started,
      running: isTelegramBotRunning(),
    });
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
