"use client";

import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";

export interface VirtualListProps<T> {
  items: T[];
  getItemKey: (item: T, index: number) => string | number;
  estimateSize: number;
  renderItem: (item: T, index: number) => React.ReactNode;
  overscan?: number;
  measureDynamic?: boolean;
  emptyState?: React.ReactNode;
  className?: string;
  rowClassName?: string;
}

export function VirtualList<T>({
  items,
  getItemKey,
  estimateSize,
  renderItem,
  overscan = 10,
  measureDynamic = true,
  emptyState,
  className,
  rowClassName,
}: VirtualListProps<T>) {
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan,
  });

  const virtualItems = virtualizer.getVirtualItems();

  if (items.length === 0 && emptyState) {
    return (
      <div className={cn("flex-1 overflow-auto", className)}>{emptyState}</div>
    );
  }

  return (
    <div ref={scrollRef} className={cn("flex-1 overflow-auto", className)}>
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: "relative",
        }}
      >
        {virtualItems.map((virtualRow) => {
          const item = items[virtualRow.index];
          return (
            <div
              key={getItemKey(item, virtualRow.index)}
              ref={measureDynamic ? virtualizer.measureElement : undefined}
              data-index={virtualRow.index}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                ...(measureDynamic
                  ? { transform: `translateY(${virtualRow.start}px)` }
                  : {
                      height: virtualRow.size,
                      transform: `translateY(${virtualRow.start}px)`,
                    }),
              }}
              className={rowClassName}
            >
              {renderItem(item, virtualRow.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
