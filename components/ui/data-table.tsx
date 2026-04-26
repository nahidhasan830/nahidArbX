"use client";

/**
 * Reusable DataTable — TanStack Table v8 + TanStack Virtual + dnd-kit.
 *
 * One component for every table in the app. Feature flags are opt-in so a
 * trivial table stays trivial, while a heavy analytical table can turn on
 * sorting, column resizing, header drag-to-reorder, grouping, selection,
 * virtualization, and infinite scroll.
 *
 * Styling baseline is deliberately tight — 11px text, 30px rows, sticky
 * header, tooltip hints per column — to match the density we already have
 * in the bets-history / value-bets surfaces.
 *
 * Non-obvious behaviours:
 * - Sort cycles desc → asc → none (TanStack's default is asc → desc → none,
 *   but desc-first is what analysts expect here — biggest EV / newest / etc.
 *   at the top on first click). See `cycleSort` below.
 * - `meta.fixed` columns (e.g. checkbox, actions) are excluded from the
 *   sortable header set so they can't be dragged away from their pinned edge.
 * - Persistence writes a bundle (`sorting + columnSizing + columnOrder +
 *   columnVisibility + grouping`) to one localStorage key to avoid key sprawl.
 */

import * as React from "react";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type Cell,
  type ColumnDef,
  type ColumnOrderState,
  type ColumnSizingState,
  type GroupingState,
  type Header,
  type Row,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getGroupedRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ChevronRight, GripVertical, Loader2 } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useLocalStorage } from "@/components/hooks/useLocalStorage";
import { cn } from "@/lib/utils";

// ---------- public types ----------

export type DataTableColumnMeta = {
  /** Tooltip shown on header hover. Explain the column's meaning in plain English. */
  hint?: string;
  /** Cell alignment. `right` auto-adds `tabular-nums` for numeric columns. */
  align?: "left" | "right" | "center";
  /** Pinned to its edge — excluded from drag-reorder. Use for select/actions. */
  fixed?: "left" | "right";
  /** Initial pixel width when resizing is enabled. */
  initialSize?: number;
  /** Show this column in the grouping menu (default: true for non-fixed). */
  groupable?: boolean;
};

// TanStack's `ColumnMeta` augmentation slot — we inject our column-level
// options here so callers get typed `meta.hint`, `meta.align`, etc. on
// every column definition. The two generic params are required by
// TanStack's module shape even though we don't use them in the extension.
declare module "@tanstack/react-table" {
  interface ColumnMeta<TData extends RowData, TValue> // eslint-disable-line @typescript-eslint/no-unused-vars
    extends DataTableColumnMeta {
    /** @internal — placeholder so the interface isn't empty. */
    readonly __dataTableMeta?: never;
  }
}
import type { RowData } from "@tanstack/react-table";

type PersistedState = {
  sorting?: SortingState;
  columnSizing?: ColumnSizingState;
  columnOrder?: ColumnOrderState;
  columnVisibility?: VisibilityState;
  grouping?: GroupingState;
};

export type DataTableProps<T> = {
  data: T[];
  columns: ColumnDef<T, unknown>[];
  getRowId?: (row: T, index: number) => string;

  // Feature toggles — off by default, opt in per table.
  enableSorting?: boolean;
  enableMultiSort?: boolean;
  enableColumnResizing?: boolean;
  enableColumnOrdering?: boolean;
  enableGrouping?: boolean;
  enableRowSelection?: boolean;
  enableExpanding?: boolean;
  enableVirtualization?: boolean;
  rowHeight?: number;
  /**
   * Per-row height override. When provided, takes precedence over
   * `rowHeight` for rows where it returns a number — used to give long
   * rows extra vertical space (e.g. /telegram's `/optimise` usage line
   * that needs to wrap onto two lines without breaking the layout).
   * The virtualizer's `estimateSize` honours this so scroll math stays
   * correct.
   */
  getRowHeight?: (row: T) => number;

  // Controlled row-selection (TanStack state) — opt-in.
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: (next: RowSelectionState) => void;

  // Persist sorting/sizing/order/grouping/visibility to localStorage.
  persistenceKey?: string;

  // Infinite scroll. Fire onLoadMore when the last ~10 rows come into view.
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;

  // Row interaction.
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;

  // Slots.
  renderEmpty?: () => React.ReactNode;
  renderLoading?: () => React.ReactNode;
  /** Rendered as a tbody row below the data rows once loading is finished
   *  and there are no more pages. Use for end-of-list summaries. */
  renderFooter?: () => React.ReactNode;
  loading?: boolean;

  // Styling.
  className?: string;
  density?: "compact" | "comfortable";
};

// ---------- style primitives ----------

const densityClasses = {
  compact: {
    th: "text-left px-2 font-semibold text-[11px] text-muted-foreground whitespace-nowrap h-8",
    td: "px-2 text-[11px] whitespace-nowrap align-middle",
    rowHeight: 30,
  },
  comfortable: {
    th: "text-left px-3 font-semibold text-xs text-muted-foreground whitespace-nowrap h-10",
    td: "px-3 text-xs whitespace-nowrap align-middle",
    rowHeight: 40,
  },
} as const;

// ---------- header cell ----------

type HeaderCellProps<T> = {
  header: Header<T, unknown>;
  enableSorting: boolean;
  enableColumnOrdering: boolean;
  enableColumnResizing: boolean;
  /**
   * False during SSR + first client render (before DndContext mounts). When
   * false, skip spreading dnd-kit's sortable attributes/listeners/refs so the
   * `<th>` markup matches across SSR and client-pre-hydration and `useSortable`'s
   * internal `aria-describedby` counter doesn't leak into static HTML.
   */
  dndReady: boolean;
  thClassName: string;
  onSortClick: (header: Header<T, unknown>) => void;
};

function HeaderCellInner<T>({
  header,
  enableSorting,
  enableColumnOrdering,
  enableColumnResizing,
  dndReady,
  thClassName,
  onSortClick,
}: HeaderCellProps<T>) {
  const column = header.column;
  const meta = column.columnDef.meta;
  const fixed = meta?.fixed;
  const canSort =
    enableSorting && column.getCanSort() && !column.getIsGrouped();
  const canReorder = enableColumnOrdering && !fixed;
  const align = meta?.align ?? "left";

  const sortDir = column.getIsSorted(); // "asc" | "desc" | false
  const sortIndicator =
    sortDir === "desc" ? " ↓" : sortDir === "asc" ? " ↑" : "";

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: column.id, disabled: !canReorder });

  const style: React.CSSProperties = {
    transform: dndReady ? CSS.Translate.toString(transform) : undefined,
    transition: dndReady ? transition : undefined,
    opacity: dndReady && isDragging ? 0.6 : 1,
    width: enableColumnResizing ? column.getSize() : undefined,
    position: "relative",
  };

  const hint = meta?.hint;
  const headerContent = flexRender(
    column.columnDef.header,
    header.getContext(),
  );

  const alignClass =
    align === "right"
      ? "text-right"
      : align === "center"
        ? "text-center"
        : "text-left";

  return (
    <th
      ref={dndReady ? setNodeRef : undefined}
      style={style}
      colSpan={header.colSpan}
      className={cn(
        thClassName,
        alignClass,
        canSort && "cursor-pointer select-none hover:text-foreground",
      )}
      onClick={canSort ? () => onSortClick(header) : undefined}
      {...(dndReady ? attributes : {})}
    >
      <div className="inline-flex items-center gap-1">
        {canReorder && dndReady && (
          <button
            type="button"
            aria-label={`Drag to reorder ${column.id}`}
            className="cursor-grab active:cursor-grabbing opacity-40 hover:opacity-100 touch-none"
            onClick={(e) => e.stopPropagation()}
            {...listeners}
          >
            <GripVertical className="size-3" />
          </button>
        )}
        {hint ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-help inline-flex items-center">
                {headerContent}
                {sortIndicator && <span>{sortIndicator}</span>}
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="max-w-[280px] whitespace-pre-line"
            >
              {hint}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="inline-flex items-center">
            {headerContent}
            {sortIndicator && <span>{sortIndicator}</span>}
          </span>
        )}
      </div>
      {enableColumnResizing && column.getCanResize() && (
        <div
          onMouseDown={header.getResizeHandler()}
          onTouchStart={header.getResizeHandler()}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "absolute top-0 right-0 h-full w-1 cursor-col-resize select-none touch-none",
            "hover:bg-primary/40",
            column.getIsResizing() && "bg-primary/60",
          )}
        />
      )}
    </th>
  );
}

// ---------- body cell ----------

function DataCell<T>({
  cell,
  tdClassName,
  enableColumnResizing,
}: {
  cell: Cell<T, unknown>;
  tdClassName: string;
  enableColumnResizing: boolean;
}) {
  const meta = cell.column.columnDef.meta;
  const align = meta?.align ?? "left";
  const alignClass =
    align === "right"
      ? "text-right tabular-nums"
      : align === "center"
        ? "text-center"
        : "text-left";

  return (
    <td
      className={cn(tdClassName, alignClass)}
      style={{
        width: enableColumnResizing ? cell.column.getSize() : undefined,
      }}
    >
      {flexRender(cell.column.columnDef.cell, cell.getContext())}
    </td>
  );
}

// ---------- main component ----------

export function DataTable<T>({
  data,
  columns,
  getRowId,
  enableSorting = false,
  enableMultiSort = false,
  enableColumnResizing = false,
  enableColumnOrdering = false,
  enableGrouping = false,
  enableRowSelection = false,
  enableExpanding = false,
  enableVirtualization = true,
  rowHeight,
  getRowHeight,
  rowSelection,
  onRowSelectionChange,
  persistenceKey,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onRowClick,
  rowClassName,
  renderEmpty,
  renderLoading,
  renderFooter,
  loading,
  className,
  density = "compact",
}: DataTableProps<T>) {
  const styleTokens = densityClasses[density];
  const effectiveRowHeight = rowHeight ?? styleTokens.rowHeight;

  // Persisted state (bundled into one localStorage entry per table).
  const [persisted, setPersisted] = useLocalStorage<PersistedState>(
    persistenceKey ?? "__data-table-no-persist__",
    {},
  );
  const isPersisting = Boolean(persistenceKey);

  const [sorting, setSortingState] = React.useState<SortingState>(
    persisted.sorting ?? [],
  );
  const [columnSizing, setColumnSizingState] =
    React.useState<ColumnSizingState>(persisted.columnSizing ?? {});
  const [columnOrder, setColumnOrderState] = React.useState<ColumnOrderState>(
    persisted.columnOrder ?? columns.map((c) => (c.id ?? "") as string),
  );
  const [columnVisibility, setColumnVisibilityState] =
    React.useState<VisibilityState>(persisted.columnVisibility ?? {});
  const [grouping, setGroupingState] = React.useState<GroupingState>(
    persisted.grouping ?? [],
  );

  // Flush bundled state changes to localStorage (debounced inside useLocalStorage).
  React.useEffect(() => {
    if (!isPersisting) return;
    setPersisted({
      sorting,
      columnSizing,
      columnOrder,
      columnVisibility,
      grouping,
    });
  }, [
    isPersisting,
    sorting,
    columnSizing,
    columnOrder,
    columnVisibility,
    grouping,
    setPersisted,
  ]);

  // Seed initial column sizes from `meta.initialSize` once.
  const seededSizingRef = React.useRef(false);
  React.useEffect(() => {
    if (seededSizingRef.current) return;
    if (!enableColumnResizing) return;
    if (
      persisted.columnSizing &&
      Object.keys(persisted.columnSizing).length > 0
    )
      return;
    const seeded: ColumnSizingState = {};
    for (const col of columns) {
      const id = (col.id ?? "") as string;
      const size = col.meta?.initialSize;
      if (id && typeof size === "number") seeded[id] = size;
    }
    if (Object.keys(seeded).length > 0) setColumnSizingState(seeded);
    seededSizingRef.current = true;
  }, [columns, enableColumnResizing, persisted.columnSizing]);

  const table = useReactTable<T>({
    data,
    columns,
    state: {
      sorting,
      columnSizing,
      columnOrder,
      columnVisibility,
      grouping,
      rowSelection: rowSelection ?? {},
    },
    onSortingChange: setSortingState,
    onColumnSizingChange: setColumnSizingState,
    onColumnOrderChange: setColumnOrderState,
    onColumnVisibilityChange: setColumnVisibilityState,
    onGroupingChange: setGroupingState,
    onRowSelectionChange: (updater) => {
      if (!onRowSelectionChange) return;
      const next =
        typeof updater === "function" ? updater(rowSelection ?? {}) : updater;
      onRowSelectionChange(next);
    },
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: enableSorting ? getSortedRowModel() : undefined,
    getGroupedRowModel: enableGrouping ? getGroupedRowModel() : undefined,
    getExpandedRowModel:
      enableGrouping || enableExpanding ? getExpandedRowModel() : undefined,
    enableSorting,
    enableMultiSort,
    enableColumnResizing,
    enableGrouping,
    enableRowSelection,
    columnResizeMode: "onChange",
    manualPagination: true,
    autoResetExpanded: false,
  });

  // Tri-state sort cycle: desc → asc → none (TanStack default is asc → desc).
  const cycleSort = React.useCallback(
    (header: Header<T, unknown>) => {
      if (!enableSorting || !header.column.getCanSort()) return;
      const current = header.column.getIsSorted();
      if (current === false) {
        header.column.toggleSorting(true); // desc
      } else if (current === "desc") {
        header.column.toggleSorting(false); // asc
      } else {
        header.column.clearSorting(); // none
      }
    },
    [enableSorting],
  );

  // Drag-and-drop sensors (mouse/touch/keyboard).
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 6 },
    }),
    useSensor(KeyboardSensor),
  );

  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      setColumnOrderState((prev) => {
        // If prev is empty (first time), seed it from the current table layout.
        const baseline =
          prev && prev.length > 0
            ? prev
            : table.getAllLeafColumns().map((c) => c.id);
        const oldIndex = baseline.indexOf(active.id as string);
        const newIndex = baseline.indexOf(over.id as string);
        if (oldIndex < 0 || newIndex < 0) return baseline;
        return arrayMove(baseline, oldIndex, newIndex);
      });
    },
    [table],
  );

  // Virtualization.
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const rows = table.getRowModel().rows;
  const sizeForIndex = React.useCallback(
    (index: number): number => {
      const row = rows[index];
      if (!row) return effectiveRowHeight;
      return getRowHeight?.(row.original) ?? effectiveRowHeight;
    },
    [rows, effectiveRowHeight, getRowHeight],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: sizeForIndex,
    overscan: 12,
    enabled: enableVirtualization,
  });
  const virtualItems = enableVirtualization
    ? virtualizer.getVirtualItems()
    : [];
  const totalSize = enableVirtualization ? virtualizer.getTotalSize() : 0;
  const paddingTop =
    enableVirtualization && virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom =
    enableVirtualization && virtualItems.length > 0
      ? totalSize - virtualItems[virtualItems.length - 1].end
      : 0;

  // Infinite-scroll trigger.
  const lastVisibleIndex =
    virtualItems[virtualItems.length - 1]?.index ??
    (enableVirtualization ? -1 : rows.length - 1);
  React.useEffect(() => {
    if (!onLoadMore || !hasNextPage || isFetchingNextPage) return;
    if (rows.length > 0 && lastVisibleIndex >= rows.length - 10) {
      onLoadMore();
    }
  }, [
    lastVisibleIndex,
    rows.length,
    hasNextPage,
    isFetchingNextPage,
    onLoadMore,
  ]);

  // Header columns for SortableContext — only the non-fixed ones are draggable,
  // but every leaf column needs to be in the DOM as a <th>.
  const headerGroups = table.getHeaderGroups();
  const sortableIds = React.useMemo(
    () =>
      table
        .getAllLeafColumns()
        .filter((c) => !c.columnDef.meta?.fixed)
        .map((c) => c.id),
    [table],
  );

  const colSpan = table.getVisibleLeafColumns().length;
  const showEmpty = !loading && rows.length === 0;
  const showLoadingPlaceholder = loading && rows.length === 0;

  const bodyRows = enableVirtualization
    ? virtualItems.map((vi) => ({ row: rows[vi.index], key: vi.key, vi }))
    : rows.map((row, i) => ({
        row,
        key: row.id,
        vi: {
          start: i * effectiveRowHeight,
          end: (i + 1) * effectiveRowHeight,
          index: i,
          size: effectiveRowHeight,
          key: row.id,
          lane: 0,
        },
      }));

  // DndContext generates accessibility IDs (DndDescribedBy-N) from an internal
  // counter that doesn't line up between SSR and the first client render,
  // triggering a hydration mismatch on `aria-describedby`. Gate the provider
  // behind a post-mount flag so SSR emits a plain table and the client adds
  // DnD after hydration — no user-visible flicker, no mismatch.
  const [dndReady, setDndReady] = React.useState(false);
  React.useEffect(() => {
    setDndReady(true);
  }, []);

  const tableContent = (
    <table
      className="w-full border-collapse"
      style={{
        minWidth: enableColumnResizing ? table.getTotalSize() : undefined,
      }}
    >
      <thead className="sticky top-0 z-10">
        {headerGroups.map((group) => {
          const headerCells = group.headers.map((header) => (
            <HeaderCellInner
              key={header.id}
              header={header}
              enableSorting={enableSorting}
              enableColumnOrdering={enableColumnOrdering}
              enableColumnResizing={enableColumnResizing}
              dndReady={dndReady}
              thClassName={styleTokens.th}
              onSortClick={cycleSort}
            />
          ));
          return (
            <tr key={group.id} className="bg-muted border-b border-border">
              {dndReady ? (
                <SortableContext
                  items={sortableIds}
                  strategy={horizontalListSortingStrategy}
                >
                  {headerCells}
                </SortableContext>
              ) : (
                headerCells
              )}
            </tr>
          );
        })}
      </thead>
      <tbody>
        {showLoadingPlaceholder && (
          <tr>
            <td
              colSpan={colSpan}
              className="text-center text-muted-foreground py-8 text-xs"
            >
              {renderLoading ? (
                renderLoading()
              ) : (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="size-3.5 animate-spin" />
                  Loading…
                </span>
              )}
            </td>
          </tr>
        )}
        {showEmpty && (
          <tr>
            <td
              colSpan={colSpan}
              className="text-center text-muted-foreground py-8 text-xs"
            >
              {renderEmpty ? renderEmpty() : "No rows."}
            </td>
          </tr>
        )}

        {enableVirtualization && rows.length > 0 && paddingTop > 0 && (
          <tr aria-hidden="true" style={{ height: paddingTop }}>
            <td colSpan={colSpan} />
          </tr>
        )}

        {bodyRows.map(({ row, key }) => (
          <DataRow
            key={key}
            row={row}
            rowHeight={getRowHeight?.(row.original) ?? effectiveRowHeight}
            tdClassName={styleTokens.td}
            enableColumnResizing={enableColumnResizing}
            onRowClick={onRowClick}
            rowClassName={rowClassName}
          />
        ))}

        {enableVirtualization && rows.length > 0 && paddingBottom > 0 && (
          <tr aria-hidden="true" style={{ height: paddingBottom }}>
            <td colSpan={colSpan} />
          </tr>
        )}

        {isFetchingNextPage && (
          <tr>
            <td
              colSpan={colSpan}
              className="text-center text-muted-foreground py-3 text-xs"
            >
              <span className="inline-flex items-center gap-2">
                <Loader2 className="size-3.5 animate-spin" />
                Loading more…
              </span>
            </td>
          </tr>
        )}

        {renderFooter &&
          !showLoadingPlaceholder &&
          !showEmpty &&
          !hasNextPage &&
          !isFetchingNextPage &&
          rows.length > 0 && (
            <tr>
              <td colSpan={colSpan} className="px-4 py-2">
                {renderFooter()}
              </td>
            </tr>
          )}
      </tbody>
    </table>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <div
        ref={scrollRef}
        className={cn("flex-1 min-h-0 overflow-auto", className)}
      >
        {dndReady ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            {tableContent}
          </DndContext>
        ) : (
          tableContent
        )}
      </div>
    </TooltipProvider>
  );
}

// Split out so hover/click handlers don't rerender every row on unrelated state.
function DataRow<T>({
  row,
  rowHeight,
  tdClassName,
  enableColumnResizing,
  onRowClick,
  rowClassName,
}: {
  row: Row<T>;
  rowHeight: number;
  tdClassName: string;
  enableColumnResizing: boolean;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
}) {
  const isGrouped = row.getIsGrouped();
  const extra = rowClassName?.(row.original);

  if (isGrouped) {
    // Group header row — spans all visible cells, shows group key + count.
    const groupCellIndex = row
      .getVisibleCells()
      .findIndex((c) => c.getIsGrouped());
    const groupCell = row.getVisibleCells()[groupCellIndex];
    return (
      <tr
        className="bg-muted/60 border-b border-border font-semibold cursor-pointer hover:bg-muted/80"
        style={{ height: rowHeight }}
        onClick={() => row.toggleExpanded()}
      >
        <td
          colSpan={row.getVisibleCells().length}
          className={cn(tdClassName, "text-foreground")}
        >
          <span className="inline-flex items-center gap-1">
            <ChevronRight
              className={cn(
                "size-3.5 transition-transform",
                row.getIsExpanded() && "rotate-90",
              )}
            />
            {groupCell
              ? flexRender(
                  groupCell.column.columnDef.cell,
                  groupCell.getContext(),
                )
              : String(row.groupingColumnId)}
            <span className="text-muted-foreground font-normal">
              ({row.subRows.length})
            </span>
          </span>
        </td>
      </tr>
    );
  }

  return (
    <tr
      data-state={row.getIsSelected() ? "selected" : undefined}
      style={{ height: rowHeight }}
      className={cn(
        "border-b border-border/50 hover:bg-muted/40 transition-colors",
        row.getIsSelected() && "bg-primary/5",
        onRowClick && "cursor-pointer",
        extra,
      )}
      onClick={onRowClick ? () => onRowClick(row.original) : undefined}
    >
      {row.getVisibleCells().map((cell) => (
        <DataCell
          key={cell.id}
          cell={cell}
          tdClassName={tdClassName}
          enableColumnResizing={enableColumnResizing}
        />
      ))}
    </tr>
  );
}
