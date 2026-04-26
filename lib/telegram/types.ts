/**
 * Telegram-control bot types.
 *
 * The bot exposes "everything the app can do" as Telegram slash commands
 * to the single chat configured via TELEGRAM_CHAT_ID. Commands are pure
 * dispatch — each one calls the same in-process repos / helpers the web
 * UI uses. There is intentionally no extra auth layer beyond the chat-id
 * filter; updates from any other chat are silently dropped.
 */

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  reply_markup?: TgInlineKeyboard;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface TgInlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface TgInlineKeyboard {
  inline_keyboard: TgInlineKeyboardButton[][];
}

export interface SendOptions {
  chat_id: string | number;
  text: string;
  parse_mode?: "HTML" | "Markdown";
  reply_markup?: TgInlineKeyboard;
  reply_to_message_id?: number;
  disable_web_page_preview?: boolean;
}

export interface CommandContext {
  chatId: number;
  messageId: number;
  /** Raw text after the command, e.g. for `/value 5` this is "5". */
  argsRaw: string;
  /** Whitespace-split positional args. */
  args: string[];
  /** Reply helper bound to this chat. */
  reply: (text: string, kb?: TgInlineKeyboard) => Promise<TgMessage | null>;
}

export interface CommandHandlerResult {
  /** Optional reply text. If returned the bot will send it. */
  text?: string;
  reply_markup?: TgInlineKeyboard;
  /** Set true to skip auto-replying (handler already replied). */
  alreadyReplied?: boolean;
}

export interface CommandSpec {
  name: string;
  /** Short usage hint shown by /help, e.g. "/value [n]". */
  usage: string;
  /** One-line description shown by /help and the dashboard table. */
  description: string;
  /**
   * Long-form tooltip body shown on the dashboard's info-icon hover.
   * Plain language with a concrete bet-flavoured example; never
   * SCREAMING_SNAKE_CASE. Read as if you've never used the system.
   */
  explanation: string;
  /** Group label for /help so commands are organized. */
  group: "read" | "control" | "destructive" | "meta";
  /** True if the command needs a confirm tap before executing. */
  destructive?: boolean;
  handler: (ctx: CommandContext) => Promise<CommandHandlerResult | void>;
}

/** Pending confirm-action stored in memory (TTL'd). */
export interface PendingConfirm {
  id: string;
  description: string;
  run: () => Promise<string>;
  createdAt: number;
  expiresAt: number;
  chatId: number;
  messageId: number;
}
