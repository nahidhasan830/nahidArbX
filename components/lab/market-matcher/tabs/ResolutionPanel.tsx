import { Button } from "@/components/ui/button";
import { BrainCircuit, Copy, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function ResolutionPanel({
  market,
}: {
  market: {
    provider: string;
    marketKey: string;
    marketName: string;
    samplePayload: unknown;
    prediction?: { targetAtom: string; probability: number };
  };
}) {
  const handleCopyPrompt = () => {
    const prompt = `I need to map an unmapped market from ${market.provider}.
Market Key: "${market.marketKey}"
Market Name: "${market.marketName}"

Here is the sample raw JSON payload from the provider API:
\`\`\`json
${JSON.stringify(market.samplePayload, null, 2)}
\`\`\`

${market.prediction ? `Note: The ML system predicts a ${(market.prediction.probability * 100).toFixed(0)}% probability that this belongs to the ${market.prediction.targetAtom} family.` : ""}

Please write the exact TypeScript switch/case logic to map this payload to our internal Atom schema inside the \`lib/atoms/mappings/${market.provider}.ts\` file.`;

    navigator.clipboard.writeText(prompt);
    toast.success("AI Prompt copied to clipboard");
  };

  return (
    <div className="rounded-lg border border-border bg-muted/20 overflow-hidden flex flex-col">
      <div className="flex items-center justify-between bg-muted/40 px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            {market.provider}
          </span>
          <span className="text-xs font-mono text-primary/80">
            {market.marketKey}
          </span>
        </div>
        
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[10px] gap-1 bg-background"
              onClick={handleCopyPrompt}
            >
              <Copy className="size-3" />
              Copy AI Prompt
            </Button>
          </TooltipTrigger>
          <TooltipContent>Copy auto-generated prompt for Cursor/Copilot</TooltipContent>
        </Tooltip>
      </div>

      <div className="p-3 space-y-3">
        <div className="text-sm">
          <span className="font-medium text-foreground">Human Brief: </span>
          <span className="text-muted-foreground text-[13px]">
            This is an unmapped market named <strong>&quot;{market.marketName}&quot;</strong>. 
            {market.prediction ? (
              <span className="inline-flex items-center gap-1 ml-1 text-blue-500">
                <BrainCircuit className="size-3" />
                LightGBM suggests mapping to <strong>{market.prediction.targetAtom}</strong>.
              </span>
            ) : (
              " Check the payload to determine its Atom family (e.g. Match Result, Asian Total)."
            )}
          </span>
        </div>

        <div className="bg-background rounded border border-border overflow-hidden">
          <div className="bg-muted/30 px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border flex items-center justify-between">
            <span>Raw JSON Payload</span>
            <ShieldAlert className="size-3 text-amber-500/70" />
          </div>
          <pre className="p-2 text-[11px] font-mono leading-relaxed overflow-x-auto max-h-[200px] overflow-y-auto">
            {JSON.stringify(market.samplePayload, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}
