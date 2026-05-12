"use client";

import { useCallback, useState } from "react";
import {
  AlertCircle,
  Bot,
  Check,
  Clock,
  Copy,
  ExternalLink,
  FileJson,
  GitCompareArrows,
  Lightbulb,
  Search,
  Send,
  Zap,
  Cpu,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
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
import { cn } from "@/lib/utils";
import { formatApiError } from "./OverviewTab";

// ── Types ────────────────────────────────────────────────────────

type PlaygroundMode =
  | "grounded-query"
  | "search"
  | "entity-match"
  | "verify-settlement";

interface SourceCitation {
  url: string;
  title: string;
  snippet?: string;
}

interface GroundedAnswer {
  answer: string;
  reasoning: string;
  sources: SourceCitation[];
  model?: string;
}

/** Entity-match returns a different shape from the Python service. */
interface EntityMatchAnswer {
  decision: string;
  confidence: number;
  reasoning: string;
  sources: SourceCitation[];
  model?: string;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  score: number | null;
}
interface SearchResponse {
  query: string;
  results: SearchResult[];
  provider_used: string;
  cached: boolean;
}

// ── Mode config with descriptions and examples ───────────────────

interface ModeConfig {
  label: string;
  icon: typeof Bot;
  placeholder: string;
  description: string;
  examples: string[];
}

const MODE_META: Record<PlaygroundMode, ModeConfig> = {
  "grounded-query": {
    label: "Grounded Query",
    icon: Bot,
    placeholder: "Ask a question with web grounding…",
    description:
      "Ask any question — the AI searches the web first, then answers with cited sources.",
    examples: [
      "What is the current form of Real Madrid in La Liga 2025?",
      "Who won the last 5 matches between Bangladesh and India in cricket?",
      "What are the latest injury updates for Manchester City?",
    ],
  },
  search: {
    label: "Raw Search",
    icon: Search,
    placeholder: "Try a raw search query…",
    description:
      "Run a direct web search and see ranked results from configured providers.",
    examples: [
      "Premier League standings 2025",
      "IPL 2025 match results today",
      "Champions League quarter-final odds",
    ],
  },
  "entity-match": {
    label: "Entity Match",
    icon: GitCompareArrows,
    placeholder: "",
    description:
      "Test whether two events from different providers refer to the same match.",
    examples: [],
  },
  "verify-settlement": {
    label: "Settlement Verify",
    icon: Check,
    placeholder: "Describe the bet or ask about the match result…",
    description:
      "Verify a match result or bet outcome using web-grounded search.",
    examples: [
      "What was the final score of Barcelona vs Real Madrid?",
      "Did over 2.5 goals hit in Liverpool vs Arsenal?",
      "Who won the toss in India vs Australia 3rd Test?",
    ],
  },
};

// ── Prefilled entity-match examples ──────────────────────────────

interface EventFields {
  home: string;
  away: string;
  comp: string;
  time: string;
  provider: string;
}

interface EntityMatchExample {
  label: string;
  eventA: EventFields;
  eventB: EventFields;
}

/** Generate an ISO string for "today at 20:00 local time" for realistic prefill. */
function todayAt(hour: number): string {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

const ENTITY_MATCH_EXAMPLES: EntityMatchExample[] = [
  {
    label: "Same match, different names",
    eventA: {
      home: "Real Madrid CF",
      away: "FC Barcelona",
      comp: "La Liga",
      time: todayAt(20),
      provider: "Pinnacle",
    },
    eventB: {
      home: "R. Madrid",
      away: "Barcelona",
      comp: "Spanish La Liga",
      time: todayAt(20),
      provider: "Betfair",
    },
  },
  {
    label: "Cricket — BPL match",
    eventA: {
      home: "Dhaka Dominators",
      away: "Chattogram Challengers",
      comp: "BPL 2025",
      time: todayAt(18),
      provider: "NineWickets",
    },
    eventB: {
      home: "Dhaka",
      away: "Chattogram",
      comp: "Bangladesh Premier League",
      time: todayAt(18),
      provider: "Velki",
    },
  },
  {
    label: "Different matches (should NOT match)",
    eventA: {
      home: "Arsenal",
      away: "Chelsea",
      comp: "Premier League",
      time: todayAt(17),
      provider: "Pinnacle",
    },
    eventB: {
      home: "Arsenal",
      away: "Liverpool",
      comp: "FA Cup",
      time: todayAt(19),
      provider: "Betfair",
    },
  },
];

// ── Playground Tab ───────────────────────────────────────────────

export function PlaygroundTab({
  serviceOnline,
  availableModels,
  defaultModel,
  hfAvailable,
}: {
  serviceOnline: boolean;
  availableModels: string[];
  defaultModel: string;
  hfAvailable: boolean;
}) {
  const [mode, setMode] = useState<PlaygroundMode>("grounded-query");
  const [selectedModel, setSelectedModel] = useState(defaultModel);
  const [provider, setProvider] = useState<"default" | "huggingface">(
    "default",
  );

  // Query state
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Entity match fields
  const [eventA, setEventA] = useState<EventFields>({
    home: "",
    away: "",
    comp: "",
    time: "",
    provider: "",
  });
  const [eventB, setEventB] = useState<EventFields>({
    home: "",
    away: "",
    comp: "",
    time: "",
    provider: "",
  });

  // Results
  const [groundedResult, setGroundedResult] = useState<GroundedAnswer | null>(
    null,
  );
  const [entityResult, setEntityResult] = useState<EntityMatchAnswer | null>(
    null,
  );
  const [searchResult, setSearchResult] = useState<SearchResponse | null>(null);
  const [rawJson, setRawJson] = useState<unknown>(null);
  const [showRawJson, setShowRawJson] = useState(false);
  const [lastDurationMs, setLastDurationMs] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  // Track if user has run anything (to show/hide empty state)
  const hasResults = Boolean(
    groundedResult || entityResult || searchResult || error || isLoading,
  );

  const resetResults = () => {
    setError(null);
    setGroundedResult(null);
    setEntityResult(null);
    setSearchResult(null);
    setRawJson(null);
  };

  const EMPTY_EVENT: EventFields = {
    home: "",
    away: "",
    comp: "",
    time: "",
    provider: "",
  };

  const handleSubmit = useCallback(async () => {
    setIsLoading(true);
    resetResults();
    setLastDurationMs(null);
    const start = Date.now();

    try {
      let res: Response;
      let body: Record<string, unknown>;

      if (mode === "grounded-query") {
        if (!query.trim()) return;
        body = {
          question: query,
          model:
            provider === "huggingface" ? undefined : selectedModel || undefined,
          service: "Playground",
          ...(provider === "huggingface" ? { provider: "huggingface" } : {}),
        };
        res = await fetch("/api/ai-search/grounded-query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else if (mode === "search") {
        if (!query.trim()) return;
        body = { query, max_results: 5, service: "Playground" };
        res = await fetch("/api/ai-search/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else if (mode === "entity-match") {
        body = {
          event_a: {
            home_team: eventA.home,
            away_team: eventA.away,
            competition: eventA.comp,
            start_time: eventA.time || new Date().toISOString(),
            provider: eventA.provider || "A",
          },
          event_b: {
            home_team: eventB.home,
            away_team: eventB.away,
            competition: eventB.comp,
            start_time: eventB.time || new Date().toISOString(),
            provider: eventB.provider || "B",
          },
          service: "Playground",
        };
        res = await fetch("/api/ai-search/entity-match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        if (!query.trim()) return;
        body = { question: query, service: "Playground" };
        res = await fetch("/api/ai-search/verify-settlement", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }

      const duration = Date.now() - start;
      setLastDurationMs(duration);
      const data = await res
        .json()
        .catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) throw new Error(formatApiError(data, `HTTP ${res.status}`));
      setRawJson(data);

      if (mode === "search") setSearchResult(data as SearchResponse);
      else if (mode === "entity-match")
        setEntityResult(data as EntityMatchAnswer);
      else setGroundedResult(data as GroundedAnswer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setIsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, query, selectedModel, eventA, eventB, serviceOnline]);

  const handleCopy = () => {
    const text =
      groundedResult?.answer ||
      (rawJson ? JSON.stringify(rawJson, null, 2) : "");
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleExampleClick = (example: string) => {
    setQuery(example);
    resetResults();
  };

  const handleEntityExample = (ex: EntityMatchExample) => {
    setEventA(ex.eventA);
    setEventB(ex.eventB);
    resetResults();
  };

  // HF provider works without the Python AI Search service being online
  const effectiveOnline =
    serviceOnline || (provider === "huggingface" && hfAvailable);

  const canSubmit =
    effectiveOnline &&
    !isLoading &&
    (mode === "entity-match"
      ? eventA.home && eventA.away && eventB.home && eventB.away
      : query.trim());

  const currentMeta = MODE_META[mode];

  return (
    <div className="flex flex-col gap-4 min-h-0">
      {/* Mode selector + description */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {(Object.entries(MODE_META) as [PlaygroundMode, ModeConfig][]).map(
            ([key, m]) => (
              <Tooltip key={key}>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant={mode === key ? "default" : "outline"}
                    className={cn(
                      "h-7 text-xs gap-1.5",
                      mode === key && "shadow-md",
                    )}
                    onClick={() => {
                      setMode(key);
                      resetResults();
                      setQuery("");
                      setEventA(EMPTY_EVENT);
                      setEventB(EMPTY_EVENT);
                    }}
                  >
                    <m.icon className="size-3" />
                    {m.label}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{m.description}</TooltipContent>
              </Tooltip>
            ),
          )}
          <div className="ml-auto">
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <Select
                    value={selectedModel}
                    onValueChange={setSelectedModel}
                  >
                    <SelectTrigger className="h-7 w-auto min-w-[160px] text-xs font-mono">
                      <SelectValue placeholder="Select model…" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableModels.map((m) => (
                        <SelectItem
                          key={m}
                          value={m}
                          className="text-xs font-mono"
                        >
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </TooltipTrigger>
              <TooltipContent>LLM model for this request</TooltipContent>
            </Tooltip>
          </div>
        </div>
        {/* Mode description */}
        <p className="text-xs text-muted-foreground/70 flex items-center gap-1.5">
          <Lightbulb className="size-3 shrink-0 text-amber-400/60" />
          {currentMeta.description}
        </p>

        {/* Provider selector — visible when HF is available and on grounded-query mode */}
        {hfAvailable && mode === "grounded-query" && (
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-semibold mr-0.5">
              Provider:
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant={provider === "default" ? "default" : "outline"}
                  className={cn(
                    "h-6 text-[11px] gap-1 px-2",
                    provider === "default" && "shadow-sm",
                  )}
                  onClick={() => setProvider("default")}
                >
                  <Zap className="size-2.5" />
                  Primary
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Use HuggingFace + search grounding via AI Search
                {!serviceOnline && " (offline)"}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant={provider === "huggingface" ? "default" : "outline"}
                  className={cn(
                    "h-6 text-[11px] gap-1 px-2",
                    provider === "huggingface" && "shadow-sm",
                  )}
                  onClick={() => setProvider("huggingface")}
                >
                  <Cpu className="size-2.5" />
                  HF Direct
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Use HuggingFace Router without search grounding
              </TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      {/* Input area */}
      {mode === "entity-match" ? (
        <div className="space-y-3">
          {/* Entity match example presets */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-semibold mr-1">
              Try:
            </span>
            {ENTITY_MATCH_EXAMPLES.map((ex) => (
              <Tooltip key={ex.label}>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => handleEntityExample(ex)}
                    className="inline-flex items-center gap-1 rounded-md border border-border/40 bg-muted/20 px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/40 hover:text-foreground/80 hover:border-border/60 transition-all"
                  >
                    <Zap className="size-2.5 text-amber-400/70" />
                    {ex.label}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs text-xs">
                  <span className="font-medium">{ex.eventA.provider}:</span>{" "}
                  {ex.eventA.home} vs {ex.eventA.away}
                  <br />
                  <span className="font-medium">
                    {ex.eventB.provider}:
                  </span>{" "}
                  {ex.eventB.home} vs {ex.eventB.away}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              {
                label: "Event A",
                sublabel: "Provider 1",
                state: eventA,
                set: setEventA,
              },
              {
                label: "Event B",
                sublabel: "Provider 2",
                state: eventB,
                set: setEventB,
              },
            ].map(({ label, sublabel, state, set }) => (
              <div
                key={label}
                className="rounded-lg border border-border/50 bg-muted/10 p-3 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold">
                    {label}
                  </div>
                  <span className="text-[9px] text-muted-foreground/40">
                    {sublabel}
                  </span>
                </div>
                <Input
                  placeholder="Home team"
                  value={state.home}
                  onChange={(e) => set({ ...state, home: e.target.value })}
                  className="h-7 text-sm"
                />
                <Input
                  placeholder="Away team"
                  value={state.away}
                  onChange={(e) => set({ ...state, away: e.target.value })}
                  className="h-7 text-sm"
                />
                <Input
                  placeholder="Competition"
                  value={state.comp}
                  onChange={(e) => set({ ...state, comp: e.target.value })}
                  className="h-7 text-sm"
                />
                <Input
                  placeholder="Start time (ISO)"
                  value={state.time}
                  onChange={(e) => set({ ...state, time: e.target.value })}
                  className="h-7 text-sm"
                />
                <Input
                  placeholder="Provider"
                  value={state.provider}
                  onChange={(e) => set({ ...state, provider: e.target.value })}
                  className="h-7 text-sm"
                />
              </div>
            ))}
          </div>
          <Button
            className="h-9 gap-1.5 w-full sm:w-auto"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            <Send className={cn("size-3.5", isLoading && "animate-pulse")} />
            {isLoading ? "Matching…" : "Match Events"}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex-1">
                  <Input
                    placeholder={currentMeta.placeholder}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) =>
                      e.key === "Enter" && canSubmit && handleSubmit()
                    }
                    className="h-9 text-sm"
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent>Press Enter to submit</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    className="h-9 px-4 gap-1.5"
                    onClick={handleSubmit}
                    disabled={!canSubmit}
                  >
                    <Send
                      className={cn("size-3.5", isLoading && "animate-pulse")}
                    />
                    {isLoading ? "Thinking…" : "Send"}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {!serviceOnline ? "Service offline" : "Run query"}
              </TooltipContent>
            </Tooltip>
          </div>
          {/* Example queries — only show when input is empty and no results */}
          {!query && !hasResults && currentMeta.examples.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-semibold mr-1">
                Try:
              </span>
              {currentMeta.examples.map((ex) => (
                <button
                  key={ex}
                  onClick={() => handleExampleClick(ex)}
                  className="inline-flex items-center gap-1 rounded-md border border-border/40 bg-muted/20 px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/40 hover:text-foreground/80 hover:border-border/60 transition-all"
                >
                  <Zap className="size-2.5 text-amber-400/70" />
                  <span className="line-clamp-1">{ex}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-destructive bg-destructive/10 border border-destructive/30">
          <AlertCircle className="size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      )}

      {/* Empty state — shown before first query */}
      {!hasResults && !isLoading && (
        <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
          <div className="rounded-xl border border-border/30 bg-muted/10 p-4">
            <currentMeta.icon className="size-8 text-muted-foreground/30" />
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground/60">
              {mode === "entity-match"
                ? "Fill in two events above, or click a preset to get started"
                : "Type a query above or click an example to get started"}
            </p>
            <p className="text-xs text-muted-foreground/40 mt-1">
              Results are logged to AI Activity for full traceability
            </p>
          </div>
        </div>
      )}

      {/* Results */}
      {(groundedResult || entityResult || searchResult) && (
        <div className="rounded-xl border border-border/50 bg-card/40 overflow-hidden">
          {/* Metadata bar */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-border/30 bg-muted/10">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              {(groundedResult?.model || entityResult?.model) && (
                <Badge variant="outline" className="text-[10px] font-mono">
                  {groundedResult?.model ?? entityResult?.model}
                </Badge>
              )}
              {searchResult?.provider_used && (
                <Badge variant="outline" className="text-[10px] font-mono">
                  {searchResult.provider_used}
                </Badge>
              )}
              {searchResult?.cached && (
                <Badge variant="secondary" className="text-[9px]">
                  cached
                </Badge>
              )}
              {lastDurationMs != null && (
                <span className="flex items-center gap-1">
                  <Clock className="size-3" />
                  {lastDurationMs.toLocaleString()}ms
                </span>
              )}
              {searchResult && (
                <span>{searchResult.results.length} results</span>
              )}
              {(groundedResult?.sources ?? entityResult?.sources) && (
                <span>
                  {(groundedResult?.sources ?? entityResult?.sources)!.length}{" "}
                  sources
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-6"
                    onClick={handleCopy}
                  >
                    {copied ? (
                      <Check className="size-3 text-emerald-400" />
                    ) : (
                      <Copy className="size-3" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Copy answer</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    variant={showRawJson ? "default" : "ghost"}
                    className="size-6"
                    onClick={() => setShowRawJson(!showRawJson)}
                  >
                    <FileJson className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {showRawJson ? "Hide" : "Show"} raw JSON
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          <div className="p-4 space-y-3">
            {showRawJson ? (
              <pre className="text-xs font-mono text-muted-foreground/80 whitespace-pre-wrap break-all max-h-[400px] overflow-y-auto bg-muted/20 rounded-lg p-3">
                {JSON.stringify(rawJson, null, 2)}
              </pre>
            ) : entityResult ? (
              <>
                <div className="flex items-center gap-2 mb-1">
                  <Badge
                    variant={
                      entityResult.decision === "SAME"
                        ? "default"
                        : "destructive"
                    }
                    className="text-xs"
                  >
                    {entityResult.decision}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    Confidence:{" "}
                    {Math.round((entityResult.confidence ?? 0) * 100)}%
                  </span>
                </div>
                {entityResult.reasoning && (
                  <div>
                    <div className="text-xs font-semibold text-foreground/80 mb-1">
                      Reasoning
                    </div>
                    <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                      {entityResult.reasoning}
                    </p>
                  </div>
                )}
                {entityResult.sources?.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-xs font-semibold text-foreground/80">
                      Sources
                    </div>
                    {entityResult.sources.slice(0, 8).map((s, i) => (
                      <a
                        key={`${s.url}-${i}`}
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-xs text-cyan-300 hover:text-cyan-200"
                      >
                        <ExternalLink className="size-3 shrink-0" />
                        <span className="line-clamp-1">{s.title || s.url}</span>
                      </a>
                    ))}
                  </div>
                )}
              </>
            ) : groundedResult ? (
              <>
                <div>
                  <div className="text-xs font-semibold text-foreground/80 mb-1">
                    Answer
                  </div>
                  <p className="text-sm text-foreground/90 whitespace-pre-wrap">
                    {groundedResult.answer}
                  </p>
                </div>
                {groundedResult.reasoning && (
                  <div>
                    <div className="text-xs font-semibold text-foreground/80 mb-1">
                      Reasoning
                    </div>
                    <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                      {groundedResult.reasoning}
                    </p>
                  </div>
                )}
                {groundedResult.sources.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-xs font-semibold text-foreground/80">
                      Sources
                    </div>
                    {groundedResult.sources.slice(0, 8).map((s, i) => (
                      <a
                        key={`${s.url}-${i}`}
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-xs text-cyan-300 hover:text-cyan-200"
                      >
                        <ExternalLink className="size-3 shrink-0" />
                        <span className="line-clamp-1">{s.title || s.url}</span>
                      </a>
                    ))}
                  </div>
                )}
              </>
            ) : searchResult ? (
              <div className="space-y-2">
                {searchResult.results.map((r, i) => (
                  <div
                    key={`${r.url}-${i}`}
                    className="group rounded-lg border border-border/40 bg-muted/20 p-3 hover:border-border/60 hover:bg-muted/30 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <a
                          href={r.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm font-medium text-foreground/90 hover:text-cyan-400 transition-colors line-clamp-1 flex items-center gap-1"
                        >
                          {r.title}
                          <ExternalLink className="size-3 shrink-0 opacity-0 group-hover:opacity-60 transition-opacity" />
                        </a>
                        <p className="text-xs text-muted-foreground/70 line-clamp-2 mt-0.5">
                          {r.snippet}
                        </p>
                      </div>
                      <Badge
                        variant="outline"
                        className="text-[9px] font-mono shrink-0"
                      >
                        {r.source}
                      </Badge>
                    </div>
                  </div>
                ))}
                {searchResult.results.length === 0 && (
                  <div className="text-center py-6 text-sm text-muted-foreground/60">
                    No results found.
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
