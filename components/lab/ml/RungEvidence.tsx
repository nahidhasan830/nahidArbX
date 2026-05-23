"use client";

import { useState } from "react";
import { Check, ChevronDown, Code2, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  formatRungInputLabel,
  formatRungInputValue,
} from "@/lib/lab/ml/display";
import type { PipelineData } from "./types";
import type { RungDefinition } from "@/lib/lab/ml/rungs";
import { RungActions } from "./RungActions";

interface Props {
  definition: RungDefinition;
  data: PipelineData;
}

/**
 * Operator-facing detail body for a rung. Shows, in order:
 *
 *   1. **Why this matters** — plain English. Always visible.
 *   2. **Live values** — labelled inputs the evaluator saw.
 *   3. **Actions** — inline buttons (Retrain / Reconcile / Roll back).
 *   4. **Developer details** — collapsed by default. Reveals the
 *      code-level assertion, source pointer, and reproducer SQL for
 *      engineers who want to audit the evaluator. Operators don't see
 *      it unless they explicitly open it.
 */
export function RungEvidence({ definition, data }: Props) {
  const inputs = definition.inputs?.(data) ?? [];
  const { assertion, sourceFile, why, sql } = definition.evidence;

  const visibleActions = (definition.actions ?? []).filter(
    (a) => a.visibleWhen?.(data) ?? true,
  );
  const hasActions = visibleActions.length > 0;

  return (
    <div className="border-t border-border/40 bg-muted/15 px-4 py-4 grid gap-4">
      <Section label="Why this matters">
        <p className="text-sm leading-relaxed text-foreground/90">{why}</p>
      </Section>

      {inputs.length > 0 && (
        <Section label="Live values">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {inputs.map((input) => (
              <div
                key={input.label}
                className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-background/80 px-3 py-1.5"
              >
                <span className="text-[12px] text-muted-foreground truncate">
                  {formatRungInputLabel(input.label)}
                </span>
                <span className="font-mono text-[12px] tabular-nums text-foreground text-right truncate">
                  {formatRungInputValue(input.label, input.value)}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {hasActions && (
        <Section label="Actions">
          <RungActions definition={definition} data={data} />
        </Section>
      )}

      <DeveloperDetails
        assertion={assertion}
        sourceFile={sourceFile}
        sql={sql}
      />
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </h4>
      {children}
    </section>
  );
}

/**
 * Source-file pointers, raw SQL, and code assertions are hidden behind
 * this disclosure. They're useful for engineers auditing a verdict, but
 * an operator just trying to read the dashboard never needs to see
 * them.
 */
function DeveloperDetails({
  assertion,
  sourceFile,
  sql,
}: {
  assertion: string;
  sourceFile: string;
  sql?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <section className="rounded-md border border-border/50 bg-background/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
          <Code2 className="size-3.5" />
          Developer details
          <span className="text-[10px] font-normal text-muted-foreground/70">
            (assertion, source, SQL)
          </span>
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            "size-4 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="border-t border-border/40 px-3 py-3 space-y-3">
          <DevField label="Assertion">
            <code className="block rounded-md bg-background/80 px-2 py-1.5 font-mono text-[12px] text-foreground/90 break-words">
              {assertion}
            </code>
          </DevField>
          <DevField label="Source">
            <code className="block break-all font-mono text-[12px] text-foreground/85">
              {sourceFile}
            </code>
          </DevField>
          {sql && (
            <DevField label="Reproducer SQL">
              <SqlBlock sql={sql} />
            </DevField>
          )}
        </div>
      )}
    </section>
  );
}

function DevField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1">
      <span className="text-[10px] font-mono uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </span>
      <div>{children}</div>
    </div>
  );
}

function SqlBlock({ sql }: { sql: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard
      .writeText(sql)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* clipboard not allowed; user can still select/copy */
      });
  };

  return (
    <div className="relative rounded-md border border-border/50 bg-background/80 font-mono text-[12px]">
      <pre className="overflow-x-auto whitespace-pre p-3 leading-relaxed text-foreground/90">
        {sql}
      </pre>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={handleCopy}
            className={cn(
              "absolute right-1.5 top-1.5 size-7 rounded-md text-muted-foreground hover:text-foreground",
              copied && "text-emerald-400 hover:text-emerald-400",
            )}
            aria-label={copied ? "Copied" : "Copy SQL"}
          >
            {copied ? (
              <Check className="size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent className="text-sm">
          {copied ? "Copied" : "Copy SQL"}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
