"use client";

/**
 * Column-width resize hook for the value-bets spreadsheet.
 *
 * Uses a CSS-variable-on-container pattern: during drag we write the new
 * width directly to `container.style.--col-<name>-size`, so each mousemove
 * only touches one style property. React state is only synced on mouseup,
 * which avoids the per-frame layout thrash you get when driving `<th>`
 * widths through state during the drag.
 *
 * Returns an opaque object with:
 *   - `columnSizeVars`  – inline style object for the table container
 *   - `handleResizeStart(col, event)` – mousedown handler for each resize grip
 *
 * Callers render each column width as `width: calc(var(--col-<name>-size) * 1px)`.
 */

import { useCallback, useMemo, useState } from "react";

type WidthMap = Record<string, number>;

export function useSpreadsheetColumnWidths(defaultWidths: WidthMap) {
  const [columnWidths, setColumnWidths] = useState<WidthMap>(defaultWidths);

  const columnSizeVars = useMemo(() => {
    const vars: Record<string, string> = {};
    for (const [col, size] of Object.entries(columnWidths)) {
      vars[`--col-${col}-size`] = `${size}`;
    }
    return vars;
  }, [columnWidths]);

  const handleResizeStart = useCallback(
    (col: string, e: React.MouseEvent) => {
      e.preventDefault();
      const container = (e.target as HTMLElement).closest(
        ".table-container",
      ) as HTMLElement | null;
      if (!container) return;

      const startX = e.clientX;
      const startWidth = columnWidths[col] ?? defaultWidths[col] ?? 100;

      // Overlay captures mouse events even if the cursor leaves the grip.
      const overlay = document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:9999;cursor:col-resize";
      document.body.appendChild(overlay);

      let currentWidth = startWidth;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const diff = moveEvent.clientX - startX;
        currentWidth = Math.max(50, startWidth + diff);
        container.style.setProperty(`--col-${col}-size`, `${currentWidth}`);
      };

      const handleMouseUp = () => {
        overlay.remove();
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        setColumnWidths((prev) => ({ ...prev, [col]: currentWidth }));
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [columnWidths, defaultWidths],
  );

  return { columnSizeVars, handleResizeStart };
}
