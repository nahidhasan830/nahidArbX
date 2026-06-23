"use client";


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
