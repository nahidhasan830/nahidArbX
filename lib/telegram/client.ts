
import { logger } from "@/lib/shared/logger";
import type {
  SendOptions,
  TgInlineKeyboard,
  TgMessage,
  TgUpdate,
} from "./types";

const API_BASE = "https://api.telegram.org";
const TAG = "TelegramBot";

function getToken(): string | null {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  return t && t.length > 0 ? t : null;
}

export function getConfiguredChatId(): string | null {
  const c = process.env.TELEGRAM_CHAT_ID;
  return c && c.length > 0 ? c : null;
}

export function isTelegramConfigured(): boolean {
  return getToken() !== null && getConfiguredChatId() !== null;
}

async function call<T = unknown>(
  method: string,
  body: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<T | null> {
  const token = getToken();
  if (!token) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.warn(TAG, `${method} ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as { ok: boolean; result?: T };
    if (!data.ok) return null;
    return data.result ?? null;
  } catch (err) {
    if ((err as Error).name === "AbortError") return null;
    logger.warn(TAG, `${method} error: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function sendMessage(
  opts: SendOptions,
): Promise<TgMessage | null> {
  return call<TgMessage>("sendMessage", {
    chat_id: opts.chat_id,
    text: opts.text,
    parse_mode: opts.parse_mode ?? "HTML",
    disable_web_page_preview: opts.disable_web_page_preview ?? true,
    reply_markup: opts.reply_markup,
    reply_to_message_id: opts.reply_to_message_id,
  });
}

export async function editMessageText(args: {
  chat_id: number | string;
  message_id: number;
  text: string;
  reply_markup?: TgInlineKeyboard;
}): Promise<TgMessage | null> {
  return call<TgMessage>("editMessageText", {
    chat_id: args.chat_id,
    message_id: args.message_id,
    text: args.text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: args.reply_markup,
  });
}

export async function answerCallbackQuery(args: {
  callback_query_id: string;
  text?: string;
  show_alert?: boolean;
}): Promise<void> {
  await call("answerCallbackQuery", {
    callback_query_id: args.callback_query_id,
    text: args.text,
    show_alert: args.show_alert ?? false,
  });
}

export async function getUpdates(args: {
  offset?: number;
  timeoutSec?: number;
  limit?: number;
}): Promise<TgUpdate[]> {
  const updates = await call<TgUpdate[]>(
    "getUpdates",
    {
      offset: args.offset,
      timeout: args.timeoutSec ?? 25,
      limit: args.limit ?? 100,
      allowed_updates: ["message", "callback_query"],
    },
    (args.timeoutSec ?? 25) * 1000 + 5_000,
  );
  return updates ?? [];
}

export async function deleteWebhook(): Promise<void> {
  await call("deleteWebhook", { drop_pending_updates: false });
}

export async function setMyCommands(
  commands: Array<{ command: string; description: string }>,
): Promise<void> {
  await call("setMyCommands", {
    commands: commands.map((c) => ({
      command: c.command
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "")
        .slice(0, 32),
      description: c.description.slice(0, 256),
    })),
  });
}

export async function setChatMenuButton(
  type: "commands" | "default" = "commands",
): Promise<void> {
  await call("setChatMenuButton", {
    menu_button: { type },
  });
}
