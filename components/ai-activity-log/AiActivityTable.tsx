"use client";

/**
 * AiActivityTable — DataTable displaying every AI operation.
 *
 * Enhanced with:
 *   - Provider column extracted from model name / metadata
 *   - Richer model display with full-name tooltip
 *   - Metadata detail tooltip on summary hover (tier hits, decisions, etc.)
 */

import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DataTable } from "@/components/ui/data-table";
import { cn } from "@/lib/utils";
import { fmtSeen } from "@/lib/formatting/helpers";
import type { AiActivityLogRow } from "@/lib/db/schema";

const PERSISTENCE_KEY = "ai-activity-log-table:layout:v2";

const STATUS_PILL: Record<string, string> = {
  success: "bg-emerald-500/8 text-emerald-400/90 border border-emerald-500/20",
  partial: "bg-amber-500/8 text-amber-400/80 border border-amber-500/20",
  error: "bg-red-500/8 text-red-400/80 border border-red-500/20",
};
const STATUS_LABEL: Record<string, string> = {
  success: "Success",
  partial: "Partial",
  error: "Error",
};

const SYSTEM_COLORS: Record<string, string> = {
  settlement: "text-blue-400",
  grounding: "text-purple-400",
  "entity-match": "text-cyan-400",
  analysis: "text-amber-400",
  propose: "text-emerald-400",
};
const SYSTEM_LABELS: Record<string, string> = {
  settlement: "Settlement",
  grounding: "Grounding",
  "entity-match": "Entity Match",
  analysis: "Analysis",
  propose: "Propose",
};
const SYSTEM_TOOLTIPS: Record<string, string> = {
  settlement: "Gemini-powered bet settlement (Tier 3)",
  grounding: "Search-grounded AI queries via HuggingFace (Groq fallback)",
  "entity-match": "AI-assisted entity matching for event pairs",
  analysis: "AI analysis of betting patterns and performance",
  propose: "AI strategy rule proposals from historical data",
};

const TRIGGER_LABELS: Record<string, string> = {
  manual: "Manual",
  "auto-scheduler": "Auto",
  playground: "Playground",
  batch: "Batch",
};
const TRIGGER_COLORS: Record<string, string> = {
  manual: "text-zinc-400",
  "auto-scheduler": "text-blue-400",
  playground: "text-purple-400",
  batch: "text-amber-400",
};

// ── Provider helpers ──

type MetadataObj = Record<string, unknown>;

function getMetadata(row: AiActivityLogRow): MetadataObj | null {
  if (!row.metadata || typeof row.metadata !== "object") return null;
  return row.metadata as MetadataObj;
}

function extractProvider(row: AiActivityLogRow): string | null {
  const m = getMetadata(row);
  if (m && typeof m.provider === "string") return m.provider;
  // Infer from model name — llama/qwen via HF Router or Groq
  if (row.model?.includes("llama") || row.model?.includes("qwen")) {
    // meta-llama/Llama-3.3-70B-Instruct format = HF; llama-3.3-70b-versatile = Groq
    if (row.model?.includes("/")) return "huggingface";
    return "groq";
  }
  if (row.model?.includes("gemini")) return "google";
  if (row.model?.startsWith("hf-") || row.model?.startsWith("Qwen/"))
    return "huggingface";
  if (row.model?.includes("bi-encoder") || row.model?.includes("cross-encoder"))
    return "local";
  return null;
}

const PROVIDER_LABELS: Record<string, string> = {
  huggingface: "HF",
  groq: "Groq",
  google: "Google",
  local: "Local",
};
const PROVIDER_COLORS: Record<string, string> = {
  huggingface: "text-yellow-400",
  groq: "text-orange-400",
  google: "text-blue-400",
  local: "text-zinc-400",
};

/** Shorten model names for compact display. */
function shortModelName(model: string | null): string | null {
  if (!model) return null;
  return model.replace(/-preview$/, "").replace(/^models\//, "");
}

// ── Metadata detail rendering ──

const METADATA_LABELS: Record<string, string> = {
  // Settlement
  tier0_hits: "T0 Cache",
  tier1_hits: "T1 Live",
  tier2_hits: "T2 Free API",
  tier3_hits: "T3 Gemini",
  tier4_hits: "T4 Batch",
  unsupported: "Unsupported",
  unresolvedEvents: "Unresolved",
  bypassCache: "Cache Bypassed",
  // Entity match
  decision: "Decision",
  confidence: "Confidence",
  same: "SAME",
  different: "DIFFERENT",
  sourcesCount: "Sources",
  merged: "Merged",
  rejected: "Rejected",
  escalated: "Escalated",
  aiSearchAttempted: "AI Search Tried",
  aiSearchMerged: "AI Search Merged",
  aiSearchRejected: "AI Search Rejected",
  // Grounding
  provider: "Provider",
  finishReason: "Finish Reason",
  // Batch failure
  failedChunk: "Failed Chunk",
  processedSoFar: "Processed Before Fail",
};

function formatMetaValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (key.includes("confidence")) return `${value}%`;
    return String(value);
  }
  return String(value);
}

/** Build a rich tooltip showing all metadata key-values. */
function MetadataTooltipContent({ row }: { row: AiActivityLogRow }) {
  const metadata = getMetadata(row);
  if (!metadata) return null;

  const entries = Object.entries(metadata)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => ({
      key: k,
      label:
        METADATA_LABELS[k] ??
        k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      value: formatMetaValue(k, v),
      raw: v,
    }));

  if (entries.length === 0) return null;

  return (
    <div className="space-y-0.5">
      {entries.map(({ key, label, value, raw }) => (
        <div
          key={key}
          className="flex items-baseline justify-between gap-3 text-[11px]"
        >
          <span className="text-muted-foreground shrink-0">{label}</span>
          <span
            className={cn(
              "font-medium tabular-nums",
              typeof raw === "number" &&
                raw > 0 &&
                key.includes("hit") &&
                "text-emerald-400",
              typeof raw === "boolean" && raw && "text-amber-400",
              key === "decision" && raw === "SAME" && "text-emerald-400",
              key === "decision" && raw === "DIFFERENT" && "text-red-400",
              key === "decision" && raw === "UNCERTAIN" && "text-amber-400",
            )}
          >
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Table component ──

export type AiActivityTableProps = {
  rows: AiActivityLogRow[];
  loading?: boolean;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
  renderFooter?: () => React.ReactNode;
};

export function AiActivityLogTable({
  rows,
  loading,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  renderFooter,
}: AiActivityTableProps) {
  const columns = useMemo<ColumnDef<AiActivityLogRow, unknown>[]>(
    () => [
      {
        id: "time",
        accessorKey: "createdAt",
        header: "Time",
        cell: ({ row }) => {
          const t = row.original.createdAt;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-[10px] text-muted-foreground cursor-help">
                  {fmtSeen(t)}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                {new Date(t).toLocaleString()}
              </TooltipContent>
            </Tooltip>
          );
        },
        meta: {
          hint: "When the AI operation occurred.",
          align: "center" as const,
          initialSize: 55,
        },
      },
      {
        id: "status",
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => {
          const s = row.original.status;
          return (
            <span
              className={cn(
                "inline-flex items-center justify-center h-5 rounded-md px-2 text-[10px] font-medium",
                STATUS_PILL[s] ?? STATUS_PILL.error,
              )}
            >
              {STATUS_LABEL[s] ?? s}
            </span>
          );
        },
        meta: {
          hint: "Outcome: success, partial, or error.",
          align: "center" as const,
          initialSize: 80,
        },
      },
      {
        id: "system",
        accessorKey: "system",
        header: "System",
        cell: ({ row }) => {
          const sys = row.original.system;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "text-[10px] font-medium cursor-help",
                    SYSTEM_COLORS[sys] ?? "text-muted-foreground",
                  )}
                >
                  {SYSTEM_LABELS[sys] ?? sys}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                {SYSTEM_TOOLTIPS[sys] ?? "AI operation"}
              </TooltipContent>
            </Tooltip>
          );
        },
        meta: {
          hint: "Which AI subsystem handled this.",
          align: "center" as const,
          initialSize: 100,
        },
      },
      {
        id: "trigger",
        accessorKey: "trigger",
        header: "Trigger",
        cell: ({ row }) => {
          const t = row.original.trigger;
          return (
            <span
              className={cn(
                "inline-flex items-center rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium",
                TRIGGER_COLORS[t] ?? "text-muted-foreground",
              )}
            >
              {TRIGGER_LABELS[t] ?? t}
            </span>
          );
        },
        meta: { hint: "How the operation was triggered.", initialSize: 85 },
      },
      {
        id: "provider",
        header: "Provider",
        cell: ({ row }) => {
          const provider = extractProvider(row.original);
          if (!provider)
            return <span className="text-muted-foreground/40">&mdash;</span>;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "text-[10px] font-medium cursor-help",
                    PROVIDER_COLORS[provider] ?? "text-muted-foreground",
                  )}
                >
                  {PROVIDER_LABELS[provider] ?? provider}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                AI provider: {provider}
              </TooltipContent>
            </Tooltip>
          );
        },
        meta: {
          hint: "AI provider (HuggingFace, Groq, Google, Local).",
          align: "center" as const,
          initialSize: 70,
        },
      },
      {
        id: "model",
        accessorKey: "model",
        header: "Model",
        cell: ({ row }) => {
          const m = row.original.model;
          if (!m)
            return <span className="text-muted-foreground/40">&mdash;</span>;
          const short = shortModelName(m);
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-[11px] cursor-help truncate max-w-[130px] inline-block">
                  {short}
                </span>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                className="max-w-xs font-mono text-[11px]"
              >
                {m}
              </TooltipContent>
            </Tooltip>
          );
        },
        meta: {
          hint: "AI model used. Hover for full name.",
          align: "center" as const,
          initialSize: 130,
        },
      },
      {
        id: "items",
        accessorKey: "itemCount",
        header: "Items",
        cell: ({ row }) => {
          const n = row.original.itemCount;
          if (n == null)
            return <span className="text-muted-foreground/40">&mdash;</span>;
          return <span className="tabular-nums font-medium">{n}</span>;
        },
        meta: {
          hint: "Number of items processed.",
          align: "right" as const,
          initialSize: 55,
        },
      },
      {
        id: "duration",
        accessorKey: "durationMs",
        header: "Duration",
        cell: ({ row }) => {
          const ms = row.original.durationMs;
          if (ms == null)
            return <span className="text-muted-foreground/40">&mdash;</span>;
          const fmt = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
          return (
            <span
              className={cn(
                "tabular-nums text-[11px]",
                ms > 10000 && "text-amber-400",
                ms > 30000 && "text-red-400",
              )}
            >
              {fmt}
            </span>
          );
        },
        meta: {
          hint: "Operation duration.",
          align: "right" as const,
          initialSize: 75,
        },
      },
      {
        id: "cost",
        accessorKey: "costUsd",
        header: "Cost",
        cell: ({ row }) => {
          const c = row.original.costUsd;
          if (c == null || c === 0)
            return <span className="text-muted-foreground/40">&mdash;</span>;
          return (
            <span
              className={cn(
                "tabular-nums text-[11px] font-medium",
                c > 0.5 && "text-amber-400",
                c > 1.0 && "text-red-400",
              )}
            >
              ${c.toFixed(4)}
            </span>
          );
        },
        meta: {
          hint: "Estimated cost in USD.",
          align: "right" as const,
          initialSize: 70,
        },
      },
      {
        id: "summary",
        header: "Summary",
        accessorKey: "summary",
        cell: ({ row }) => {
          const s = row.original.summary;
          if (!s)
            return <span className="text-muted-foreground/40">&mdash;</span>;
          const metadata = getMetadata(row.original);
          const hasMeta = metadata && Object.keys(metadata).length > 0;
          const tooltipBody = (
            <div className="space-y-2 max-w-md">
              <div className="text-xs whitespace-pre-wrap">{s}</div>
              {hasMeta && (
                <>
                  <div className="border-t border-border/40 pt-1.5">
                    <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider mb-1">
                      Metadata
                    </div>
                    <MetadataTooltipContent row={row.original} />
                  </div>
                </>
              )}
            </div>
          );
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "text-[10px] text-muted-foreground truncate max-w-[250px] inline-block cursor-help",
                    hasMeta &&
                      "underline decoration-dotted underline-offset-2 decoration-muted-foreground/30",
                  )}
                >
                  {s}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="p-3">
                {tooltipBody}
              </TooltipContent>
            </Tooltip>
          );
        },
        meta: {
          hint: "Human-readable summary. Hover for metadata details.",
          initialSize: 280,
        },
      },
      {
        id: "error",
        header: "Error",
        accessorKey: "error",
        cell: ({ row }) => {
          const e = row.original.error;
          if (!e)
            return <span className="text-muted-foreground/40">&mdash;</span>;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-[10px] text-red-400 truncate max-w-[200px] inline-block cursor-help">
                  {e}
                </span>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                className="max-w-md whitespace-pre-wrap text-xs"
              >
                {e}
              </TooltipContent>
            </Tooltip>
          );
        },
        meta: { hint: "Detailed error message.", initialSize: 200 },
      },
    ],
    [],
  );

  return (
    <DataTable<AiActivityLogRow>
      data={rows}
      columns={columns}
      getRowId={(row) => String(row.id)}
      enableSorting
      enableColumnResizing
      enableColumnOrdering
      enableVirtualization
      rowHeight={30}
      persistenceKey={PERSISTENCE_KEY}
      hasNextPage={hasNextPage}
      isFetchingNextPage={isFetchingNextPage}
      onLoadMore={onLoadMore}
      loading={loading}
      renderFooter={renderFooter}
      renderEmpty={() => (
        <div className="flex flex-col items-center gap-1.5 py-12 text-muted-foreground">
          <span className="text-sm font-medium">No AI activity</span>
          <span className="text-xs opacity-70">
            No AI operations logged yet, or adjust your filters.
          </span>
        </div>
      )}
    />
  );
}
