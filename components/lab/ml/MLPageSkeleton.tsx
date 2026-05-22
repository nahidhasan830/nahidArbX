"use client";

import { Skeleton } from "@/components/ui/skeleton";

/**
 * First-load skeleton for the ML Optimizer page. The shape mirrors the
 * real layout: page header → hero state banner → KPI strip → tab list
 * → tab content (ladder + activity by default). Structural match means
 * no layout-shift jolt when the data arrives.
 */
export function MLPageSkeleton() {
  return (
    <div className="flex flex-1 flex-col bg-background overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="w-full px-4 py-6 space-y-5 xl:px-6 2xl:px-8">
          {/* Page header */}
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-2">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-3.5 w-72" />
            </div>
            <Skeleton className="h-7 w-28" />
          </div>

          {/* Hero state banner */}
          <div className="rounded-2xl border border-border/60 bg-card/60 p-5 lg:p-6">
            <div className="flex items-center gap-4">
              <Skeleton className="size-12 rounded-xl" />
              <div className="flex-1 space-y-2">
                <div className="flex gap-2">
                  <Skeleton className="h-4 w-20 rounded-full" />
                  <Skeleton className="h-4 w-28 rounded-full" />
                </div>
                <Skeleton className="h-4 w-3/4" />
              </div>
            </div>
          </div>

          {/* KPI strip — 4 cards */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="rounded-xl border border-border/60 bg-card/60 p-4 space-y-3"
              >
                <div className="flex items-center gap-2">
                  <Skeleton className="size-7 rounded-lg" />
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="ml-auto h-4 w-14 rounded-full" />
                </div>
                <div className="flex items-end justify-between">
                  <Skeleton className="h-7 w-20" />
                  <Skeleton className="h-5 w-16" />
                </div>
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-1.5 w-full" />
              </div>
            ))}
          </div>

          {/* Tab list */}
          <div className="flex gap-1 border-b border-border/40 pb-px">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-8 w-28 rounded-md" />
            ))}
          </div>

          {/* Tab content (default = pipeline + activity) */}
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_360px]">
            <div className="rounded-xl border border-border/60 bg-card/60">
              <div className="flex items-center justify-between px-5 py-4 border-b border-border/40">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-48" />
                </div>
                <Skeleton className="h-6 w-24 rounded-full" />
              </div>
              <div className="px-5 py-4 space-y-4">
                {Array.from({ length: 4 }).map((_, gi) => (
                  <div key={gi} className="space-y-3 pt-2 first:pt-0">
                    <div className="flex items-center justify-between">
                      <Skeleton className="h-4 w-20" />
                      <Skeleton className="h-5 w-12 rounded-full" />
                    </div>
                    {Array.from({ length: 3 }).map((__, ri) => (
                      <div
                        key={ri}
                        className="grid grid-cols-[auto_auto_auto_1fr_auto] items-center gap-3 py-2"
                      >
                        <Skeleton className="size-2 rounded-full" />
                        <Skeleton className="h-3 w-5" />
                        <Skeleton className="h-4 w-12 rounded" />
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-5 w-20" />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-border/60 bg-card/60">
              <div className="px-5 py-4 border-b border-border/40 space-y-2">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-3 w-3/4" />
              </div>
              <div className="px-5 py-4 space-y-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex items-baseline gap-3">
                    <Skeleton className="size-1.5 rounded-full mt-1" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3.5 w-3/4" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                    <Skeleton className="h-3 w-12" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
