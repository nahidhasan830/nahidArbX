/**
 * Notification dispatcher. One entry point (`notify()`) that fans out
 * to every registered channel. Adding a new channel (Slack, email,
 * webhook…) is a matter of importing another `NotificationChannel`
 * and pushing it onto the CHANNELS array.
 */
import type { NotificationChannel, NotificationEvent } from "./types";
import { telegramChannel } from "./telegram";
import { logger } from "@/lib/shared/logger";

const CHANNELS: NotificationChannel[] = [telegramChannel];

export async function notify(event: NotificationEvent): Promise<void> {
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
