"use client";

/**
 * Tiny "session health" indicator pinned to the sidebar footer.
 *
 * MVP: periodically pings /api/health?simple=true and renders a colored
 * dot. Green = last ping OK, amber = no response yet, red = last ping
 * failed. The label auto-hides when the rail is icon-collapsed; the
 * dot remains visible so operator state is always at a glance.
 *
 * Later: expand to show Pinnacle token TTL, 9wkts session age, sync
 * heartbeat — every piece of ambient status the operator cares about,
 * in one pill.
 */
import * as React from "react";
import { cn } from "@/lib/utils";

type Status = "loading" | "ok" | "degraded" | "down";

const POLL_MS = 30_000;

export function SessionPill() {
  const [status, setStatus] = React.useState<Status>("loading");
  const [lastCheckedAt, setLastCheckedAt] = React.useState<number | null>(null);

  const ping = React.useCallback(async () => {
    try {
      const res = await fetch("/api/health?simple=true", { cache: "no-store" });
      setStatus(res.ok ? "ok" : "degraded");
    } catch {
      setStatus("down");
    } finally {
      setLastCheckedAt(Date.now());
    }
  }, []);

  React.useEffect(() => {
    void ping();
    const id = setInterval(ping, POLL_MS);
    return () => clearInterval(id);
  }, [ping]);

  const label =
    status === "loading"
      ? "Checking…"
      : status === "ok"
        ? "Online"
        : status === "degraded"
          ? "Degraded"
          : "Offline";

  const dotClass =
    status === "ok"
      ? "bg-emerald-500"
      : status === "degraded"
        ? "bg-amber-500"
        : status === "down"
          ? "bg-red-500"
          : "bg-muted-foreground";

  return (
    <div
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground"
      title={
        lastCheckedAt ? `Last checked ${formatAgo(lastCheckedAt)}` : "Pinging…"
      }
    >
      <span
        className={cn(
          "inline-block size-2 rounded-full shrink-0",
          dotClass,
          status === "loading" && "animate-pulse",
        )}
      />
      <span className="group-data-[collapsible=icon]:hidden">{label}</span>
    </div>
  );
}

function formatAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return `${m}m ago`;
}
