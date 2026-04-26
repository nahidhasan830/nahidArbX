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
      ? "bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.45)]"
      : status === "degraded"
        ? "bg-amber-400 shadow-[0_0_5px_rgba(251,191,36,0.45)]"
        : status === "down"
          ? "bg-danger shadow-[0_0_5px_oklch(0.66_0.13_22/0.45)]"
          : "bg-muted-foreground/50 animate-pulse";

  return (
    <div
      className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] text-muted-foreground/70 tracking-tight"
      title={
        lastCheckedAt ? `Last checked ${formatAgo(lastCheckedAt)}` : "Pinging…"
      }
    >
      {/* Health dot */}
      <span className={cn("size-[5px] rounded-full shrink-0", dotClass)} />

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
