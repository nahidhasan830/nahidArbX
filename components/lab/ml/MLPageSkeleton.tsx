"use client";

import { Skeleton } from "@/components/ui/skeleton";

export function MLPageSkeleton() {
  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-background">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-[1760px] gap-3 px-3 py-3 lg:px-5 2xl:px-6">
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
            <main className="grid gap-3">
              {Array.from({ length: 2 }).map((_, section) => (
                <section
                  key={section}
                  className="rounded-md border border-border bg-card p-3 shadow-sm"
                >
                  <div className="flex items-start gap-2.5">
                    <Skeleton className="size-8 rounded-md" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-40" />
                      <Skeleton className="h-4 w-80 max-w-full" />
                    </div>
                  </div>
                  <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                    {Array.from({ length: 4 }).map((__, index) => (
                      <Skeleton key={index} className="h-28 rounded-md" />
                    ))}
                  </div>
                </section>
              ))}
            </main>
            <aside className="grid gap-3">
              <Skeleton className="h-56 rounded-md" />
              <Skeleton className="h-48 rounded-md" />
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}
