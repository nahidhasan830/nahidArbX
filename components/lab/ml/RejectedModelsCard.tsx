"use client";

import { format } from "date-fns";
import { AlertCircle, ScrollText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PipelineData } from "./types";

interface Props {
  data: PipelineData;
}

/**
 * List of recent rejected model versions with their primary rejection
 * reason. Renders an empty state when none have been recorded yet.
 *
 * Lives in the Models tab beneath the ModelTimeMachine — operators
 * use it to check why their last few candidates didn't deploy.
 */
export function RejectedModelsCard({ data }: Props) {
  const rejected = (data.rejectedModels ?? []).slice(0, 8);

  return (
    <section className="rounded-xl border border-border/60 bg-card/60 backdrop-blur-sm">
      <header className="flex items-center justify-between gap-3 border-b border-border/40 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            Rejected Candidates
          </h2>
          <p className="mt-0.5 text-[12px] text-muted-foreground/80">
            Models that failed the deployment gate. Most-recent first.
          </p>
        </div>
        <span className="rounded-full border border-border/60 bg-muted/50 px-2 py-0.5 font-mono text-[11px] font-medium tabular-nums text-muted-foreground">
          {rejected.length}
        </span>
      </header>

      {rejected.length === 0 ? (
        <EmptyState
          icon={<ScrollText className="size-5 text-muted-foreground/60" />}
          title="No rejections recorded"
          body="Once the deployment gate rejects a candidate, it&rsquo;ll show up here with the reason."
        />
      ) : (
        <ul className="divide-y divide-border/40">
          {rejected.map((m) => (
            <RejectedRow key={`${m.version}-${m.createdAt ?? ""}`} model={m} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RejectedRow({
  model,
}: {
  model: PipelineData["rejectedModels"][number];
}) {
  const reasons = model.reasons ?? [];
  const primary = reasons[0] ?? "No reason recorded.";
  const extras = reasons.length > 1 ? reasons.length - 1 : 0;

  const created = model.createdAt
    ? format(new Date(model.createdAt), "MMM d, HH:mm")
    : "—";

  return (
    <li className="grid grid-cols-[auto_1fr_auto] items-start gap-3 px-5 py-3">
      <span
        className={cn(
          "mt-1 inline-flex size-6 items-center justify-center rounded-md",
          "bg-amber-500/15 text-amber-400",
        )}
      >
        <AlertCircle className="size-3.5" />
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <p className="font-mono text-sm font-semibold tabular-nums text-foreground">
            v{model.version}
          </p>
          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wider text-amber-400">
            {model.status}
          </span>
          {model.trainingSamples > 0 && (
            <span className="font-mono text-[11px] text-muted-foreground">
              {model.trainingSamples.toLocaleString()} samples
            </span>
          )}
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-foreground/85">
          {primary}
        </p>
        {extras > 0 && (
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            +{extras} more reason{extras !== 1 ? "s" : ""}
          </p>
        )}
      </div>
      <span className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
        {created}
      </span>
    </li>
  );
}

function EmptyState({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-5 py-12 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted/40">
        {icon}
      </div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-sm text-[12.5px] leading-relaxed text-muted-foreground">
        {body}
      </p>
    </div>
  );
}
