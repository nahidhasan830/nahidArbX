"use client";

import React, { useState, ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Search, X, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

// ============================================
// Types
// ============================================

export interface Column<T> {
  id: string;
  header: string | ReactNode;
  width?: string; // e.g., "w-20", "flex-1", "w-[120px]"
  align?: "left" | "center" | "right";
  render: (item: T, expanded?: boolean, toggleExpand?: () => void) => ReactNode;
}

export interface DiagnosticsTableProps<T> {
  data: T[];
  columns: Column<T>[];
  keyExtractor: (item: T) => string;

  // Search
  searchable?: boolean;
  searchPlaceholder?: string;
  searchFilter?: (item: T, query: string) => boolean;

  // Empty state
  emptyIcon?: ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;

  // Expandable rows
  expandable?: boolean;
  renderExpanded?: (item: T) => ReactNode;

  // Selection
  selectable?: boolean;
  selectedIds?: Set<string>;
  onSelectionChange?: (ids: Set<string>) => void;

  // Actions in header
  headerActions?: ReactNode;

  // Row click
  onRowClick?: (item: T) => void;

  // Custom row class
  rowClassName?: (item: T) => string;

  // Loading
  isLoading?: boolean;
}

// ============================================
// Main Component
// ============================================

export function DiagnosticsTable<T>({
  data,
  columns,
  keyExtractor,
  searchable = false,
  searchPlaceholder = "Search...",
  searchFilter,
  emptyIcon,
  emptyTitle = "No data",
  emptyDescription,
  expandable = false,
  renderExpanded,
  selectable = false,
  selectedIds,
  onSelectionChange,
  headerActions,
  onRowClick,
  rowClassName,
  isLoading = false,
}: DiagnosticsTableProps<T>) {
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // Filter data based on search
  const filteredData =
    searchable && searchQuery && searchFilter
      ? data.filter((item) => searchFilter(item, searchQuery.toLowerCase()))
      : data;

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSelect = (id: string) => {
    if (!onSelectionChange || !selectedIds) return;
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onSelectionChange(next);
  };

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Search Bar */}
      {searchable && (
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800/30">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-8 pl-9 text-sm bg-zinc-800/50 border-zinc-700/50 focus:border-violet-500/50"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2"
              >
                <X className="w-4 h-4 text-zinc-500 hover:text-zinc-300" />
              </button>
            )}
          </div>
          {headerActions}
        </div>
      )}

      {/* Column Headers */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800/20 text-xs text-zinc-500 uppercase tracking-wider font-medium">
        {expandable && <span className="w-5" />}
        {selectable && <span className="w-5" />}
        {columns.map((col) => (
          <span
            key={col.id}
            className={cn(
              col.width || "flex-1",
              col.align === "center" && "text-center",
              col.align === "right" && "text-right",
            )}
          >
            {col.header}
          </span>
        ))}
      </div>

      {/* Data Rows */}
      <div className="flex-1 overflow-auto">
        {filteredData.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-zinc-500 p-8">
            {emptyIcon && <div className="mb-3">{emptyIcon}</div>}
            <p className="text-base">{emptyTitle}</p>
            {emptyDescription && (
              <p className="text-sm mt-1 text-zinc-600">{emptyDescription}</p>
            )}
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="text-sm text-violet-400 hover:text-violet-300 mt-2"
              >
                Clear search
              </button>
            )}
          </div>
        ) : (
          <div className="divide-y divide-zinc-800/20">
            {filteredData.map((item) => {
              const id = keyExtractor(item);
              const isExpanded = expandedIds.has(id);
              const isSelected = selectedIds?.has(id);

              return (
                <div key={id}>
                  {/* Main Row */}
                  <div
                    className={cn(
                      "flex items-center gap-3 px-4 py-2.5 hover:bg-zinc-800/30 transition-colors",
                      (onRowClick || expandable) && "cursor-pointer",
                      isSelected && "bg-violet-500/5",
                      rowClassName?.(item),
                    )}
                    onClick={() => {
                      if (expandable) {
                        toggleExpand(id);
                      } else if (selectable) {
                        toggleSelect(id);
                      } else if (onRowClick) {
                        onRowClick(item);
                      }
                    }}
                  >
                    {/* Expand Toggle */}
                    {expandable && (
                      <button
                        className="w-5 flex justify-center text-zinc-500 hover:text-zinc-300"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpand(id);
                        }}
                      >
                        {isExpanded ? (
                          <ChevronDown className="w-4 h-4" />
                        ) : (
                          <ChevronRight className="w-4 h-4" />
                        )}
                      </button>
                    )}

                    {/* Selection Checkbox */}
                    {selectable && (
                      <button
                        className={cn(
                          "w-4 h-4 rounded border flex items-center justify-center transition-colors",
                          isSelected
                            ? "bg-violet-600 border-violet-600"
                            : "border-zinc-600 hover:border-zinc-400",
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSelect(id);
                        }}
                      >
                        {isSelected && (
                          <svg
                            className="w-3 h-3 text-white"
                            viewBox="0 0 12 12"
                          >
                            <path
                              d="M10 3L4.5 8.5L2 6"
                              stroke="currentColor"
                              strokeWidth="2"
                              fill="none"
                            />
                          </svg>
                        )}
                      </button>
                    )}

                    {/* Columns */}
                    {columns.map((col) => (
                      <div
                        key={col.id}
                        className={cn(
                          col.width || "flex-1",
                          col.align === "center" && "text-center",
                          col.align === "right" && "text-right",
                          "min-w-0",
                        )}
                      >
                        {col.render(item, isExpanded, () => toggleExpand(id))}
                      </div>
                    ))}
                  </div>

                  {/* Expanded Content */}
                  {expandable && isExpanded && renderExpanded && (
                    <div className="px-4 py-3 bg-zinc-900/50 border-t border-zinc-800/30">
                      {renderExpanded(item)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================
// Helper Components for Cells
// ============================================

export function TableCellPrimary({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("text-sm text-zinc-300 truncate", className)}>
      {children}
    </span>
  );
}

export function TableCellSecondary({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("text-xs text-zinc-500 truncate", className)}>
      {children}
    </span>
  );
}

export function TableCellMono({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("text-sm text-zinc-300 font-mono truncate", className)}>
      {children}
    </span>
  );
}

export function TableCellBadge({
  children,
  variant = "default",
  className,
}: {
  children: ReactNode;
  variant?:
    | "default"
    | "success"
    | "warning"
    | "error"
    | "violet"
    | "auto"
    | "manual";
  className?: string;
}) {
  const variantClasses = {
    default: "bg-zinc-800 text-zinc-400",
    success: "bg-emerald-500/10 text-emerald-400",
    warning: "bg-amber-500/10 text-amber-400",
    error: "bg-red-500/10 text-red-400",
    violet: "bg-violet-500/10 text-violet-400",
    auto: "bg-zinc-800 text-zinc-400",
    manual: "bg-violet-500/10 text-violet-400",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium",
        variantClasses[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function TableCellCount({ children }: { children: ReactNode }) {
  return <span className="text-xs text-zinc-500 tabular-nums">{children}</span>;
}

export function TableCellExpandableText({
  text,
  maxLength = 60,
}: {
  text: string;
  maxLength?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const needsExpand = text && text.length > maxLength;

  return (
    <div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setExpanded(!expanded);
        }}
        className={cn(
          "text-xs text-zinc-500 text-left hover:text-zinc-400 transition-colors",
          !expanded && needsExpand && "line-clamp-1",
        )}
      >
        {text}
      </button>
      {!expanded && needsExpand && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(true);
          }}
          className="text-xs text-violet-400 hover:text-violet-300 mt-1 block"
        >
          Show more
        </button>
      )}
    </div>
  );
}

export default DiagnosticsTable;
