"use client";

import { formatDistanceToNowStrict } from "date-fns";
import { cn } from "@/lib/utils";
import {
  synthesizeActivity,
  type ActivityEvent,
  type ActivityKind,
} from "@/lib/lab/ml/activity";
import type { PipelineData } from "./types";

interface Props {
  data: PipelineData;
}

const KIND_DOT: Record<ActivityKind, string> = {
  model_deployed: "bg-emerald-400",
  model_rejected: "bg-amber-400",
  model_failed: "bg-rose-400",
  training_started: "bg-cyan-400",
  scheduler_tick: "bg-zinc-500",
  permission_change: "bg-sky-400",
};

/**
 * Right-rail event log. Synthesized from PipelineData timestamps —
 * no new infrastructure. Most-recent-first.
 */
export function ActivityFeed({ data }: Props) {
  const events = synthesizeActivity(data);

  return (
    <aside className="rounded-xl border border-border/60 bg-card/60 backdrop-blur-sm">
      <header className="border-b border-border/40 px-5 py-4">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">
          Activity
        </h2>
        <p className="mt-0.5 text-[12px] text-muted-foreground/80">
          Recent events from model history and scheduler ticks.
        </p>
      </header>
      {events.length === 0 ? (
        <div className="flex flex-col items-center gap-3 px-5 py-12 text-center">
          <div className="flex size-10 items-center justify-center rounded-full bg-muted/40">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="size-5 text-muted-foreground/60"
              aria-hidden
            >
              <line x1="22" y1="12" x2="18" y2="12" />
              <line x1="6" y1="12" x2="2" y2="12" />
              <line x1="12" y1="6" x2="12" y2="2" />
              <line x1="12" y1="22" x2="12" y2="18" />
            </svg>
          </div>
          <p className="text-sm font-medium text-foreground">No events yet</p>
          <p className="max-w-[260px] text-[12.5px] leading-relaxed text-muted-foreground">
            The first scheduler tick or training run will appear here.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border/40">
          {events.map((e) => (
            <ActivityRow key={e.id} event={e} />
          ))}
        </ul>
      )}
    </aside>
  );
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  const ago = (() => {
    try {
      return formatDistanceToNowStrict(new Date(event.at), { addSuffix: true });
    } catch {
      return "";
    }
  })();

  return (
    <li className="grid grid-cols-[auto_1fr_auto] items-baseline gap-x-3 px-5 py-3">
      <span
        className={cn("mt-[6px] size-1.5 rounded-full", KIND_DOT[event.kind])}
        aria-hidden
      />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">
          {event.title}
        </p>
        {event.detail && (
          <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">
            {event.detail}
          </p>
        )}
      </div>
      <span
        className="whitespace-nowrap font-mono text-[11px] tabular-nums text-muted-foreground"
        title={event.at}
      >
        {ago}
      </span>
    </li>
  );
}
