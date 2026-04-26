"use client";

/**
 * Side drawer that opens when an entity row is clicked. Shows the
 * entity's metadata, every surface form (with inline promote/retire),
 * and the most recent observations bound to the entity.
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowRight, Loader2, RefreshCw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { entitiesAction, fetchEntityDetail } from "./api";
import { OutcomePill, StatusPill, relativeTime } from "./atoms";
import type { Entity, EntityName, ObservationRow } from "./types";

interface Props {
  id: string;
  onClose: () => void;
  onMutated: () => void;
}

export function EntityDrawer({ id, onClose, onMutated }: Props) {
  const [data, setData] = useState<{
    entity: Entity;
    names: EntityName[];
    observations: ObservationRow[];
  } | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetchEntityDetail(id);
      setData(d);
    } catch (err) {
      toast.error("Failed to load entity", {
        description: (err as Error).message,
      });
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const action = useCallback(
    async (body: Record<string, unknown>, success: string) => {
      const r = await entitiesAction(body);
      if (!r.success) {
        toast.error("Action failed", { description: r.error });
        return;
      }
      toast.success(success);
      await refresh();
      onMutated();
    },
    [refresh, onMutated],
  );

  return (
    <aside className="fixed inset-y-0 right-0 w-[640px] max-w-[90vw] z-40 bg-zinc-950 border-l border-zinc-800 shadow-2xl flex flex-col">
      <header className="flex items-start justify-between gap-3 px-4 py-3 border-b border-zinc-800">
        {data ? (
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-zinc-100 truncate">
              {data.entity.canonicalName}
            </h3>
            <p className="text-[10px] text-zinc-500 mt-0.5">
              {data.entity.kind} · {data.entity.country ?? "—"} ·{" "}
              {data.entity.gender ?? "—"} · created{" "}
              {relativeTime(data.entity.createdAt)}
            </p>
            <p className="text-[10px] text-zinc-600 font-mono truncate">
              {data.entity.id}
            </p>
          </div>
        ) : (
          <div className="text-xs text-zinc-500 flex items-center gap-2">
            <Loader2 className="w-3 h-3 animate-spin" /> Loading entity
          </div>
        )}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={refresh}
            disabled={loading}
            className="h-7 w-7 p-0"
          >
            <RefreshCw className="w-3 h-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-7 w-7 p-0"
          >
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {data && (
          <>
            <Section title={`Surface forms (${data.names.length})`}>
              {data.names.length === 0 ? (
                <div className="text-[11px] text-zinc-500">
                  No surface forms recorded yet.
                </div>
              ) : (
                <table className="w-full text-[11px]">
                  <thead className="text-zinc-500">
                    <tr className="border-b border-zinc-800/50">
                      <th className="text-left px-2 py-1 font-medium">
                        Provider
                      </th>
                      <th className="text-left px-2 py-1 font-medium">
                        Surface
                      </th>
                      <th className="text-center px-2 py-1 font-medium">
                        Status
                      </th>
                      <th className="text-right px-2 py-1 font-medium">
                        Pos / Neg
                      </th>
                      <th className="text-right px-2 py-1 font-medium">
                        Weight
                      </th>
                      <th className="text-right px-2 py-1 font-medium">
                        Score
                      </th>
                      <th className="text-center px-2 py-1 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.names.map((n) => (
                      <tr key={n.id} className="border-b border-zinc-800/40">
                        <td className="px-2 py-1 font-mono text-zinc-400">
                          {n.provider}
                        </td>
                        <td className="px-2 py-1 text-zinc-200">
                          {n.surfaceRaw}
                          <div className="text-[9px] text-zinc-600">
                            {n.surfaceNormalized}
                          </div>
                        </td>
                        <td className="px-2 py-1 text-center">
                          <StatusPill status={n.status} />
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums text-zinc-400">
                          {n.positiveObs}/{n.negativeObs}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums text-zinc-400">
                          {n.weight.toFixed(1)}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums text-zinc-400">
                          {n.classifierScore != null
                            ? n.classifierScore.toFixed(3)
                            : "—"}
                        </td>
                        <td className="px-2 py-1 text-center whitespace-nowrap">
                          {n.status === "candidate" && (
                            <button
                              onClick={() =>
                                action(
                                  {
                                    action: "promote-name",
                                    entityNameId: n.id,
                                  },
                                  `Promoted "${n.surfaceRaw}"`,
                                )
                              }
                              className="text-[10px] text-emerald-400 hover:text-emerald-300 mr-2"
                            >
                              Promote
                            </button>
                          )}
                          {n.status !== "retired" && (
                            <button
                              onClick={() =>
                                action(
                                  {
                                    action: "retire-name",
                                    entityNameId: n.id,
                                  },
                                  `Retired "${n.surfaceRaw}"`,
                                )
                              }
                              className="text-[10px] text-zinc-500 hover:text-rose-400"
                            >
                              Retire
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>

            <Section
              title={`Recent observations (${data.observations.length})`}
            >
              {data.observations.length === 0 ? (
                <div className="text-[11px] text-zinc-500">
                  No observations.
                </div>
              ) : (
                <ul className="space-y-1">
                  {data.observations.map((o) => (
                    <li
                      key={o.id}
                      className="flex items-center gap-2 text-[11px] py-0.5"
                    >
                      <span className="text-zinc-600 font-mono w-16 shrink-0">
                        {relativeTime(o.observedAt)}
                      </span>
                      <span className="text-zinc-400 w-24 shrink-0 truncate">
                        {o.provider}
                      </span>
                      <span className="text-zinc-200 truncate flex-1">
                        {o.surfaceRaw}
                      </span>
                      <OutcomePill outcome={o.outcome} />
                      <span className="text-zinc-600 ml-auto text-[10px]">
                        {o.source}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            {data.entity.metadata &&
              Object.keys(data.entity.metadata).length > 0 && (
                <Section title="Metadata">
                  <pre className="text-[10px] font-mono bg-zinc-950/40 border border-zinc-800/60 rounded p-2 overflow-x-auto text-zinc-400">
                    {JSON.stringify(data.entity.metadata, null, 2)}
                  </pre>
                </Section>
              )}
          </>
        )}
      </div>

      {data && (
        <footer className="flex items-center justify-between px-4 py-2 border-t border-zinc-800">
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              action(
                { action: "retire", entityId: data.entity.id },
                `Retired entity ${data.entity.canonicalName}`,
              )
            }
            className="h-7 text-[11px] text-rose-400 hover:text-rose-300"
          >
            <Trash2 className="w-3 h-3 mr-1.5" /> Retire entity
          </Button>
          <div className="text-[10px] text-zinc-600">
            click <ArrowRight className="inline w-3 h-3" /> a surface row above
            to promote or retire
          </div>
        </footer>
      )}
    </aside>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">
        {title}
      </div>
      <div className="border border-zinc-800/60 rounded p-2 bg-zinc-900/30">
        {children}
      </div>
    </div>
  );
}
