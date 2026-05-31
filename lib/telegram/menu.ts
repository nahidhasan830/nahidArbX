import { isCommandEnabled } from "./config";
import { isTelegramConfigured, setChatMenuButton, setMyCommands } from "./client";
import { listCommands } from "./registry";
import { logger } from "@/lib/shared/logger";

const PRIMARY_MENU_COMMANDS = new Set([
  "help",
  "status",
  "health",
  "errors",
  "balance",
  "today",
  "value",
  "pending",
  "sync",
  "commandsync",
  "scheduler",
  "settle",
  "autoplace",
  "provider",
  "matcher_reviews",
  "matcher_review",
  "matcher_match",
  "matcher_reject",
  "matcher_run",
  "matcher_run_all",
]);

export async function syncTelegramCommandMenu(): Promise<number> {
  if (!isTelegramConfigured()) return 0;
  const showFullMenu = process.env.TELEGRAM_FULL_COMMAND_MENU === "1";
  const enabled = listCommands().filter(
    (c) =>
      isCommandEnabled(c.name) &&
      (showFullMenu || PRIMARY_MENU_COMMANDS.has(c.name)),
  );
  const trimmed = enabled.map((c) => ({
    command: c.name,
    description:
      c.description.length > 64
        ? c.description.slice(0, 61) + "..."
        : c.description,
  }));
  await setMyCommands(trimmed);
  await setChatMenuButton("commands");
  logger.info(
    "TelegramBot",
    `Telegram command menu synced (${trimmed.length} commands)`,
  );
  return trimmed.length;
}
