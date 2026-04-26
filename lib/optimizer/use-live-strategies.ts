"use client";

import { useQuery } from "@tanstack/react-query";
import type { OptimizationStrategyRow } from "@/lib/db/schema";

async function fetchStrategies(): Promise<OptimizationStrategyRow[]> {
  const res = await fetch("/api/optimizer/strategies", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const list: OptimizationStrategyRow[] = data.strategies ?? [];
  return list.filter((s) => s.retiredAt == null);
}

export function useApplicableStrategies() {
  return useQuery({
    queryKey: ["optimizer", "strategies", "applicable"],
    queryFn: fetchStrategies,
    staleTime: 30_000,
  });
}
