"use client";

import { useMemo, useState } from "react";
import { format } from "date-fns";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  formatModelStatus,
  formatPermissionLevel,
} from "@/lib/lab/ml/display";
import { cn } from "@/lib/utils";
import type { PipelineData } from "./types";

interface Props {
  data: PipelineData;
}

type HistoryRow = PipelineData["modelHistory"][number];

interface MetricRow {
  label: string;
  hint: string;
  pick: (m: HistoryRow) => string;
  /** Higher-is-better, lower-is-better, or neutral. */
  direction: "higher" | "lower" | "neutral";
  /** Numeric extractor for delta computation; null disables coloring. */
  numeric: (m: HistoryRow) => number | null;
}

const METRICS: MetricRow[] = [
  {
    label: "Status",
    hint: "Lifecycle row state.",
    pick: (m) => formatModelStatus(m.status),
    direction: "neutral",
    numeric: () => null,
  },
  {
    label: "Permission",
    hint: "Runtime permission the deployment gate granted.",
    pick: (m) => formatPermissionLevel(m.permissionLevel),
    direction: "neutral",
    numeric: () => null,
  },
  {
    label: "Training samples",
    hint: "Size of the corpus the trainer saw.",
    pick: (m) => m.trainingSamples.toLocaleString(),
    direction: "higher",
    numeric: (m) => m.trainingSamples,
  },
  {
    label: "Vertex endpoint",
    hint: "Vertex AI Prediction endpoint used by the engine for this model.",
    pick: (m) => formatVertexResource(m.vertexEndpointName, "endpoints"),
    direction: "neutral",
    numeric: () => null,
  },
  {
    label: "Vertex model",
    hint: "Vertex AI Model Registry resource created by the trainer.",
    pick: (m) => formatVertexResource(m.vertexModelName, "models"),
    direction: "neutral",
    numeric: () => null,
  },
  {
    label: "AUC",
    hint: "Out-of-sample AUC. > 0.5 means the model separates winners from losers.",
    pick: (m) => (m.oosAucRoc != null ? m.oosAucRoc.toFixed(4) : "—"),
    direction: "higher",
    numeric: (m) => m.oosAucRoc,
  },
  {
    label: "Deflated Sharpe",
    hint: "Statistical confidence that out-of-sample returns are real, not noise.",
    pick: (m) => (m.deflatedSharpe != null ? m.deflatedSharpe.toFixed(4) : "—"),
    direction: "higher",
    numeric: (m) => m.deflatedSharpe,
  },
  {
    label: "PBO",
    hint: "Probability of backtest overfitting (warning-only at single-trial).",
    pick: (m) => (m.pbo != null ? m.pbo.toFixed(2) : "—"),
    direction: "lower",
    numeric: (m) => m.pbo,
  },
  {
    label: "Deployed at",
    hint: "When this model row was promoted to deployed.",
    pick: (m) =>
      m.deployedAt ? format(new Date(m.deployedAt), "yyyy-MM-dd HH:mm") : "—",
    direction: "neutral",
    numeric: () => null,
  },
  {
    label: "Created at",
    hint: "When the training run completed.",
    pick: (m) =>
      m.createdAt ? format(new Date(m.createdAt), "yyyy-MM-dd HH:mm") : "—",
    direction: "neutral",
    numeric: () => null,
  },
];

/**
 * Side-by-side comparison of two model versions from `modelHistory`.
 *
 * Displays the canonical evaluation metrics (AUC, DSR, PBO, training
 * samples, permission, deploy time). Cells are coloured by which side
 * is "better" for higher/lower-is-better metrics. Rejection reasons
 * are listed beneath the table when present.
 */
export function ModelTimeMachine({ data }: Props) {
  const history = (data.modelHistory ?? []).filter((m) => m.version > 0);

  const versions = useMemo(
    () =>
      history.map((m) => ({
        value: String(m.version),
        label: `v${m.version}`,
        status: m.status,
      })),
    [history],
  );

  const [a, setA] = useState<string | null>(versions[0]?.value ?? null);
  const [b, setB] = useState<string | null>(versions[1]?.value ?? null);

  if (history.length === 0) {
    return (
      <section className="rounded-lg border border-border/60 bg-card/60 backdrop-blur-sm">
        <header className="border-b border-border/40 px-4 py-3">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            Model Time Machine
          </h2>
          <p className="mt-0.5 text-[12px] text-muted-foreground/80">
            Compare any two trained model versions side by side.
          </p>
        </header>
        <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
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
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
          <p className="text-sm font-medium text-foreground">
            No trained models yet
          </p>
          <p className="max-w-sm text-[12.5px] leading-relaxed text-muted-foreground">
            The time machine will populate after the first training run
            completes.
          </p>
        </div>
      </section>
    );
  }

  const left = history.find((m) => String(m.version) === a) ?? null;
  const right = history.find((m) => String(m.version) === b) ?? null;

  return (
    <section className="rounded-lg border border-border/60 bg-card/60 backdrop-blur-sm">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border/40 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            Model Time Machine
          </h2>
          <p className="mt-0.5 text-[12px] text-muted-foreground/80">
            Compare any two trained model versions side by side.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <VersionPicker
            label="A"
            versions={versions}
            value={a}
            onChange={setA}
          />
          <span className="text-[13px] text-muted-foreground">vs</span>
          <VersionPicker
            label="B"
            versions={versions}
            value={b}
            onChange={setB}
          />
        </div>
      </header>

      <div className="grid grid-cols-[150px_1fr_1fr] divide-x divide-border/40">
        <div className="contents">
          <div className="border-b border-border/40 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
            Metric
          </div>
          <div className="border-b border-border/40 px-3 py-2 text-sm font-medium text-foreground">
            {left ? `v${left.version}` : "—"}
          </div>
          <div className="border-b border-border/40 px-3 py-2 text-sm font-medium text-foreground">
            {right ? `v${right.version}` : "—"}
          </div>
        </div>

        {METRICS.map((metric) => {
          const leftValue = left ? metric.pick(left) : "—";
          const rightValue = right ? metric.pick(right) : "—";
          const leftNum = left ? metric.numeric(left) : null;
          const rightNum = right ? metric.numeric(right) : null;

          let leftBetter = false;
          let rightBetter = false;
          if (
            leftNum != null &&
            rightNum != null &&
            metric.direction !== "neutral" &&
            leftNum !== rightNum
          ) {
            const higherWins = metric.direction === "higher";
            if (leftNum > rightNum) {
              leftBetter = higherWins;
              rightBetter = !higherWins;
            } else {
              rightBetter = higherWins;
              leftBetter = !higherWins;
            }
          }

          return (
            <div className="contents" key={metric.label}>
              <div className="border-b border-border/40 px-3 py-1.5 text-[12px]">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help font-medium text-foreground underline decoration-dotted underline-offset-2">
                      {metric.label}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[260px]">
                    {metric.hint}
                  </TooltipContent>
                </Tooltip>
              </div>
              <MetricCell value={leftValue} better={leftBetter} />
              <MetricCell value={rightValue} better={rightBetter} />
            </div>
          );
        })}
      </div>

      <RejectionReasons left={left} right={right} />
    </section>
  );
}

function VersionPicker({
  label,
  versions,
  value,
  onChange,
}: {
  label: string;
  versions: { value: string; label: string; status: string }[];
  value: string | null;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
      <span className="font-mono uppercase tracking-wide">{label}</span>
      <Select value={value ?? undefined} onValueChange={onChange}>
        <SelectTrigger className="h-7 w-[120px] text-[12px]">
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          {versions.map((v) => (
            <SelectItem key={v.value} value={v.value} className="text-[12px]">
              {v.label}
              <span className="ml-2 text-muted-foreground">
                {formatModelStatus(v.status)}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

function MetricCell({ value, better }: { value: string; better: boolean }) {
  return (
    <div
      className={cn(
        "break-all border-b border-border/40 px-3 py-1.5 font-mono text-[12px] tabular-nums text-foreground",
        better && "text-emerald-300",
      )}
    >
      {value}
    </div>
  );
}

function formatVertexResource(
  value: string | null | undefined,
  resource: "endpoints" | "models",
): string {
  if (!value) return "—";
  const marker = `/${resource}/`;
  const index = value.lastIndexOf(marker);
  if (index === -1) return value;
  return `${resource}/${value.slice(index + marker.length)}`;
}

function RejectionReasons({
  left,
  right,
}: {
  left: HistoryRow | null;
  right: HistoryRow | null;
}) {
  const reasons: { label: string; reasons: string[] }[] = [];
  if (left?.rejectionReasons?.length) {
    reasons.push({ label: `v${left.version}`, reasons: left.rejectionReasons });
  }
  if (right?.rejectionReasons?.length) {
    reasons.push({ label: `v${right.version}`, reasons: right.rejectionReasons });
  }
  if (reasons.length === 0) return null;

  return (
    <div className="border-t border-border/40 px-4 py-3 space-y-3">
      {reasons.map((r) => (
        <div key={r.label}>
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-rose-300">
            {r.label} — rejection reasons
          </p>
          <ul className="mt-1 space-y-1 text-[13px] text-foreground/90">
            {r.reasons.map((reason, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-muted-foreground">·</span>
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
