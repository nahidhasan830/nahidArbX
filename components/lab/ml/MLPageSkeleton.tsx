"use client";

import { Skeleton } from "@/components/ui/skeleton";

export function MLPageSkeleton() {
  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-background">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-[1760px] gap-3 px-3 py-3 lg:px-5 2xl:px-6">
          <section className="overflow-hidden rounded-md border border-border bg-card shadow-sm">
            <div className="grid lg:grid-cols-[minmax(280px,0.9fr)_minmax(460px,1.4fr)_minmax(300px,0.9fr)]">
              <div className="flex items-start gap-3 border-b border-border p-3 lg:border-b-0 lg:border-r">
                <Skeleton className="size-10 rounded-md" />
                <div className="flex-1 space-y-2">
                  <div className="flex gap-2">
                    <Skeleton className="h-5 w-28 rounded-md" />
                    <Skeleton className="h-5 w-16 rounded-md" />
                  </div>
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-4/5" />
                </div>
              </div>
              <div className="grid border-b border-border sm:grid-cols-4 lg:border-b-0 lg:border-r">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div
                    key={index}
                    className="space-y-2 border-b border-border p-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0"
                  >
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="h-6 w-16" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                ))}
              </div>
              <div className="p-3">
                <div className="flex items-center justify-between gap-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-5 w-16 rounded-md" />
                </div>
                <Skeleton className="mt-3 h-4 w-full" />
                <div className="mt-3 grid grid-cols-4 gap-1">
                  {Array.from({ length: 8 }).map((_, index) => (
                    <Skeleton key={index} className="h-2 rounded-sm" />
                  ))}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Skeleton className="h-12 rounded-md" />
                  <Skeleton className="h-12 rounded-md" />
                </div>
              </div>
            </div>
            <div className="grid gap-3 border-t border-border bg-muted/20 p-3 lg:grid-cols-[minmax(0,1fr)_360px]">
              <div className="space-y-2">
                <Skeleton className="h-3 w-36" />
                <Skeleton className="h-4 w-80 max-w-full" />
                <Skeleton className="h-4 w-full" />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Skeleton className="h-14 rounded-md" />
                <Skeleton className="h-14 rounded-md" />
                <Skeleton className="h-14 rounded-md" />
              </div>
            </div>
          </section>

          <div className="-mx-3 border-y border-border bg-background/95 px-3 py-2 backdrop-blur lg:-mx-5 lg:px-5 2xl:-mx-6 2xl:px-6">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5 xl:w-[620px]">
              {Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-8 rounded-md" />
              ))}
            </div>
          </div>

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
