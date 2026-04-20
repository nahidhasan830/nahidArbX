import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../client";
import { strategies, type StrategyRow } from "../schema";
import type { ListFilters } from "@/lib/backtest/api-client";

export type NewStrategyInput = {
  id?: string;
  name: string;
  description?: string | null;
  filters: ListFilters;
  stakeMultiplier?: number;
  origin?: "manual" | "ai";
  rationale?: string | null;
  status?: "candidate" | "live" | "paused" | "retired";
  metricsSnapshot?: Record<string, unknown> | null;
};

export const listStrategies = async (
  opts: { status?: StrategyRow["status"]; origin?: StrategyRow["origin"] } = {},
): Promise<StrategyRow[]> => {
  const clauses = [];
  if (opts.status) clauses.push(eq(strategies.status, opts.status));
  if (opts.origin) clauses.push(eq(strategies.origin, opts.origin));
  const where = clauses.length ? and(...clauses) : undefined;
  return db
    .select()
    .from(strategies)
    .where(where)
    .orderBy(desc(strategies.updatedAt));
};

export const getStrategyById = async (
  id: string,
): Promise<StrategyRow | null> => {
  const rows = await db
    .select()
    .from(strategies)
    .where(eq(strategies.id, id))
    .limit(1);
  return rows[0] ?? null;
};

export const insertStrategy = async (
  input: NewStrategyInput,
): Promise<StrategyRow> => {
  const id = input.id ?? crypto.randomUUID();
  const [row] = await db
    .insert(strategies)
    .values({
      id,
      name: input.name,
      description: input.description ?? null,
      filters: input.filters,
      stakeMultiplier: input.stakeMultiplier ?? 1,
      origin: input.origin ?? "manual",
      rationale: input.rationale ?? null,
      status: input.status ?? "candidate",
      metricsSnapshot: input.metricsSnapshot ?? null,
    })
    .returning();
  return row;
};

export const updateStrategy = async (
  id: string,
  patch: Partial<NewStrategyInput>,
): Promise<StrategyRow | null> => {
  const [row] = await db
    .update(strategies)
    .set({
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.description !== undefined && {
        description: patch.description,
      }),
      ...(patch.filters !== undefined && { filters: patch.filters }),
      ...(patch.stakeMultiplier !== undefined && {
        stakeMultiplier: patch.stakeMultiplier,
      }),
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.rationale !== undefined && { rationale: patch.rationale }),
      ...(patch.metricsSnapshot !== undefined && {
        metricsSnapshot: patch.metricsSnapshot,
      }),
      updatedAt: sql`now()`,
    })
    .where(eq(strategies.id, id))
    .returning();
  return row ?? null;
};

export const deleteStrategy = async (id: string): Promise<boolean> => {
  const result = await db
    .delete(strategies)
    .where(eq(strategies.id, id))
    .returning({ id: strategies.id });
  return result.length > 0;
};
