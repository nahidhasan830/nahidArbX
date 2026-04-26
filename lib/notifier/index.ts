/**
 * Notification dispatcher. One entry point (`notify()`) that fans out
 * to every registered channel. Adding a new channel (Slack, email,
 * webhook…) is a matter of importing another `NotificationChannel`
 * and pushing it onto the CHANNELS array.
 */
import type { NotificationChannel, NotificationEvent } from "./types";
import { telegramChannel } from "./telegram";
import { logger } from "@/lib/shared/logger";
import { recordNotification } from "@/lib/telegram/recent";

const CHANNELS: NotificationChannel[] = [telegramChannel];

function summarizeEvent(e: NotificationEvent): string {
  switch (e.type) {
    case "bet:placed":
      return `Bet placed · ${e.eventName} · ${e.providerDisplayName}`;
    case "bet:settled":
      return `Bet ${e.outcome} · ${e.eventName}`;
    case "bet:error":
      return `Placement failed · ${e.eventName} · ${e.error.slice(0, 80)}`;
    case "system":
      return `System ${e.severity}: ${e.message.slice(0, 100)}`;
    case "optimizer:run_started":
      return `Run started · ${e.name}`;
    case "optimizer:run_completed":
      return `Run ${e.status} · ${e.name}`;
    default:
      return (e as { type: string }).type;
  }
}

export async function notify(event: NotificationEvent): Promise<void> {
  recordNotification({
    at: new Date().toISOString(),
    type: event.type,
    summary: summarizeEvent(event),
  });
  await Promise.all(
    CHANNELS.map(async (channel) => {
      try {
        await channel.send(event);
      } catch (err) {
        logger.error(
          "Notifier",
          `[${channel.id}] ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );
}

export type { NotificationEvent, NotificationChannel } from "./types";
