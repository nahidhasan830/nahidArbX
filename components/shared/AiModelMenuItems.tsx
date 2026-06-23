"use client";

import { Zap, Workflow } from "lucide-react";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useAiProviders, type AIProvider } from "@/hooks/use-ai-providers";

export type AiModelMenuEngine = "deepseek" | "gemini";

export interface AiModelMenuCallbacks {
  onSelectDefault?: () => void;
  onSelectAi: (
    engine: AiModelMenuEngine,
    model: "lite" | "flash" | "pro",
    providerId: string,
  ) => void;
}

interface Props {
  callbacks: AiModelMenuCallbacks;
  showDefault?: boolean;
  defaultLabel?: string;
  defaultHint?: string;
}

export function AiModelMenuItems({
  callbacks,
  showDefault = false,
  defaultLabel = "Default pipeline",
  defaultHint = "Full waterfall: Cache → Live → ESPN → SofaScore → API-Football → AI",
}: Props) {
  const { providers } = useAiProviders();

  const searchEnabled = providers.some(
    (p) => p.engineType === "search" && p.enabled,
  );

  const llmProviders = providers.filter((p) => p.engineType === "llm");
  const deepseekProviders = llmProviders.filter((p) =>
    p.name.startsWith("deepseek"),
  );
  const geminiProviders = llmProviders.filter((p) =>
    p.name.startsWith("gemini"),
  );

  const menuItem = (provider: AIProvider, onSelect: () => void) => {
    const isDisabled = !provider.enabled;

    return (
      <DropdownMenuItem
        key={provider.id}
        onSelect={isDisabled ? undefined : onSelect}
        disabled={isDisabled}
        className={cn(
          "cursor-pointer gap-2.5 rounded-md px-2 py-2",
          isDisabled && "opacity-40 cursor-not-allowed",
        )}
        aria-label={
          isDisabled
            ? `${provider.label} is disabled`
            : (provider.tagline ?? provider.name)
        }
      >
        <Zap
          className={cn(
            "size-3.5 shrink-0",
            isDisabled ? "text-muted-foreground/40" : "text-cyan-400",
          )}
        />
        <span className="text-[12px] font-medium">
          {provider.label}
          {isDisabled && provider.disabledReason && (
            <span className="text-muted-foreground/60"> (disabled)</span>
          )}
          {!isDisabled && provider.hasWebSearch && searchEnabled && (
            <Badge
              variant="outline"
              className="ml-1.5 h-4 text-[9px] px-1 rounded-sm bg-cyan-500/10 text-cyan-400 border-cyan-500/20"
            >
              search
            </Badge>
          )}
        </span>
      </DropdownMenuItem>
    );
  };

  return (
    <>
      {showDefault && (
        <>
          <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground/70 px-2 py-1">
            Pipeline
          </DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={callbacks.onSelectDefault}
            className="cursor-pointer gap-2.5 rounded-md px-2 py-2"
            aria-label={defaultHint}
          >
            <Workflow className="size-3.5 shrink-0 text-emerald-400" />
            <span className="text-[12px] font-medium">{defaultLabel}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator className="my-1" />
        </>
      )}

      {deepseekProviders.length > 0 && (
        <>
          <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground/70 px-2 py-1">
            DeepSeek
          </DropdownMenuLabel>
          {deepseekProviders.map((provider) =>
            menuItem(provider, () =>
              callbacks.onSelectAi(
                provider.name.startsWith("deepseek") ? "deepseek" : "gemini",
                (provider.tier as "lite" | "flash" | "pro") ?? "flash",
                provider.id,
              ),
            ),
          )}
        </>
      )}

      {geminiProviders.length > 0 && (
        <>
          <DropdownMenuSeparator className="my-1" />
          <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground/70 px-2 py-1">
            Gemini
          </DropdownMenuLabel>
          {geminiProviders.map((provider) =>
            menuItem(provider, () =>
              callbacks.onSelectAi(
                provider.name.startsWith("deepseek") ? "deepseek" : "gemini",
                (provider.tier as "lite" | "flash" | "pro") ?? "flash",
                provider.id,
              ),
            ),
          )}
        </>
      )}
    </>
  );
}
