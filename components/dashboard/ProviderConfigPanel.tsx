"use client";

import { useState } from "react";
import { BellRing, Loader2, Power, Settings2, Shield } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  PROVIDER_IDS,
  PROVIDER_REGISTRY,
  getProviderColorClasses,
  isSharpProvider,
} from "@/lib/providers/registry";
import { useProviderRuntimeState } from "@/components/hooks/useProviderRuntimeState";
import { cn } from "@/lib/utils";

/**
 * Icon-trigger popover wrapping the provider on/off grid. Mirrors
 * `BettingStrategyPopover` so the dashboard header can expose both
 * settings surfaces the same way.
 */
export function ProviderConfigPopover() {
  const [open, setOpen] = useState(false);
  return (
    <TooltipProvider delayDuration={150}>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                aria-label="Provider configuration"
              >
                <Settings2 className="size-3.5" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Provider configuration</TooltipContent>
        </Tooltip>
        <PopoverContent
          align="end"
          sideOffset={8}
          className="w-[420px] max-h-[80vh] overflow-y-auto p-3"
        >
          <ProviderConfigForm />
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}

/**
 * Pure form body — no card wrapper. Used inside the popover; safe to
 * embed elsewhere (settings page, etc.) without modification.
 */
export function ProviderConfigForm() {
  const providerRuntime = useProviderRuntimeState();

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-3">
        <div className="rounded-md border border-border/60 bg-card px-3 py-2">
          <div className="flex items-center gap-3">
            <BellRing className="size-3.5 text-muted-foreground shrink-0" />
            <div className="min-w-0 flex-1">
              <label
                htmlFor="provider-health-telegram"
                className="block text-xs font-medium"
              >
                Telegram provider alerts
              </label>
              <p className="text-[11px] text-muted-foreground">
                Provider down and recovered messages.
              </p>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Switch
                  id="provider-health-telegram"
                  checked={providerRuntime.providerHealthTelegramEnabled}
                  disabled={
                    providerRuntime.isLoading ||
                    providerRuntime.isProviderHealthTelegramUpdating
                  }
                  onCheckedChange={(enabled) => {
                    void providerRuntime.toggleProviderHealthTelegram(enabled);
                  }}
                  aria-label="Toggle Telegram provider health alerts"
                />
              </TooltipTrigger>
              <TooltipContent side="left">
                Toggle Telegram messages when a provider goes down or recovers
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className="flex items-center gap-2 text-sm font-medium">
          <Power className="size-3.5" />
          Providers
        </div>
        <p className="text-[11px] text-muted-foreground">
          Disable to stop all fetches, odds, and matching for a provider.
        </p>
        {providerRuntime.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Loader2 className="size-3 animate-spin" /> Loading providers…
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2">
            {PROVIDER_IDS.map((id) => {
              const meta = PROVIDER_REGISTRY[id];
              const sharp = isSharpProvider(id);
              const enabled = providerRuntime.isEnabled(id);
              return (
                <label
                  key={id}
                  className={cn(
                    "flex items-center gap-3 rounded-md border border-border/60 px-3 py-2 transition-colors cursor-pointer",
                    enabled ? "bg-card hover:bg-muted/40" : "bg-muted/20",
                    sharp && "cursor-not-allowed",
                  )}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Checkbox
                        checked={enabled}
                        disabled={sharp}
                        onCheckedChange={(v) => {
                          if (sharp) return;
                          providerRuntime.toggle(id, v === true);
                        }}
                        aria-label={`Toggle ${meta.displayName}`}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      {sharp
                        ? "Sharp benchmark required for EV calculation"
                        : enabled
                          ? `Disable ${meta.displayName}`
                          : `Enable ${meta.displayName}`}
                    </TooltipContent>
                  </Tooltip>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium shrink-0",
                      getProviderColorClasses(id),
                    )}
                  >
                    {meta.shortName}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div
                      className={cn(
                        "text-xs font-medium truncate",
                        !enabled && "text-muted-foreground",
                      )}
                    >
                      {meta.displayName}
                    </div>
                    <div className="text-[10px] text-muted-foreground flex items-center gap-1.5">
                      <span className="capitalize">{meta.source}</span>
                      <span>·</span>
                      <span className="capitalize">{meta.bookmakerType}</span>
                      {meta.commissionPct > 0 && (
                        <>
                          <span>·</span>
                          <span>{meta.commissionPct}% comm</span>
                        </>
                      )}
                    </div>
                  </div>
                  {sharp ? (
                    <Badge
                      variant="secondary"
                      className="text-[9px] gap-0.5 shrink-0"
                    >
                      <Shield className="size-2.5" />
                      required
                    </Badge>
                  ) : !enabled ? (
                    <Badge
                      variant="outline"
                      className="text-[9px] shrink-0 text-muted-foreground"
                    >
                      disabled
                    </Badge>
                  ) : null}
                </label>
              );
            })}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
