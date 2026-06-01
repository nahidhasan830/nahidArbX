"use client";

import { SectionHeaderPlaceholder, TilePlaceholder } from "./MemoryPrimitives";

export function MemoryPageSkeleton() {
  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-background">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-[1760px] gap-3 px-3 py-3 lg:px-5 2xl:px-6">
          <section className="rounded-md border border-border bg-card p-3 shadow-sm">
            <SectionHeaderPlaceholder />
            <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              <TilePlaceholder height="h-24" />
              <TilePlaceholder height="h-24" />
              <TilePlaceholder height="h-24" />
              <TilePlaceholder height="h-24" />
            </div>
          </section>
          <section className="rounded-md border border-border bg-card p-3 shadow-sm">
            <SectionHeaderPlaceholder />
            <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              <TilePlaceholder height="h-20" />
              <TilePlaceholder height="h-20" />
              <TilePlaceholder height="h-20" />
              <TilePlaceholder height="h-20" />
            </div>
          </section>
          <section className="rounded-md border border-border bg-card p-3 shadow-sm">
            <SectionHeaderPlaceholder />
            <div className="mt-3 space-y-1.5">
              {Array.from({ length: 6 }).map((_, row) => (
                <div
                  key={row}
                  className="h-7 rounded-md border border-border bg-background"
                />
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
