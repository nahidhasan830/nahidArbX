/**
 * Pipeline ladder rung primitives.
 *
 * Each rung in the ML Optimizer pipeline is a single, auditable assertion
 * about the system. Rungs are data-driven: a `RungDefinition` declares the
 * assertion, a pure `evaluate(PipelineData)` function, an `evidence` record
 * that backs the "Show the math" drawer, an `inputs(data)` callback that
 * exposes the live values the evaluator sees, and an optional `actions`
 * array for inline mutations (Retrain Now, Roll back, Reconcile, etc.).
 */

import type { PipelineData } from "@/components/lab/ml/types";

export type RungStatus = "pass" | "warn" | "fail" | "pending" | "blocked";

export type RungCategory = "data" | "training" | "inference" | "quality";

export interface RungVerdict {
  status: RungStatus;
  /** Big number / short value rendered as the headline (mono, prominent). */
  primary: string;
  /** Plain-English context, one sentence max. */
  secondary?: string;
  /** Concrete next action. Required for fail/warn, ignored otherwise. */
  action?: string;
}

export interface RungEvidence {
  /** Code-level assertion the rung evaluates. */
  assertion: string;
  /** `path/to/file.ts:line` — deep link in Phase B. */
  sourceFile: string;
  /** Why a non-pass on this rung is operationally important. */
  why: string;
  /** Optional copy-pasteable SQL the user can run themselves. */
  sql?: string;
}

/** Labelled live value rendered in the evidence drawer. */
export interface RungInput {
  label: string;
  value: string;
}

/**
 * Inline action attached to a rung. Two kinds:
 *
 *   - `mutation`: hits a server endpoint with optional JSON body. The UI shows
 *     a button; if `confirm` is set the user must type-confirm before the
 *     request fires.
 *
 *   - `instruction`: shows a copyable text block (typically a shell command).
 *     Useful for actions the dashboard cannot perform from the browser
 *     (e.g. starting the engine on a specific machine).
 */
export type RungAction =
  | {
      id: string;
      kind: "mutation";
      label: string;
      description: string;
      intent?: "default" | "destructive";
      confirm?: { title: string; body: string; confirmText?: string };
      method?: "POST";
      endpoint: string;
      /** Optional JSON body builder. Receives PipelineData. */
      body?: (data: PipelineData) => Record<string, unknown>;
      /** Whether this action makes sense in the current pipeline state. */
      visibleWhen?: (data: PipelineData) => boolean;
    }
  | {
      id: string;
      kind: "instruction";
      label: string;
      description: string;
      command: string;
      visibleWhen?: (data: PipelineData) => boolean;
    };

export interface RungDefinition {
  id: string;
  number: number;
  category: RungCategory;
  /** Plain-English assertion shown to the operator. */
  title: string;
  evaluate: (data: PipelineData) => RungVerdict;
  /** Returns the labelled live values backing the verdict (evidence drawer). */
  inputs?: (data: PipelineData) => RungInput[];
  evidence: RungEvidence;
  /** Inline actions, rendered as buttons in the rung's drawer. */
  actions?: RungAction[];
  /**
   * Other rung ids whose pass-status is required for this rung to be
   * meaningfully evaluated. If any prereq is non-pass, the rung is reported
   * as `blocked` regardless of the evaluator output.
   */
  prereqs?: string[];
}
