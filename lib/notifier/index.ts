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
    case "provider:health":
      return `Provider ${e.state} · ${e.displayName} · ${e.reason.slice(0, 80)}`;
    case "system:boot":
      return `${e.process === "engine" ? "Engine" : "Frontend"} started · ${e.env}`;
    case "system:unified_boot": {
      const parts: string[] = [];
      if (e.engine) parts.push("Engine");
      if (e.frontend) parts.push("Frontend");
      return `All services started · ${parts.join(" + ")}`;
    }
    case "ai:engine_state":
      return `AI engine ${e.state} · ${e.configuredModel}`;
    case "ai:model_state":
      return `AI model ${e.state.toUpperCase()} · ${e.model}`;

    case "ml:run_completed":
      return `ML Matcher · ${e.processed} pairs processed`;
    case "ml:training_started":
      return `ML Training started · v${e.version} · ${e.trainerExpectedSamples} samples · ${e.trigger}`;
    case "ml:training_completed":
      return `ML Training ${e.outcome} · v${e.version} · ${e.trainingSamples} samples`;
    default:
      return (e as { type: string }).type;
  }
}

export async function notify(event: NotificationEvent): Promise<void> {
  if (event.type === "ml:run_completed" && event.escalated <= 0) {
    return;
  }

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
