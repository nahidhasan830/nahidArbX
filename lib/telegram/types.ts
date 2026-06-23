
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
  argsRaw: string;
  args: string[];
  reply: (text: string, kb?: TgInlineKeyboard) => Promise<TgMessage | null>;
}

export interface CommandHandlerResult {
  text?: string;
  reply_markup?: TgInlineKeyboard;
  alreadyReplied?: boolean;
}

export interface CommandSpec {
  name: string;
  usage: string;
  description: string;
  explanation: string;
  group: "read" | "control" | "destructive" | "meta";
  destructive?: boolean;
  handler: (ctx: CommandContext) => Promise<CommandHandlerResult | void>;
}

export interface PendingConfirm {
  id: string;
  description: string;
  run: () => Promise<string>;
  createdAt: number;
  expiresAt: number;
  chatId: number;
  messageId: number;
}
