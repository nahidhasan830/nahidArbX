"use client";

/**
 * Ambient system status strip pinned to the very bottom of the sidebar.
 *
 * Renders as a thin "cockpit status bar" with a glowing health dot,
 * label, and last-check timestamp. The bar sits at the absolute bottom
 * of the sidebar with a darker background to ground the panel.
 *
 * In collapsed (icon-only) mode, only the dot is visible — gives the
 * operator a single-glance health read at all times.
 *
 * Later: expand to show Pinnacle token TTL, 9wkts session age, sync
 * heartbeat — every piece of ambient status the operator cares about.
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { Activity } from "lucide-react";

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
        ? "Systems online"
        : status === "degraded"
          ? "Degraded"
          : "Offline";

  const dotClass =
    status === "ok"
      ? "status-dot--ok"
      : status === "degraded"
        ? "status-dot--degraded"
        : status === "down"
          ? "status-dot--down"
          : "status-dot--loading";

  return (
    <div
      className="appshell-status-bar"
      title={
        lastCheckedAt ? `Last checked ${formatAgo(lastCheckedAt)}` : "Pinging…"
      }
    >
      {/* Health dot */}
      <span className={cn("status-dot", dotClass)} />

      {/* Label + timestamp — hidden when sidebar collapsed */}
      <span className="group-data-[collapsible=icon]:hidden truncate">
        {label}
      </span>
      {lastCheckedAt && (
        <span className="ml-auto text-[10px] tabular-nums opacity-60 group-data-[collapsible=icon]:hidden">
          {formatAgo(lastCheckedAt)}
        </span>
      )}

      {/* Collapsed mode: small activity icon next to dot */}
      <Activity className="hidden group-data-[collapsible=icon]:block size-3 opacity-40" />
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
