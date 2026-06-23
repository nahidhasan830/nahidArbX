
import { logger } from "@/lib/shared/logger";
import { singleton } from "@/lib/util/singleton";
import {
  answerCallbackQuery,
  deleteWebhook,
  editMessageText,
  getConfiguredChatId,
  getUpdates,
  isTelegramConfigured,
  sendMessage,
} from "./client";
import { isCommandEnabled } from "./config";
import { takeConfirm } from "./confirm";
import { recordCommandHistory } from "./history";
import { getCommand } from "./registry";
import { syncTelegramCommandMenu } from "./menu";
import { handleMatcherCallback } from "./commands/matcher-commands";
import "./commands";
import type {
  CommandContext,
  TgCallbackQuery,
  TgInlineKeyboard,
  TgMessage,
} from "./types";

const TAG = "TelegramBot";

interface BotState {
  running: boolean;
  offset: number;
  consecutiveErrors: number;
  lastTickAt: string | null;
  totalTicks: number;
}

const state = singleton<BotState>("telegram:bot", () => ({
  running: false,
  offset: 0,
  consecutiveErrors: 0,
  lastTickAt: null,
  totalTicks: 0,
}));

function makeReply(chatId: number) {
  return async (
    text: string,
    kb?: TgInlineKeyboard,
  ): Promise<TgMessage | null> =>
    sendMessage({ chat_id: chatId, text, reply_markup: kb });
}

async function handleMessage(msg: TgMessage): Promise<void> {
  const text = (msg.text ?? "").trim();
  logger.debug(
    TAG,
    `handleMessage: chat=${msg.chat.id} text="${text.slice(0, 60)}"`,
  );
  if (!text.startsWith("/")) return;

  const firstSpace = text.indexOf(" ");
  const head = firstSpace === -1 ? text : text.slice(0, firstSpace);
  const argsRaw = firstSpace === -1 ? "" : text.slice(firstSpace + 1).trim();
  const cmdName = head.split("@")[0];
  const cleanName = cmdName.replace(/^\//, "").toLowerCase();
  const startedAt = Date.now();
  const fromUserId = msg.from?.id ?? null;

  const spec = getCommand(cmdName);
  const reply = makeReply(msg.chat.id);

  if (!spec) {
    await reply(
      `❓ Unknown command <code>${cmdName.replace(/[<>&]/g, "")}</code>. Try /help.`,
    );
    await recordCommandHistory({
      at: new Date(startedAt).toISOString(),
      command: cleanName,
      text: text.slice(0, 200),
      fromUserId,
      outcome: "unknown",
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  if (spec.name !== "help" && !isCommandEnabled(spec.name)) {
    await reply(
      `🚫 <b>${spec.name}</b> is disabled. Re-enable it on the /telegram page in the dashboard.`,
    );
    await recordCommandHistory({
      at: new Date(startedAt).toISOString(),
      command: spec.name,
      text: text.slice(0, 200),
      fromUserId,
      outcome: "denied",
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  const ctx: CommandContext = {
    chatId: msg.chat.id,
    messageId: msg.message_id,
    argsRaw,
    args: argsRaw.length > 0 ? argsRaw.split(/\s+/) : [],
    reply,
  };

  try {
    const result = await spec.handler(ctx);
    if (result && !result.alreadyReplied && result.text) {
      await reply(result.text, result.reply_markup);
    }
    await recordCommandHistory({
      at: new Date(startedAt).toISOString(),
      command: spec.name,
      text: text.slice(0, 200),
      fromUserId,
      outcome: "ok",
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    logger.error(TAG, `command ${spec.name} threw: ${m}`);
    await reply(
      `⚠️ <b>${spec.name}</b> failed: <code>${m.replace(/[<>&]/g, "")}</code>`,
    );
    await recordCommandHistory({
      at: new Date(startedAt).toISOString(),
      command: spec.name,
      text: text.slice(0, 200),
      fromUserId,
      outcome: "error",
      durationMs: Date.now() - startedAt,
      error: m,
    });
  }
}

async function handleCallbackQuery(q: TgCallbackQuery): Promise<void> {
  const data = q.data ?? "";
  const ack = (text?: string, alert = false) =>
    answerCallbackQuery({ callback_query_id: q.id, text, show_alert: alert });

  if (data.startsWith("m:")) {
    await handleMatcherCallback(q);
    return;
  }

  if (!data.startsWith("c:") && !data.startsWith("x:")) {
    await ack();
    return;
  }
  const id = data.slice(2);
  const pending = takeConfirm(id);
  if (!pending) {
    await ack("This action expired or already ran. Re-run the command.", true);
    return;
  }
  if (data.startsWith("x:")) {
    await ack("Cancelled.");
    if (q.message) {
      await editMessageText({
        chat_id: q.message.chat.id,
        message_id: q.message.message_id,
        text: `✖ <b>Cancelled</b>\n${pending.description}`,
      });
    }
    return;
  }
  await ack("Working…");
  if (q.message) {
    await editMessageText({
      chat_id: q.message.chat.id,
      message_id: q.message.message_id,
      text: `⏳ <b>Running…</b>\n${pending.description}`,
    });
  }
  let outcome: string;
  try {
    outcome = await pending.run();
  } catch (err) {
    outcome = `⚠️ Failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (q.message) {
    await editMessageText({
      chat_id: q.message.chat.id,
      message_id: q.message.message_id,
      text: outcome,
    });
  } else {
    await sendMessage({ chat_id: pending.chatId, text: outcome });
  }
}

async function tick(): Promise<void> {
  state.lastTickAt = new Date().toISOString();
  state.totalTicks += 1;
  const allowedChat = getConfiguredChatId();
  if (!allowedChat) return;

  const updates = await getUpdates({ offset: state.offset, timeoutSec: 25 });
  if (updates.length > 0) {
    logger.debug(
      TAG,
      `received ${updates.length} update(s), offset=${state.offset}, allowedChat=${allowedChat}`,
    );
  }
  for (const u of updates) {
    state.offset = u.update_id + 1;
    const incomingChat =
      u.message?.chat.id ??
      u.edited_message?.chat.id ??
      u.callback_query?.message?.chat.id;
    if (incomingChat == null || String(incomingChat) !== allowedChat) {
      logger.debug(
        TAG,
        `dropped update ${u.update_id}: chat ${incomingChat} ≠ allowed ${allowedChat}`,
      );
      continue;
    }
    try {
      if (u.message) await handleMessage(u.message);
      else if (u.callback_query) await handleCallbackQuery(u.callback_query);
    } catch (err) {
      logger.error(TAG, `dispatch error: ${(err as Error).message}`);
    }
  }
}

async function loop(): Promise<void> {
  while (state.running) {
    try {
      await tick();
      state.consecutiveErrors = 0;
    } catch (err) {
      state.consecutiveErrors += 1;
      const backoff = Math.min(30_000, 2_000 * state.consecutiveErrors);
      logger.warn(
        TAG,
        `poll error (${state.consecutiveErrors}× consecutive): ${(err as Error).message} — backing off ${backoff}ms`,
      );
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  logger.info(TAG, "poll loop exited");
}

export { syncTelegramCommandMenu } from "./menu";

export function startTelegramBot(): boolean {
  if (state.running) {
    logger.debug(TAG, "already running");
    return true;
  }
  if (!isTelegramConfigured()) {
    logger.warn(
      TAG,
      "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — control bot disabled",
    );
    return false;
  }
  state.running = true;
  state.consecutiveErrors = 0;
  void deleteWebhook();
  void syncTelegramCommandMenu().catch((err) =>
    logger.warn(TAG, `setMyCommands failed: ${(err as Error).message}`),
  );
  void loop();
  logger.info(TAG, "Telegram control bot started (long-poll)");
  return true;
}

export function stopTelegramBot(): void {
  state.running = false;
}

export function isTelegramBotRunning(): boolean {
  return state.running;
}

export function getBotDebugState(): {
  running: boolean;
  offset: number;
  consecutiveErrors: number;
  lastTickAt: string | null;
  totalTicks: number;
} {
  return { ...state };
}
