
import { randomUUID } from "node:crypto";
import type { PendingConfirm, TgInlineKeyboard } from "./types";

const TTL_MS = 2 * 60 * 1000;
const pending = new Map<string, PendingConfirm>();

function gc(): void {
  const now = Date.now();
  for (const [id, p] of pending.entries()) {
    if (p.expiresAt < now) pending.delete(id);
  }
}

export function createConfirm(args: {
  description: string;
  chatId: number;
  messageId: number;
  run: () => Promise<string>;
}): { id: string; keyboard: TgInlineKeyboard } {
  gc();
  const id = randomUUID().slice(0, 12);
  const now = Date.now();
  pending.set(id, {
    id,
    description: args.description,
    run: args.run,
    chatId: args.chatId,
    messageId: args.messageId,
    createdAt: now,
    expiresAt: now + TTL_MS,
  });
  const keyboard: TgInlineKeyboard = {
    inline_keyboard: [
      [
        { text: "✅ Confirm", callback_data: `c:${id}` },
        { text: "✖ Cancel", callback_data: `x:${id}` },
      ],
    ],
  };
  return { id, keyboard };
}

export function takeConfirm(id: string): PendingConfirm | null {
  gc();
  const p = pending.get(id);
  if (!p) return null;
  pending.delete(id);
  return p;
}

export function dropConfirm(id: string): boolean {
  return pending.delete(id);
}
