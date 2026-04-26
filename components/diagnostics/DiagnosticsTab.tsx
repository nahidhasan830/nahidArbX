"use client";

import { useState } from "react";
import { EntityInspector } from "./EntityInspector";
import { MatchReviewPanel } from "./MatchReviewPanel";

type SubView = "review" | "entities";

export function DiagnosticsTab() {
  const [subView, setSubView] = useState<SubView>("review");

  const tabButton = (id: SubView, label: string) => (
    <button
      onClick={() => setSubView(id)}
      className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
        subView === id
          ? "bg-zinc-800 text-zinc-100"
          : "text-zinc-500 hover:text-zinc-300"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex items-center gap-1 px-3 py-2 border-b border-zinc-800/50">
        {tabButton("review", "Match Review")}
        {tabButton("entities", "Entities")}
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {subView === "review" && <MatchReviewPanel />}
        {subView === "entities" && (
          <div className="h-full p-2">
            <EntityInspector />
          </div>
        )}
      </div>
    </div>
  );
}

export default DiagnosticsTab;
