"use client";

import { useState, useEffect } from "react";
import { AppShell } from "@/components/nav/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  CheckCircle2,
  X,
  Terminal,
  BrainCircuit,
  Globe,
  ChevronDown,
  ChevronRight,
  Activity,
  Copy,
  Check,
  ArrowRight,
  Info,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAiProviders, type AiProvider } from "@/app/ai-engine/useAiProviders";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Markdown renderer for AI answers — supports GFM (tables, strikethrough,
 * task lists), inline + fenced code, links, blockquotes, and headings.
 * Styled to fit the dark playground theme without relying on @tailwindcss/typography.
 */
function Markdown({ text }: { text: string }) {
  return (
    <div className="text-[13.5px] leading-relaxed text-foreground/90 [&_*+*]:mt-2 [&>*:first-child]:mt-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (props) => <h1 className="text-[16px] font-semibold text-foreground mt-3 mb-1.5" {...props} />,
          h2: (props) => <h2 className="text-[15px] font-semibold text-foreground mt-3 mb-1.5" {...props} />,
          h3: (props) => <h3 className="text-[14px] font-semibold text-foreground mt-2.5 mb-1" {...props} />,
          h4: (props) => <h4 className="text-[13px] font-semibold text-foreground mt-2 mb-1" {...props} />,
          p: (props) => <p className="leading-relaxed" {...props} />,
          a: (props) => (
            <a
              {...props}
              target="_blank"
              rel="noreferrer"
              className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2 decoration-cyan-500/40 hover:decoration-cyan-300"
            />
          ),
          ul: (props) => <ul className="list-disc pl-5 space-y-0.5 marker:text-muted-foreground/50" {...props} />,
          ol: (props) => <ol className="list-decimal pl-5 space-y-0.5 marker:text-muted-foreground/60" {...props} />,
          li: (props) => <li className="leading-snug" {...props} />,
          strong: (props) => <strong className="font-semibold text-foreground" {...props} />,
          em: (props) => <em className="italic text-foreground/80" {...props} />,
          blockquote: (props) => (
            <blockquote
              className="border-l-2 border-cyan-500/40 pl-3 text-muted-foreground/90 italic"
              {...props}
            />
          ),
          code: ({ className, children, ...rest }) => {
            const isBlock = /language-/.test(className ?? "");
            if (isBlock) {
              return (
                <code
                  className={cn(
                    "block rounded border border-border/40 bg-background/60 p-2.5 my-2",
                    "font-mono text-[12px] leading-relaxed text-foreground/85 overflow-x-auto whitespace-pre",
                    className,
                  )}
                  {...rest}
                >
                  {children}
                </code>
              );
            }
            return (
              <code
                className="font-mono text-[12px] px-1 py-0.5 rounded bg-background/70 border border-border/30 text-cyan-300/90"
                {...rest}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => <pre className="my-2">{children}</pre>,
          hr: () => <hr className="border-border/30 my-3" />,
          table: (props) => (
            <div className="overflow-x-auto my-2">
              <table className="w-full text-[12.5px] border-collapse" {...props} />
            </div>
          ),
          thead: (props) => <thead className="bg-card/40" {...props} />,
          th: (props) => <th className="border border-border/40 px-2 py-1 text-left font-semibold" {...props} />,
          td: (props) => <td className="border border-border/40 px-2 py-1 align-top" {...props} />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

// ── LLM family/tier organisation ──────────────────────────────────────────
// Display order for the 2-step provider selector. The hook returns whatever
// rows exist in `ai_provider_config`; this maps them to a (family, tier) grid.

type LlmFamily = "deepseek" | "gemini";
type LlmTier = "lite" | "flash" | "pro";

const LLM_FAMILY_ORDER: LlmFamily[] = ["deepseek", "gemini"];
const LLM_TIER_ORDER: LlmTier[] = ["lite", "flash", "pro"];

const FAMILY_LABELS: Record<LlmFamily, string> = {
  deepseek: "DeepSeek",
  gemini: "Gemini",
};

const TIER_LABELS: Record<LlmTier, string> = {
  lite: "Lite",
  flash: "Flash",
  pro: "Pro",
};

function getFamily(p: AiProvider): LlmFamily | null {
  if (p.name.startsWith("deepseek")) return "deepseek";
  if (p.name.startsWith("gemini")) return "gemini";
  return null;
}

function getTier(p: AiProvider): LlmTier | null {
  if (p.tier === "lite" || p.tier === "flash" || p.tier === "pro") return p.tier;
  return null;
}

export default function AIPlayground() {
  // ── Providers from DB ────────────────────────────────────────────
  const { llmProviders, searchProviders, isLoading: llmLoading } = useAiProviders();

  // ── Composer + model state ────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [executedQuery, setExecutedQuery] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<AiProvider | null>(null);
  const [useWebSearch, setUseWebSearch] = useState(true);
  const [searchProvider, setSearchProvider] = useState<string>("auto");

  // ── Run state ────────────────────────────────────────────────
  const [isExecuting, setIsExecuting] = useState(false);
  const [step1State, setStep1State] = useState<"idle" | "running" | "done" | "error">("idle");
  const [step1Results, setStep1Results] = useState<SearchResult[] | null>(null);
  const [step1Error, setStep1Error] = useState<string | null>(null);

  const [step2State, setStep2State] = useState<"idle" | "running" | "done" | "error">("idle");
  const [step2Answer, setStep2Answer] = useState<string | null>(null);
  const [step2Reasoning, setStep2Reasoning] = useState<string | null>(null);
  const [step2Usage, setStep2Usage] = useState<{ totalTokens?: number } | null>(null);

  const [isCotExpanded, setIsCotExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);

  // Default selection priority once providers load:
  //   1. deepseek-flash (the explicit, most-cost-effective default)
  //   2. any other enabled DeepSeek tier (preferring flash → pro → lite)
  //   3. any enabled Gemini tier (preferring flash → pro → lite)
  //   4. any enabled provider as last resort
  useEffect(() => {
    if (llmLoading || llmProviders.length === 0 || selectedProvider) return;

    const pickByFamily = (family: LlmFamily): AiProvider | undefined => {
      const orderedTiers: LlmTier[] = ["flash", "pro", "lite"];
      for (const tier of orderedTiers) {
        const found = llmProviders.find(
          (p) => getFamily(p) === family && getTier(p) === tier && p.enabled,
        );
        if (found) return found;
      }
      return undefined;
    };

    const deepseekFlash = llmProviders.find(
      (p) => p.name === "deepseek-flash" && p.enabled,
    );

    const chosen =
      deepseekFlash ??
      pickByFamily("deepseek") ??
      pickByFamily("gemini") ??
      llmProviders.find((p) => p.enabled);

    if (chosen) setSelectedProvider(chosen);
  }, [llmProviders, llmLoading, selectedProvider]);

  const providerDisabled = selectedProvider ? !selectedProvider.enabled : false;

  const handleExecute = async () => {
    const currentQuery = query.trim();
    if (!currentQuery || isExecuting || !selectedProvider) return;

    setIsExecuting(true);
    setExecutedQuery(currentQuery);
    setQuery("");
    setStep1State("idle");
    setStep1Results(null);
    setStep1Error(null);
    setStep2State("idle");
    setStep2Answer(null);
    setStep2Reasoning(null);
    setStep2Usage(null);
    setLatency(null);
    setCopied(false);

    const startTime = Date.now();
    let step1Running = false;
    let step2Running = false;

    try {
      let searchContext: { web_search_results: SearchResult[] } | null = null;

      if (useWebSearch) {
        step1Running = true;
        setStep1State("running");
        const searchRes = await fetch("/api/ai-search/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: currentQuery,
            providers: searchProvider === "auto" ? undefined : [searchProvider],
            max_results: 10,
          }),
        });

        if (!searchRes.ok) {
          let detail = "";
          try {
            const errBody = (await searchRes.json()) as { error?: string; detail?: unknown };
            detail = errBody.error ?? (typeof errBody.detail === "string" ? errBody.detail : JSON.stringify(errBody.detail ?? ""));
          } catch { /* not JSON */ }
          throw new Error(detail ? `Web grounding failed (${searchRes.status}): ${detail}` : `Web grounding failed (HTTP ${searchRes.status})`);
        }

        const searchData = (await searchRes.json()) as { results?: SearchResult[]; providerUsed?: string };

        if (searchData.providerUsed === "none") {
          throw new Error("Web grounding failed: no search providers returned results.");
        }

        setStep1Results(searchData.results || []);
        searchContext = { web_search_results: searchData.results || [] };
        setStep1State("done");
        step1Running = false;
      }

      step2Running = true;
      setStep2State("running");
      const res = await fetch("/api/ai-search/grounded-query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: currentQuery,
          context: searchContext,
          skip_search: true,
          provider: selectedProvider.name.split("-")[0],
          model: selectedProvider.modelId,
        }),
      });
      if (!res.ok) throw new Error("AI failed");
      const data = await res.json();
      setStep2Answer(data.answer);
      setStep2Reasoning(data.reasoning);
      setStep2State("done");
      step2Running = false;
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : String(err);
      if (step1Running) {
        setStep1Error(message);
        setStep1State("error");
      }
      if (step2Running) setStep2State("error");
    } finally {
      setIsExecuting(false);
      setLatency(Date.now() - startTime);
    }
  };

  const showTrace = step1State !== "idle" || step2State !== "idle" || executedQuery;

  // Football-contextual suggestions. Live queries when web grounding is on,
  // analytical questions otherwise.
  const suggestions = useWebSearch
    ? [
        "Today's Premier League fixtures and predicted lineups",
        "La Liga top scorers and assist leaders this season",
        "Champions League matches this week with venue and kickoff",
        "Latest injury news for Manchester City",
        "Bundesliga relegation race standings",
        "Recent transfer rumours and confirmed deals",
      ]
    : [
        "Explain expected goals (xG) and how it differs from shots-on-target",
        "Compare Asian handicap vs European 1X2 markets for value betting",
        "How to identify value in over/under 2.5 goals markets",
        "Walk through the Kelly criterion for staking decisions",
        "Pros and cons of in-play vs pre-match betting on corners",
        "How does closing line value (CLV) measure long-term edge?",
      ];

  return (
    <AppShell
      title="AI Playground"
      edgeToEdge
      titleBadge={
        <Badge variant="outline" className="ml-2 bg-cyan-500/10 text-cyan-400 border-cyan-500/20 text-[10px] rounded font-mono uppercase py-0.5 tracking-[0.08em]">
          <Terminal className="size-3 mr-1 inline-block" />
          {selectedProvider?.label ?? (llmLoading ? "Loading…" : "No provider")}
        </Badge>
      }
      actions={
        latency !== null ? (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-card/50 border border-border/40 text-[11px] font-mono text-muted-foreground">
            <Activity className="size-3 text-emerald-400" />
            <span>{latency}ms{step2Usage?.totalTokens ? ` · ${step2Usage.totalTokens} tok` : ""}</span>
          </div>
        ) : null
      }
    >
      <div className="flex flex-1 min-h-0 w-full font-sans">
        <div className="flex-1 flex flex-col min-w-0 relative">
          {showTrace ? (
            <ScrollArea className="flex-1">
              <div className="px-6 py-5 pb-56 w-full space-y-6">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground">Execution Trace</span>
                    {latency !== null && (
                      <span className="font-mono text-[11px] text-emerald-400">{latency}ms{step2Usage?.totalTokens ? ` · ${step2Usage.totalTokens} tokens` : ""}</span>
                    )}
                  </div>
                  <div className="h-px bg-border/40 w-full" />
                </div>

                {executedQuery && (
                  <div className="space-y-1.5">
                    <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground">Query</span>
                    <p className="text-[14px] text-foreground/90 leading-snug">{executedQuery}</p>
                  </div>
                )}

                {useWebSearch && step1State !== "idle" && (
                <div className="space-y-2.5">
                  <div className="flex items-center gap-2">
                    {step1State === "running" ? <Spinner className="size-3.5 text-cyan-400" />
                      : step1State === "done" ? <CheckCircle2 className="size-4 text-emerald-400" />
                        : <X className="size-4 text-red-400" />}
                    <span className="text-[13px] font-semibold">Web Grounding</span>
                    {step1Results && step1State === "done" && (
                      <span className="font-mono text-[10px] text-muted-foreground/70">{step1Results.length} sources</span>
                    )}
                    {step1State === "error" && <span className="font-mono text-[10px] text-red-400/80 uppercase tracking-[0.08em]">Failed</span>}
                  </div>

                  {step1State === "error" && step1Error && (
                    <div className="p-3 border border-red-500/30 bg-red-500/5 rounded text-[12px] text-red-300/90 leading-snug">
                      <p className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-red-400/80 mb-1">Grounding aborted</p>
                      {step1Error}
                    </div>
                  )}

                  {step1Results && step1Results.length > 0 && (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-3 gap-y-0.5">
                      {step1Results.map((r, i) => {
                        const domain = (() => {
                          try { return new URL(r.url).hostname.replace(/^www\./, ""); }
                          catch { return r.url; }
                        })();
                        return (
                          <a
                            key={`${r.url}-${i}`}
                            href={r.url}
                            target="_blank"
                            rel="noreferrer"
                            title={`${r.title}\n${r.url}\n\n${r.snippet}`}
                            className="group flex items-baseline gap-2 py-1 px-1.5 -mx-1.5 rounded hover:bg-card/40 transition-colors min-w-0"
                          >
                            <span className="font-mono text-[10px] font-bold text-emerald-400/70 shrink-0 tabular-nums w-5">[{i + 1}]</span>
                            <span className="text-[12px] text-foreground/85 group-hover:text-foreground truncate flex-1 min-w-0 leading-snug">
                              {r.title || domain}
                            </span>
                            <span className="font-mono text-[10px] text-cyan-400/60 shrink-0 truncate max-w-[140px]">
                              {domain}
                            </span>
                          </a>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

                {step2State !== "idle" && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      {step2State === "running" ? <Spinner className="size-3.5 text-cyan-400" />
                        : step2State === "done" ? <CheckCircle2 className="size-4 text-emerald-400" />
                          : <X className="size-4 text-red-400" />}
                      <span className="text-[13px] font-semibold">AI Synthesis</span>
                      {step2State === "done" && step2Answer && (
                        <span className="font-mono text-[10px] text-muted-foreground/60 ml-auto">
                          {step2Answer.length.toLocaleString()} chars
                        </span>
                      )}
                    </div>

                    {step2Reasoning && (
                      <div className="rounded border border-border/40 bg-card/20 overflow-hidden">
                        <button
                          type="button"
                          onClick={() => setIsCotExpanded((v) => !v)}
                          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-card/40 transition-colors"
                        >
                          {isCotExpanded ? (
                            <ChevronDown className="size-3.5 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="size-3.5 text-muted-foreground" />
                          )}
                          <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
                            Chain of Thought
                          </span>
                          <span className="font-mono text-[10px] text-muted-foreground/50 ml-auto tabular-nums">
                            {step2Reasoning.split(/\n+/).filter(Boolean).length} lines · {step2Reasoning.length.toLocaleString()} chars
                          </span>
                        </button>
                        {isCotExpanded && (
                          <div className="border-t border-border/40 bg-background/40">
                            <div className="px-3 py-2.5 font-mono text-[11.5px] leading-[1.65] text-muted-foreground/85 whitespace-pre-wrap max-h-[320px] overflow-y-auto">
                              {step2Reasoning}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {step2State === "done" && step2Answer && (
                      <div className="relative rounded-lg border border-border/50 bg-card/30 shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset]">
                        <div className="px-5 py-4">
                          <Markdown text={step2Answer} />
                        </div>
                        <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-t border-border/30 bg-background/30 rounded-b-lg">
                          <div className="flex items-center gap-3">
                            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground/70">
                              {selectedProvider?.label ?? "—"}
                            </span>
                            {latency !== null && (
                              <span className="font-mono text-[10px] text-muted-foreground/60">
                                {latency}ms
                              </span>
                            )}
                            {step2Usage?.totalTokens && (
                              <span className="font-mono text-[10px] text-muted-foreground/60">
                                {step2Usage.totalTokens} tok
                              </span>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(step2Answer);
                              setCopied(true);
                              window.setTimeout(() => setCopied(false), 1500);
                            }}
                            className={cn(
                              "flex items-center gap-1.5 px-2 py-1 rounded font-mono text-[10px] font-bold tracking-[0.08em] uppercase border transition-all",
                              copied
                                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                                : "border-border/40 text-muted-foreground hover:text-foreground hover:border-cyan-500/40 hover:bg-cyan-500/5",
                            )}
                            title="Copy answer"
                          >
                            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                            {copied ? "Copied" : "Copy"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </ScrollArea>
          ) : (
            <div className="flex-1 flex items-center justify-center px-6 pb-48 overflow-y-auto">
              <div className="flex flex-col items-center text-center gap-5 max-w-2xl w-full">
                <div className="size-12 rounded-md border border-border/40 flex items-center justify-center bg-card/30">
                  <BrainCircuit className="size-6 text-muted-foreground" />
                </div>

                <div className="space-y-1.5">
                  <p className="text-[15px] text-foreground/90">Ask anything about football and betting.</p>
                  <p className="font-mono text-[10px] text-muted-foreground/60 uppercase tracking-[0.08em]">
                    {selectedProvider?.label ?? (llmLoading ? "Loading providers…" : "—")}
                    {useWebSearch ? " · web grounding on" : " · no web search"}
                  </p>
                </div>

                <div className="flex flex-wrap justify-center gap-1.5 mt-2">
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => setQuery(suggestion)}
                      className="px-2.5 py-1.5 rounded border border-border/40 bg-background/40 text-[12px] text-muted-foreground hover:text-foreground hover:border-cyan-500/40 hover:bg-cyan-500/5 transition-colors"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="absolute bottom-0 left-0 right-0 px-4 pb-4 pt-2 bg-gradient-to-t from-background via-background/95 to-background/0 pointer-events-none">
            <div className="w-full pointer-events-auto">
              <div className={cn("group rounded-md border bg-card/60 backdrop-blur-sm transition-all", "border-border/60 shadow-lg shadow-black/20", "focus-within:border-cyan-500/60 focus-within:bg-card/80", "focus-within:shadow-[0_0_0_3px_rgba(34,211,238,0.08),0_8px_24px_-8px_rgba(0,0,0,0.4)]")}>
                <Textarea
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleExecute(); } }}
                  placeholder="Ask anything… (Shift+Enter for newline)"
                  rows={4}
                  className={cn("w-full resize-none text-[14px] leading-relaxed", "px-4 pt-3.5 pb-2 min-h-[104px] max-h-[260px]", "border-0 bg-transparent dark:bg-transparent shadow-none rounded-md rounded-b-none", "focus-visible:ring-0 focus-visible:border-0 outline-none", "placeholder:text-muted-foreground/45")}
                />

                <div className="flex items-center justify-between px-3 py-2 border-t border-border/30">
                  <div className="flex items-center gap-1.5">
                    <button type="button" onClick={() => setUseWebSearch((v) => !v)} className={cn("px-2 h-6 rounded font-mono text-[9px] font-bold tracking-[0.08em] uppercase border flex items-center gap-1 transition-all", useWebSearch ? "bg-cyan-500/10 border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/15" : "bg-transparent border-border/40 text-muted-foreground/70 hover:text-foreground hover:border-border/60")} title="Toggle web grounding">
                      <Globe className="size-3" />
                      Web {useWebSearch ? "On" : "Off"}
                    </button>
                    <span className="px-2 h-6 rounded font-mono text-[9px] font-bold tracking-[0.08em] uppercase border bg-transparent border-border/40 text-muted-foreground/80 flex items-center gap-1" title="Active provider">
                      {llmLoading && !selectedProvider ? (
                        <>
                          <Spinner className="size-2.5" />
                          Loading
                        </>
                      ) : (
                        <>
                          <span className={cn("size-1.5 rounded-full", selectedProvider?.enabled ? "bg-cyan-400" : "bg-muted")} />
                          {selectedProvider?.label ?? "—"}
                        </>
                      )}
                    </span>
                  </div>
                  <Button type="button" onClick={handleExecute} disabled={!query.trim() || isExecuting || providerDisabled || llmLoading || !selectedProvider} size="sm" className={cn("h-7 px-3.5 rounded font-mono text-[10px] font-bold tracking-[0.08em] uppercase", "bg-cyan-500 hover:bg-cyan-400 text-black", "shadow-[0_0_0_1px_rgba(34,211,238,0.4),0_4px_12px_-2px_rgba(34,211,238,0.3)]", "disabled:opacity-50 disabled:shadow-none disabled:bg-muted disabled:text-muted-foreground", "transition-all")}>
                    {isExecuting ? <Spinner className="size-3 mr-1.5" /> : null}
                    Run
                    {!isExecuting && <ArrowRight className="size-3 ml-1.5" />}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Configuration panel */}
        <aside className="w-80 border-l border-border/40 bg-card/20 flex flex-col overflow-y-auto shrink-0">
          <div className="p-4 space-y-5">
            {/* Step 1: LLM Provider */}
            <section className="space-y-2">
              <h3 className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground">LLM Provider</h3>
              {llmLoading && llmProviders.length === 0 ? (
                <div className="space-y-3">
                  {LLM_FAMILY_ORDER.map((family) => (
                    <div key={family} className="space-y-1">
                      <Skeleton className="h-3 w-16 rounded-sm" />
                      <div className="flex gap-1">
                        <Skeleton className="h-7 flex-1 rounded" />
                        <Skeleton className="h-7 flex-1 rounded" />
                        <Skeleton className="h-7 flex-1 rounded" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-3">
                  {LLM_FAMILY_ORDER.map((family) => {
                    const familyProviders = llmProviders.filter((p) => getFamily(p) === family && getTier(p) !== null);
                    if (familyProviders.length === 0) return null;
                    const tiers = LLM_TIER_ORDER.filter((tier) =>
                      familyProviders.some((p) => getTier(p) === tier),
                    );
                    return (
                      <div key={family} className="space-y-1">
                        <span className="font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-cyan-400/60">{FAMILY_LABELS[family]}</span>
                        <div className="flex gap-1">
                          {tiers.map((tier) => {
                            const provider = familyProviders.find((p) => getTier(p) === tier);
                            if (!provider) return null;
                            return (
                              <button
                                key={tier}
                                type="button"
                                onClick={() => setSelectedProvider(provider)}
                                disabled={!provider.enabled}
                                className={cn(
                                  "flex-1 py-1.5 rounded font-mono text-[10px] font-bold tracking-[0.06em] uppercase border transition-all",
                                  selectedProvider?.name === provider.name
                                    ? "bg-cyan-500/20 border-cyan-500/60 text-cyan-300"
                                    : "bg-transparent border-border/40 text-muted-foreground/70 hover:border-cyan-500/40 hover:text-foreground",
                                  !provider.enabled && "opacity-40 cursor-not-allowed line-through",
                                )}
                                title={provider.disabledReason ? `${TIER_LABELS[tier]} — ${provider.disabledReason}` : TIER_LABELS[tier]}
                              >
                                {TIER_LABELS[tier]}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <div className="h-px bg-border/40" />

            {/* Step 2: Grounding */}
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground">Web Grounding</h3>
                <Switch
                  checked={useWebSearch}
                  onCheckedChange={setUseWebSearch}
                  disabled={llmLoading && searchProviders.length === 0}
                  className="data-[state=checked]:bg-cyan-500"
                  aria-label="Toggle web grounding"
                />
              </div>

              {useWebSearch && (
                llmLoading && searchProviders.length === 0 ? (
                  <div className="space-y-1">
                    <Skeleton className="h-3 w-12 rounded-sm" />
                    <div className="space-y-1">
                      <Skeleton className="h-7 w-full rounded" />
                      <div className="flex gap-1">
                        <Skeleton className="h-7 flex-1 rounded" />
                        <Skeleton className="h-7 flex-1 rounded" />
                        <Skeleton className="h-7 flex-1 rounded" />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <span className="font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-cyan-400/60">Source</span>
                    <div className="space-y-1">
                      <button
                        type="button"
                        onClick={() => setSearchProvider("auto")}
                        className={cn(
                          "w-full py-1.5 rounded font-mono text-[10px] font-bold tracking-[0.06em] uppercase border transition-all",
                          searchProvider === "auto"
                            ? "bg-cyan-500/20 border-cyan-500/60 text-cyan-300"
                            : "bg-transparent border-border/40 text-muted-foreground/70 hover:border-cyan-500/40 hover:text-foreground",
                        )}
                        title="Routes to the first healthy provider; falls back on failure"
                      >
                        Auto
                      </button>
                      <div className="flex gap-1">
                        {searchProviders.map((sp) => {
                          const disabled = !sp.enabled || sp.isExhausted;
                          const reason = sp.isExhausted
                            ? "Quota exhausted this month"
                            : sp.disabledReason;
                          return (
                            <button
                              key={sp.name}
                              type="button"
                              onClick={() => setSearchProvider(sp.name)}
                              disabled={disabled}
                              className={cn(
                                "flex-1 py-1.5 rounded font-mono text-[10px] font-bold tracking-[0.06em] uppercase border transition-all",
                                searchProvider === sp.name
                                  ? "bg-cyan-500/20 border-cyan-500/60 text-cyan-300"
                                  : "bg-transparent border-border/40 text-muted-foreground/70 hover:border-cyan-500/40 hover:text-foreground",
                                disabled && "opacity-40 cursor-not-allowed line-through",
                              )}
                              title={reason ? `${sp.label} — ${reason}` : sp.label}
                            >
                              {sp.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    {(() => {
                      if (searchProvider === "auto") {
                        return (
                          <p className="font-mono text-[9px] text-muted-foreground/60 leading-snug pt-0.5">
                            Routes to Vertex first (curated 50-site football corpus), then Brave → Tavily on failure.
                          </p>
                        );
                      }
                      const sp = searchProviders.find((p) => p.name === searchProvider);
                      if (!sp) return null;
                      return (
                        <p className="font-mono text-[9px] text-muted-foreground/60 leading-snug pt-0.5">
                          {sp.tagline ?? sp.label}
                          {sp.hasMonthlyLimit && sp.monthlyRemaining !== null && sp.monthlyLimit !== null && (
                            <> · {sp.monthlyRemaining}/{sp.monthlyLimit} left this month</>
                          )}
                        </p>
                      );
                    })()}

                    {(searchProvider === "vertex" || searchProvider === "auto") && (
                      <div className="flex items-start gap-1.5 mt-1.5 px-2 py-1.5 rounded border border-amber-500/30 bg-amber-500/[0.04]">
                        <Info className="size-3 text-amber-400/90 shrink-0 mt-0.5" />
                        <p className="font-mono text-[9px] leading-snug text-amber-200/80">
                          Vertex is scoped to a curated set of ~50 football/sports websites — great signal for matches, lineups, fixtures and odds, but won&apos;t find off-topic info. Switch to Brave or Tavily for the open web.
                        </p>
                      </div>
                    )}
                  </div>
                )
              )}
            </section>

            <div className="h-px bg-border/40" />

            {/* Telemetry */}
            <section className="space-y-2">
              <h3 className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground">Telemetry</h3>
              <div className="space-y-1">
                <div className="flex items-center justify-between h-6">
                  <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">Status</span>
                  <div className="flex items-center gap-1.5">
                    <div className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    <span className="font-mono text-[11px] text-emerald-400">{isExecuting ? "EXECUTING" : "OPTIMAL"}</span>
                  </div>
                </div>
                <div className="flex items-center justify-between h-6">
                  <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">Last</span>
                  <span className="font-mono text-[11px] text-foreground">{latency !== null ? `${latency}ms` : "—"}</span>
                </div>
              </div>
            </section>
          </div>
        </aside>
      </div>
    </AppShell>
  );
}