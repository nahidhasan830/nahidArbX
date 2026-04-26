/**
 * Pending-confirm store for destructive commands.
 *
 * A destructive command (`/place`, `/cancel`, `/settle <id>`, `/delete`,
 * etc.) replies with a one-line summary and inline Confirm/Cancel
 * buttons. The Confirm button's callback_data is `c:<id>`; tapping it
 * fires the stored `run()` and replies with the result. Entries expire
 * after `TTL_MS`; expired callbacks tell the user to re-run the command.
 */

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
