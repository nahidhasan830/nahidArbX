"use client";

import { useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Brain,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  Search,
  XCircle,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { DataTable } from "@/components/ui/data-table";
import { cn } from "@/lib/utils";
import { fmtSeen } from "@/lib/formatting/helpers";
import type { AiLogRow } from "@/lib/db/schema";

const PERSISTENCE_KEY = "ai-activity-log-table:layout:v4";

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

const SYSTEM_LABELS: Record<string, string> = {
  search: "Search",
  llm: "LLM",
  settlement: "Settlement",
  grounding: "Grounding",
  "entity-match": "Entity Match",
  analysis: "Analysis",
  propose: "Propose",
};
const SYSTEM_TOOLTIPS: Record<string, string> = {
  search: "Web search calls that gather evidence before an LLM decision.",
  llm: "DeepSeek or Gemini calls that receive prompts and return JSON verdicts.",
  settlement: "Settlement activity",
  grounding: "Search-grounded AI workflows",
  "entity-match": "AI-assisted entity matching for event pairs",
  analysis: "AI analysis of betting patterns and performance",
  propose: "AI strategy rule proposals from historical data",
};

const TRIGGER_LABELS: Record<string, string> = {
  manual: "Manual",
  auto: "Auto",
  scheduler: "Scheduler",
  "auto-scheduler": "Auto",
  playground: "Playground",
  batch: "Batch",
};
const TRIGGER_COLORS: Record<string, string> = {
  manual: "text-zinc-400",
  auto: "text-blue-400",
  scheduler: "text-blue-400",
  "auto-scheduler": "text-blue-400",
  playground: "text-purple-400",
  batch: "text-amber-400",
};

type JsonObj = Record<string, unknown>;

function asObj(value: unknown): JsonObj | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObj)
    : null;
}

function getMetadata(row: AiLogRow): JsonObj | null {
  return asObj(row.metadata);
}

function getRequest(row: AiLogRow): JsonObj | null {
  return asObj(row.requestBody);
}

function getResponse(row: AiLogRow): JsonObj | null {
  return asObj(row.responseBody);
}

function extractProvider(row: AiLogRow): string | null {
  if (row.providerUsed) return row.providerUsed;
  const metadata = getMetadata(row);
  if (metadata && typeof metadata.provider === "string") {
    return metadata.provider;
  }
  if (row.model?.includes("deepseek")) return "deepseek";
  if (row.model?.includes("gemini")) return "google";
  if (row.model?.includes("llama") || row.model?.includes("qwen")) {
    return row.model.includes("/") ? "huggingface" : "groq";
  }
  if (row.model?.includes("bi-encoder") || row.model?.includes("cross-encoder"))
    return "local";
  return null;
}

const PROVIDER_COLORS: Record<string, string> = {
  vertex: "text-sky-400",
  brave: "text-orange-400",
  tavily: "text-emerald-400",
  deepseek: "text-violet-400",
  "deepseek-flash": "text-violet-400",
  google: "text-blue-400",
  huggingface: "text-yellow-400",
  groq: "text-orange-400",
  local: "text-zinc-400",
};

const PROVIDER_LABELS: Record<string, string> = {
  vertex: "Vertex Search",
  brave: "Brave Search",
  tavily: "Tavily Search",
  deepseek: "DeepSeek",
  "deepseek-flash": "DeepSeek Flash",
  google: "Google",
  huggingface: "Hugging Face",
  groq: "Groq",
  local: "Local Model",
};

const ENDPOINT_LABELS: Record<string, string> = {
  search: "Web search",
  "entity-match": "Entity match",
  "grounded-query": "Grounded query",
  grounding: "Grounding",
  generate: "Generation",
};

function shortModelName(model: string | null): string | null {
  if (!model) return null;
  return model.replace(/-preview$/, "").replace(/^models\//, "");
}

function humanizeId(value: string | null | undefined): string | null {
  if (!value) return null;
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function providerLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return PROVIDER_LABELS[value] ?? humanizeId(value);
}

function endpointLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return ENDPOINT_LABELS[value] ?? humanizeId(value);
}

function jsonText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatCost(cost: unknown): string | null {
  const n = typeof cost === "number" ? cost : Number(cost);
  if (!Number.isFinite(n) || n === 0) return null;
  return `$${n.toFixed(4)}`;
}

function getPrimaryLine(row: AiLogRow): string {
  if (row.query) return row.query;
  if (row.summary) return row.summary;
  const request = getRequest(row);
  if (request && typeof request.query === "string") return request.query;
  if (request && typeof request.question === "string") return request.question;
  return row.endpoint ?? row.system;
}

function getStepInfo(row: AiLogRow): {
  label: string;
  tone: string;
  icon: "search" | "brain" | "check";
} {
  if (row.system === "search") {
    return {
      label: "Evidence",
      tone: "border-sky-500/20 bg-sky-500/8 text-sky-300",
      icon: "search",
    };
  }
  if (row.system === "llm") {
    return {
      label: "Decision",
      tone: "border-violet-500/20 bg-violet-500/8 text-violet-300",
      icon: "brain",
    };
  }
  return {
    label: SYSTEM_LABELS[row.system] ?? row.system,
    tone: "border-border/70 bg-muted/30 text-muted-foreground",
    icon: "check",
  };
}

function StepIcon({ icon, className }: { icon: string; className?: string }) {
  if (icon === "search") return <Search className={className} />;
  if (icon === "brain") return <Brain className={className} />;
  return <CheckCircle2 className={className} />;
}

function StatusIcon({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  if (status === "success") return <CheckCircle2 className={className} />;
  if (status === "error") return <XCircle className={className} />;
  return <CircleAlert className={className} />;
}

function getResultCount(row: AiLogRow): number | null {
  const response = getResponse(row);
  const resultCount = response?.resultCount;
  if (typeof resultCount === "number") return resultCount;
  const results = response?.results;
  if (Array.isArray(results)) return results.length;
  return null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function objectArray(value: unknown): JsonObj[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonObj => asObj(item) != null)
    : [];
}

function getSearchResults(row: AiLogRow): JsonObj[] {
  const response = getResponse(row);
  const request = getRequest(row);
  const metadata = getMetadata(row);
  return [
    ...objectArray(response?.results),
    ...objectArray(response?.sources),
    ...objectArray(request?.results),
    ...objectArray(request?.web_search_results),
    ...objectArray(asObj(request?.context)?.web_search_results),
    ...objectArray(metadata?.results),
    ...objectArray(metadata?.sources),
  ];
}

function hasOnlyResultCount(response: JsonObj | null): boolean {
  if (!response) return false;
  const keys = Object.keys(response);
  return (
    keys.length === 1 &&
    keys[0] === "resultCount" &&
    typeof response.resultCount === "number"
  );
}

function getLlmContent(row: AiLogRow): string | null {
  const response = getResponse(row);
  const content = response?.content ?? response?.text;
  return typeof content === "string" && content.trim() ? content : null;
}

function safeParseJsonObject(text: string): JsonObj | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return asObj(parsed);
  } catch {
    return null;
  }
}

function getDecisionPreview(row: AiLogRow): {
  decision?: string;
  confidence?: unknown;
  reasoning?: string;
} | null {
  const metadata = getMetadata(row);
  if (metadata?.decision || metadata?.confidence) {
    return {
      decision:
        typeof metadata.decision === "string" ? metadata.decision : undefined,
      confidence: metadata.confidence,
      reasoning:
        typeof metadata.reasoning === "string" ? metadata.reasoning : undefined,
    };
  }
  const content = getLlmContent(row);
  if (!content) return null;
  const parsed = safeParseJsonObject(content);
  if (!parsed) return null;
  return {
    decision:
      typeof parsed.decision === "string"
        ? parsed.decision
        : typeof parsed.verdict === "string"
          ? parsed.verdict
          : undefined,
    confidence: parsed.confidence,
    reasoning:
      typeof parsed.reasoning === "string"
        ? parsed.reasoning
        : typeof parsed.explanation === "string"
          ? parsed.explanation
          : undefined,
  };
}

function getRequestQuery(row: AiLogRow): string | null {
  const request = getRequest(row);
  if (typeof request?.query === "string") return request.query;
  if (typeof request?.question === "string") return request.question;
  if (typeof request?.userPrompt === "string") return request.userPrompt;
  return row.query ?? null;
}

function getMaxResults(request: JsonObj | null): unknown {
  return request?.maxResults ?? request?.max_results ?? null;
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-3 border-b border-border/40 py-2 last:border-b-0">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      <div className="min-w-0 break-words text-xs leading-5 text-foreground">
        {value}
      </div>
    </div>
  );
}

function Badge({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded border border-border/70 bg-muted/30 px-1.5 text-[10px] font-medium",
        className,
      )}
    >
      {children}
    </span>
  );
}

function SearchResultsPreview({ row }: { row: AiLogRow }) {
  const results = getSearchResults(row);
  if (results.length === 0) return null;

  return (
    <section className="rounded-lg border border-sky-500/15 bg-sky-950/10 p-3 shadow-sm">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-sky-300/80">
        Search Results
      </div>
      <div className="grid gap-1.5">
        {results.map((r, index) => {
          const title = typeof r.title === "string" ? r.title : "Untitled";
          const url = typeof r.url === "string" ? r.url : "";
          const snippet = typeof r.snippet === "string" ? r.snippet : "";
          return (
            <div
              key={`${url}-${index}`}
              className="rounded-md border border-sky-500/10 bg-background/70 p-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="break-words text-[11px] font-medium text-foreground">
                    {title}
                  </div>
                  {url && (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex max-w-full items-center gap-1 break-all text-[10px] text-sky-400 hover:underline"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <span>{url}</span>
                      <ExternalLink className="size-2.5 shrink-0" />
                    </a>
                  )}
                </div>
                {typeof r.source === "string" && (
                  <Badge className="shrink-0 text-muted-foreground">
                    {r.source}
                  </Badge>
                )}
              </div>
              {snippet && (
                <p className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-4 text-muted-foreground">
                  {snippet}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function RequestDetails({ row }: { row: AiLogRow }) {
  const request = getRequest(row);
  const query = getRequestQuery(row);
  const maxResults = getMaxResults(request);
  const preferredProviders = asStringArray(request?.preferredProviders);
  const providers = asStringArray(request?.providers);

  return (
    <section className="space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        Request Details
      </div>
      <div className="rounded-lg border border-border/70 bg-zinc-950/35 px-3">
        <DetailRow label="Query" value={query} />
        <DetailRow label="Endpoint" value={endpointLabel(row.endpoint)} />
        <DetailRow
          label="Provider"
          value={providerLabel(extractProvider(row))}
        />
        <DetailRow label="Max Results" value={String(maxResults ?? "")} />
        <DetailRow
          label="Providers"
          value={[...preferredProviders, ...providers].join(", ")}
        />
        {!request && (
          <div className="border-t border-border/40 py-2 text-[11px] leading-4 text-muted-foreground">
            Raw request payload was not captured for this row. The search query
            above is the stored request context.
          </div>
        )}
      </div>
    </section>
  );
}

function ResponseDetails({ row }: { row: AiLogRow }) {
  const response = getResponse(row);
  const count = getResultCount(row);
  const results = getSearchResults(row);
  const decision = getDecisionPreview(row);
  const llmContent = getLlmContent(row);
  const answer =
    typeof response?.answer === "string"
      ? response.answer
      : typeof response?.text === "string"
        ? response.text
        : null;
  const reasoning =
    typeof response?.reasoning === "string"
      ? response.reasoning
      : typeof response?.explanation === "string"
        ? response.explanation
        : null;

  if (!response && results.length === 0 && !answer && !llmContent) {
    return (
      <section className="space-y-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Response Details
        </div>
        <div className="rounded-lg border border-border/70 bg-zinc-950/35 p-3 text-[11px] leading-4 text-muted-foreground">
          No response payload was captured for this row.
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        Response Details
      </div>
      <div className="rounded-lg border border-border/70 bg-zinc-950/35 px-3">
        <DetailRow label="Result Count" value={count != null ? count : null} />
        {decision?.decision && (
          <DetailRow
            label="Decision"
            value={`${decision.decision}${
              decision.confidence != null
                ? ` ${String(decision.confidence)}%`
                : ""
            }`}
          />
        )}
        <DetailRow label="Answer" value={answer} />
        <DetailRow label="Reasoning" value={reasoning} />
        {hasOnlyResultCount(response) && (
          <div className="border-t border-border/40 py-2 text-[11px] leading-4 text-muted-foreground">
            This row only stored the result count. Full result titles, snippets,
            and URLs were not captured in this log entry.
          </div>
        )}
      </div>
    </section>
  );
}

function JsonPanel({ title, value }: { title: string; value: unknown }) {
  const text = jsonText(value);
  if (!text) return null;
  return (
    <details
      className="group rounded-lg border border-border/70 bg-zinc-950/45 shadow-sm"
      open
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-2 text-[11px] font-medium text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
        {title}
      </summary>
      <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words border-t border-border/60 bg-black/20 p-2.5 text-[10px] leading-4 text-muted-foreground">
        {text}
      </pre>
    </details>
  );
}

function DetailModal({
  row,
  open,
  onOpenChange,
}: {
  row: AiLogRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!row) return null;

  const request = getRequest(row);
  const response = getResponse(row);
  const metadata = getMetadata(row);
  const decision = getDecisionPreview(row);
  const cost = formatCost(row.costUsd);
  const provider = extractProvider(row);
  const readableProvider = providerLabel(provider);
  const model = shortModelName(row.model);
  const llmContent = getLlmContent(row);
  const step = getStepInfo(row);
  const evidence = Array.isArray(request?.evidence)
    ? (request.evidence as JsonObj[])
    : [];
  const responseSearchQueries = asStringArray(response?.searchQueriesUsed);
  const requestSearchQueries = asStringArray(request?.searchQueriesUsed);
  const searchQueries = [...requestSearchQueries, ...responseSearchQueries];
  const showModelBadge = Boolean(model && model !== provider);
  const operationLabel = endpointLabel(row.endpoint) ?? step.label;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[92vh] max-h-[92vh] w-[96vw] max-w-[1500px] flex-col gap-0 overflow-hidden p-0">
        <div className="shrink-0 border-b border-border bg-muted/20 px-5 py-4 pr-12">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge className={step.tone}>
                  <StepIcon icon={step.icon} className="mr-1 size-3" />
                  {operationLabel}
                </Badge>
                {readableProvider && <Badge>{readableProvider}</Badge>}
                {showModelBadge && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <Badge className="max-w-[220px] cursor-help truncate">
                          {model}
                        </Badge>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent
                      side="bottom"
                      className="max-w-xs font-mono text-[11px]"
                    >
                      {row.model}
                    </TooltipContent>
                  </Tooltip>
                )}
                {getResultCount(row) != null && (
                  <Badge>{getResultCount(row)} results</Badge>
                )}
                {cost && <Badge>{cost}</Badge>}
              </div>
              <DialogTitle className="line-clamp-2 text-base font-semibold leading-5">
                {getPrimaryLine(row)}
              </DialogTitle>
              <DialogDescription className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="inline-flex items-center gap-1">
                  <StatusIcon
                    status={row.status}
                    className={cn(
                      "size-3",
                      row.status === "success" && "text-emerald-400",
                      row.status === "error" && "text-red-400",
                      row.status === "partial" && "text-amber-400",
                    )}
                  />
                  {STATUS_LABEL[row.status] ?? row.status}
                </span>
                {row.durationMs != null && (
                  <span>
                    {row.durationMs >= 1000
                      ? `${(row.durationMs / 1000).toFixed(1)}s`
                      : `${row.durationMs}ms`}
                  </span>
                )}
                {row.createdAt && (
                  <span>
                    {format(parseISO(row.createdAt), "MMM d, yyyy HH:mm:ss")}
                  </span>
                )}
              </DialogDescription>
            </div>
            {decision?.decision && (
              <div className="min-w-[180px] rounded-lg border border-border/70 bg-background/70 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Decision
                </div>
                <div
                  className={cn(
                    "mt-1 text-sm font-semibold",
                    decision.decision === "SAME" && "text-emerald-400",
                    decision.decision === "DIFFERENT" && "text-red-400",
                    decision.decision === "UNCERTAIN" && "text-amber-400",
                  )}
                >
                  {decision.decision}
                  {decision.confidence != null
                    ? ` ${String(decision.confidence)}%`
                    : ""}
                </div>
                {decision.reasoning && (
                  <div className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                    {decision.reasoning}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <div className="min-h-0 overflow-auto border-b border-border p-4 lg:border-b-0 lg:border-r">
            <div className="space-y-4">
              {row.error && (
                <section className="space-y-1.5">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-red-300/80">
                    Error
                  </div>
                  <pre className="max-h-[42vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-red-500/15 bg-red-950/10 p-3 text-[11px] leading-5 text-red-200/80">
                    {row.error}
                  </pre>
                </section>
              )}

              <RequestDetails row={row} />

              {searchQueries.length > 0 && (
                <section className="space-y-1.5">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-sky-300/80">
                    Search Plan
                  </div>
                  <div className="space-y-1">
                    {searchQueries.map((query, index) => (
                      <div
                        key={`${query}-${index}`}
                        className="rounded-md border border-sky-500/10 bg-sky-950/10 px-2 py-1.5 text-[11px] leading-4 text-muted-foreground"
                      >
                        <span className="mr-2 text-[10px] font-medium text-sky-300/70">
                          {index + 1}
                        </span>
                        {query}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <SearchResultsPreview row={row} />
            </div>
          </div>

          <div className="min-h-0 overflow-auto p-4">
            <div className="space-y-4">
              {evidence.length > 0 && row.system === "llm" && (
                <section className="space-y-1.5">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-violet-300/80">
                    Evidence Sent To Model
                  </div>
                  <div className="space-y-2">
                    {evidence.map((item, index) => {
                      const title =
                        typeof item.title === "string"
                          ? item.title
                          : "Untitled";
                      const url = typeof item.url === "string" ? item.url : "";
                      const snippet =
                        typeof item.snippet === "string" ? item.snippet : "";
                      const content =
                        typeof item.content === "string"
                          ? item.content
                          : snippet;
                      const source =
                        typeof item.source === "string" ? item.source : null;
                      return (
                        <div
                          key={`${url}-${index}`}
                          className="rounded-md border border-violet-500/10 bg-violet-950/10 p-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-[11px] font-medium">
                                {title}
                              </div>
                              {url && (
                                <a
                                  href={url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex max-w-full items-center gap-1 break-all text-[10px] text-violet-300/80 hover:underline"
                                  onClick={(event) => event.stopPropagation()}
                                >
                                  <span>{url}</span>
                                  <ExternalLink className="size-2.5 shrink-0" />
                                </a>
                              )}
                            </div>
                            {source && (
                              <Badge className="shrink-0 text-muted-foreground">
                                {source}
                              </Badge>
                            )}
                          </div>
                          {content && (
                            <pre className="mt-2 max-h-[42vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-violet-500/10 bg-black/20 p-2.5 text-[10px] leading-4 text-muted-foreground">
                              {content}
                            </pre>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              <ResponseDetails row={row} />

              {llmContent && !hasOnlyResultCount(response) && (
                <section className="space-y-1.5">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-violet-300/80">
                    Model Response
                  </div>
                  <pre className="max-h-[58vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-violet-500/10 bg-violet-950/10 p-3 text-[11px] leading-5 text-muted-foreground">
                    {llmContent}
                  </pre>
                </section>
              )}

              <JsonPanel title="Request" value={request} />
              <JsonPanel title="Response" value={response} />
              <JsonPanel title="Metadata" value={metadata} />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export type AiActivityTableProps = {
  rows: AiLogRow[];
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
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selectedRow = rows.find((row) => row.id === selectedId) ?? null;

  const columns = useMemo<ColumnDef<AiLogRow, unknown>[]>(
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
                {format(parseISO(t), "MMM d, yyyy HH:mm:ss")}
              </TooltipContent>
            </Tooltip>
          );
        },
        meta: {
          hint: "When the operation occurred.",
          align: "center" as const,
          initialSize: 58,
        },
      },
      {
        id: "flow",
        header: "",
        cell: ({ row }) => {
          const selected = row.original.id === selectedId;
          return (
            <ChevronRight
              className={cn(
                "size-3 transition-colors",
                selected ? "text-primary" : "text-muted-foreground/60",
              )}
            />
          );
        },
        meta: {
          hint: "Click a row to inspect request and response details.",
          align: "center" as const,
          fixed: "left" as const,
          initialSize: 28,
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
                "inline-flex h-5 items-center justify-center rounded-md px-2 text-[10px] font-medium",
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
          initialSize: 72,
        },
      },
      {
        id: "system",
        accessorKey: "system",
        header: "Step",
        cell: ({ row }) => {
          const step = getStepInfo(row.original);
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "inline-flex h-5 items-center gap-1 rounded-md border px-1.5 text-[10px] font-medium cursor-help",
                    step.tone,
                  )}
                >
                  <StepIcon icon={step.icon} className="size-3" />
                  {step.label}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                {SYSTEM_TOOLTIPS[row.original.system] ?? "AI operation"}
              </TooltipContent>
            </Tooltip>
          );
        },
        meta: {
          hint: "Search gathers evidence; LLM consumes evidence and returns a decision.",
          align: "center" as const,
          initialSize: 96,
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
        meta: { hint: "How the operation was triggered.", initialSize: 78 },
      },
      {
        id: "provider",
        header: "Provider",
        cell: ({ row }) => {
          const provider = extractProvider(row.original);
          if (!provider)
            return <span className="text-muted-foreground/40">—</span>;
          return (
            <span
              className={cn(
                "text-[10px] font-medium",
                PROVIDER_COLORS[provider] ?? "text-muted-foreground",
              )}
            >
              {provider}
            </span>
          );
        },
        meta: {
          hint: "Search provider or LLM provider used.",
          align: "center" as const,
          initialSize: 74,
        },
      },
      {
        id: "query",
        accessorKey: "query",
        header: "What Happened",
        cell: ({ row }) => {
          const text = getPrimaryLine(row.original);
          return (
            <div className="min-w-0 max-w-[220px]">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="truncate text-[11px] text-foreground">
                    {text}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-sm text-xs">
                  {text}
                </TooltipContent>
              </Tooltip>
              <div className="truncate text-[10px] text-muted-foreground/70">
                {row.original.endpoint ?? row.original.system}
              </div>
            </div>
          );
        },
        meta: {
          hint: "Search query or LLM operation subject. Click row for full prompt.",
          initialSize: 220,
        },
      },
      {
        id: "result",
        header: "Result",
        cell: ({ row }) => {
          const count = getResultCount(row.original);
          const decision = getDecisionPreview(row.original);
          if (decision?.decision) {
            return (
              <span
                className={cn(
                  "text-[11px] font-medium",
                  decision.decision === "SAME" && "text-emerald-400",
                  decision.decision === "DIFFERENT" && "text-red-400",
                  decision.decision === "UNCERTAIN" && "text-amber-400",
                )}
              >
                {decision.decision}
                {decision.confidence != null
                  ? ` ${String(decision.confidence)}%`
                  : ""}
              </span>
            );
          }
          if (count != null) {
            return (
              <span className="tabular-nums text-[11px] text-muted-foreground">
                {count} results
              </span>
            );
          }
          return <span className="text-muted-foreground/40">—</span>;
        },
        meta: {
          hint: "Search result count or LLM verdict.",
          initialSize: 96,
        },
      },
      {
        id: "duration",
        accessorKey: "durationMs",
        header: "Duration",
        cell: ({ row }) => {
          const ms = row.original.durationMs;
          if (ms == null)
            return <span className="text-muted-foreground/40">—</span>;
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
          initialSize: 70,
        },
      },
      {
        id: "error",
        header: "Error",
        accessorKey: "error",
        cell: ({ row }) => {
          const e = row.original.error;
          if (!e) return <span className="text-muted-foreground/40">—</span>;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-block max-w-[150px] truncate text-[10px] text-red-400 cursor-help">
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
        meta: { hint: "Detailed error message.", initialSize: 150 },
      },
    ],
    [selectedId],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1">
        <DataTable<AiLogRow>
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
          onRowClick={(row) => setSelectedId(row.id)}
          rowClassName={(row) =>
            row.id === selectedId
              ? "bg-primary/8 hover:bg-primary/10"
              : undefined
          }
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
      </div>
      <DetailModal
        row={selectedRow}
        open={selectedRow != null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      />
    </div>
  );
}
