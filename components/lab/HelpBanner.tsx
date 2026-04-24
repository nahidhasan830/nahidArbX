"use client";

/**
 * Collapsible per-tab "How to use this" banner. Expanded by default the first
 * time a user visits; preference saved in localStorage as `lab.help.<id>`.
 */

import * as React from "react";
import { ChevronDown, Lightbulb } from "lucide-react";

export interface HelpBannerProps {
  id: string;
  title: string;
  children: React.ReactNode;
}

export function HelpBanner({ id, title, children }: HelpBannerProps) {
  const storageKey = `lab.help.${id}`;
  const [open, setOpen] = React.useState(true);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(storageKey);
    if (saved === "0") setOpen(false);
  }, [storageKey]);

  const toggle = () => {
    setOpen((v) => {
      const next = !v;
      if (typeof window !== "undefined") {
        window.localStorage.setItem(storageKey, next ? "1" : "0");
      }
      return next;
    });
  };

  return (
    <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 text-left text-foreground/80 hover:text-foreground"
      >
        <Lightbulb className="size-3.5 text-amber-500" />
        <span className="font-medium">{title}</span>
        <ChevronDown
          className={`ml-auto size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {children}
        </div>
      )}
    </div>
  );
}
