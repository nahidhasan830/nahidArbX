"use client";

import { useState, useEffect } from "react";
import { AppShell } from "@/components/nav/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  ArrowRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { type ModelTier } from "@/lib/ai/models";
import { useAiProviders, useSearchProviders, type AIProvider } from "@/hooks/use-ai-providers";

/** Lightweight markdown placeholder — preserves whitespace and shrinks prose. */
function Markdown({ text }: { text: string }) {
  return (
    <div className="prose prose-invert prose-sm max-w-none prose-p:my-2 prose-p:leading-relaxed text-foreground/90 whitespace-pre-wrap text-[13px]">
      {text}
    </div>
  );
}

interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

export default function AIPlayground() {
  // ── Providers from DB ────────────────────────────────────────────
  const { providers: llmProviders, loading: llmLoading } = useAiProviders();
  const { providers: searchProviders } = useSearchProviders();

  // ── Composer + model state ────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [executedQuery, setExecutedQuery] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<AIProvider | null>(null);
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
  const [latency, setLatency] = useState<number | null>(null);

  // Auto-select first enabled provider
  useEffect(() => {
    if (!llmLoading && llmProviders.length > 0 && !selectedProvider) {
      const enabled = llmProviders.find((p) => p.enabled);
      if (enabled) setSelectedProvider(enabled);
    }
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

  return (
    <AppShell
      title="AI Playground"
      edgeToEdge
      titleBadge={
        <Badge variant="outline" className="ml-2 bg-cyan-500/10 text-cyan-400 border-cyan-500/20 text-[10px] rounded font-mono uppercase py-0.5 tracking-[0.08em]">
          <Terminal className="size-3 mr-1 inline-block" />
          {selectedProvider?.label ?? "Loading..."}
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
          <ScrollArea className="flex-1">
            <div className="px-6 py-5 pb-56 w-full space-y-6">
              {showTrace && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground">Execution Trace</span>
                    {latency !== null && (
                      <span className="font-mono text-[11px] text-emerald-400">{latency}ms{step2Usage?.totalTokens ? ` · ${step2Usage.totalTokens} tokens` : ""}</span>
                    )}
                  </div>
                  <div className="h-px bg-border/40 w-full" />
                </div>
              )}

              {!showTrace && (
                <div className="flex flex-col items-center justify-center text-center py-24 gap-3">
                  <div className="size-10 rounded border border-border/40 flex items-center justify-center bg-card/30">
                    <BrainCircuit className="size-5 text-muted-foreground" />
                  </div>
                  <p className="text-sm text-muted-foreground">Ask anything. Use the composer below.</p>
                  <p className="font-mono text-[10px] text-muted-foreground/60 uppercase tracking-[0.08em]">
                    {selectedProvider?.label ?? "—"} {useWebSearch ? "· web grounding on" : ""}
                  </p>
                </div>
              )}

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
                    <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-2">
                      {step1Results.map((r, i) => (
                        <a key={`${r.url}-${i}`} href={r.url} target="_blank" rel="noreferrer" className="block p-2.5 border border-border/40 bg-card/30 rounded hover:border-cyan-500/40 hover:bg-card/50 transition-colors">
                          <div className="flex justify-between items-start mb-1">
                            <span className="font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-emerald-400/80">SRC_{String(i + 1).padStart(2, "0")}</span>
                          </div>
                          <h4 className="text-[13px] font-medium text-foreground mb-1 truncate">{r.title}</h4>
                          <p className="text-[12px] text-muted-foreground line-clamp-2 leading-snug mb-1.5">{r.snippet}</p>
                          <code className="font-mono text-[10px] text-cyan-400/70 truncate block">{r.url}</code>
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {step2State !== "idle" && (
                <div className="space-y-2.5">
                  <div className="flex items-center gap-2">
                    {step2State === "running" ? <Spinner className="size-3.5 text-cyan-400" />
                      : step2State === "done" ? <CheckCircle2 className="size-4 text-emerald-400" />
                        : <X className="size-4 text-red-400" />}
                    <span className="text-[13px] font-semibold">AI Synthesis</span>
                  </div>

                  {step2Reasoning && (
                    <div className="ml-5 border-l border-border/40 pl-3">
                      <button type="button" onClick={() => setIsCotExpanded((v) => !v)} className="flex items-center gap-1.5 py-1 text-muted-foreground hover:text-foreground">
                        {isCotExpanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em]">Chain of Thought</span>
                      </button>
                      {isCotExpanded && (
                        <div className="mt-2 p-2.5 bg-background/50 border border-border/30 rounded font-mono text-[11px] text-muted-foreground/80 leading-relaxed max-h-[240px] overflow-y-auto whitespace-pre-wrap">{step2Reasoning}</div>
                      )}
                    </div>
                  )}

                  {step2State === "done" && step2Answer && (
                    <div className="relative group">
                      <div className="p-4 border border-border/40 bg-card/30 rounded"><Markdown text={step2Answer} /></div>
                      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button type="button" onClick={() => navigator.clipboard.writeText(step2Answer)} className="p-1 hover:bg-muted/50 rounded border border-border/40 text-muted-foreground hover:text-foreground" title="Copy">
                          <Copy className="size-3" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </ScrollArea>

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

                {query.trim().length === 0 && !isExecuting && (
                  <div className="flex flex-wrap gap-1.5 px-3 pt-2">
                    {(useWebSearch ? ["Today football matches", "Premier League standings", "Champions League fixtures", "La Liga results", "Transfer news today"] : ["Brainstorm value betting strategies", "Explain expected value in betting", "How to manage bankroll for sports betting", "Compare Kelly criterion vs flat staking", "Analyze risk-reward in corner markets"]).map((suggestion) => (
                      <button key={suggestion} type="button" onClick={() => setQuery(suggestion)} className="px-2 py-1 rounded border border-border/40 bg-background/50 text-[11px] text-muted-foreground hover:text-foreground hover:border-cyan-500/40 hover:bg-cyan-500/5 transition-colors">
                        {suggestion}
                      </button>
                    ))}
                  </div>
                )}

                <div className="flex items-center justify-between px-3 py-2 border-t border-border/30">
                  <div className="flex items-center gap-1.5">
                    <button type="button" onClick={() => setUseWebSearch((v) => !v)} className={cn("px-2 h-6 rounded font-mono text-[9px] font-bold tracking-[0.08em] uppercase border flex items-center gap-1 transition-all", useWebSearch ? "bg-cyan-500/10 border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/15" : "bg-transparent border-border/40 text-muted-foreground/70 hover:text-foreground hover:border-border/60")} title="Toggle web grounding">
                      <Globe className="size-3" />
                      Web {useWebSearch ? "On" : "Off"}
                    </button>
                    <span className="px-2 h-6 rounded font-mono text-[9px] font-bold tracking-[0.08em] uppercase border bg-transparent border-border/40 text-muted-foreground/80 flex items-center gap-1" title="Active provider">
                      <span className={cn("size-1.5 rounded-full", selectedProvider?.enabled ? "bg-cyan-400" : "bg-muted")} />
                      {selectedProvider?.label ?? "—"}
                    </span>
                  </div>
                  <Button type="button" onClick={handleExecute} disabled={!query.trim() || isExecuting || providerDisabled} size="sm" className={cn("h-7 px-3.5 rounded font-mono text-[10px] font-bold tracking-[0.08em] uppercase", "bg-cyan-500 hover:bg-cyan-400 text-black", "shadow-[0_0_0_1px_rgba(34,211,238,0.4),0_4px_12px_-2px_rgba(34,211,238,0.3)]", "disabled:opacity-50 disabled:shadow-none disabled:bg-muted disabled:text-muted-foreground", "transition-all")}>
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
            {/* Provider */}
            <section className="space-y-2">
              <h3 className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground">Provider</h3>
              <div className="space-y-1">
                {llmProviders.map((p) => (
                  <button key={p.id} type="button" onClick={() => setSelectedProvider(p)} disabled={!p.enabled} className={cn("w-full flex items-center justify-between px-2.5 py-1.5 rounded text-left transition-colors border-l-2", selectedProvider?.id === p.id ? "bg-card/60 border-cyan-400" : "border-transparent hover:bg-card/40", !p.enabled && "opacity-40 cursor-not-allowed")}>
                    <div className="min-w-0">
                      <div className={cn("font-mono text-[11px] font-bold uppercase tracking-[0.06em]", selectedProvider?.id === p.id ? "text-foreground" : "text-muted-foreground")}>{p.label}</div>
                      <div className="text-[11px] text-muted-foreground/70 truncate">{p.tagline}</div>
                    </div>
                  </button>
                ))}
              </div>
            </section>

            <div className="h-px bg-border/40" />

            {/* Grounding */}
            <section className="space-y-2">
              <h3 className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground">Grounding</h3>
              <div className="flex items-center justify-between h-8">
                <div className="flex items-center gap-2">
                  <Globe className="size-3.5 text-cyan-400" />
                  <span className="text-[13px]">Web grounding</span>
                </div>
                <Switch checked={useWebSearch} onCheckedChange={setUseWebSearch} className="data-[state=checked]:bg-cyan-500" />
              </div>
              {useWebSearch && (
                <Select value={searchProvider} onValueChange={setSearchProvider}>
                  <SelectTrigger className="h-8 rounded font-mono text-[11px] bg-background border-border/40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {searchProviders.map((sp) => (
                      <SelectItem key={sp.id} value={sp.id} className="font-mono text-[11px]">{sp.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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