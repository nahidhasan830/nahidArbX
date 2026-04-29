/**
 * GET  /api/telegram/commands  → metadata + enabled state for every
 *                                registered Telegram command
 * PUT  /api/telegram/commands  → bulk-update enabled flags
 *      body: { updates: { [commandName]: boolean } }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { listCommands } from "@/lib/telegram/registry";
import {
  getCommandConfig,
  isCommandEnabled,
  setManyCommands,
} from "@/lib/telegram/config";
import { isTelegramConfigured } from "@/lib/telegram/client";
import {
  isTelegramBotRunning,
  syncTelegramCommandMenu,
} from "@/lib/telegram/bot";
import { getCommandCounts } from "@/lib/telegram/history";
// Force command-registration import so listCommands() returns everything.
import "@/lib/telegram/commands";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const counts = await getCommandCounts();
  const commands = listCommands().map((c) => ({
    name: c.name,
    usage: c.usage,
    description: c.description,
    explanation: c.explanation,
    group: c.group,
    destructive: !!c.destructive,
    enabled: isCommandEnabled(c.name),
    /** Times this command has been dispatched since the server booted. */
    callCount: counts[c.name] ?? 0,
  }));
  const cfg = getCommandConfig();
  return NextResponse.json({
    commands,
    configured: isTelegramConfigured(),
    running: isTelegramBotRunning(),
    updatedAt: cfg.updatedAt,
  });
}

const PutSchema = z.object({
  updates: z.record(z.string(), z.boolean()),
});

export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = PutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  setManyCommands(parsed.data.updates);
  // Re-publish the slash-command autocomplete list so disabled commands
  // disappear from the / popover (and re-enabled ones come back).
  void syncTelegramCommandMenu().catch(() => {});
  return NextResponse.json({ ok: true });
}
