
import type { PipelineData } from "@/components/lab/ml/types";

export type RungStatus = "pass" | "warn" | "fail" | "pending" | "blocked";

export type RungCategory = "data" | "training" | "inference" | "quality";

export interface RungVerdict {
  status: RungStatus;
  primary: string;
  secondary?: string;
  action?: string;
}

export interface RungEvidence {
  why: string;
}

export interface RungInput {
  label: string;
  value: string;
}

export interface RungAction {
  id: string;
  label: string;
  description: string;
  intent?: "default" | "destructive";
  confirm?: { title: string; body: string; confirmText?: string };
  method?: "POST";
  endpoint: string;
  body?: (data: PipelineData) => Record<string, unknown>;
  visibleWhen?: (data: PipelineData) => boolean;
}

export interface RungDefinition {
  id: string;
  number: number;
  category: RungCategory;
  title: string;
  evaluate: (data: PipelineData) => RungVerdict;
  inputs?: (data: PipelineData) => RungInput[];
  evidence: RungEvidence;
  actions?: RungAction[];
  prereqs?: string[];
}
