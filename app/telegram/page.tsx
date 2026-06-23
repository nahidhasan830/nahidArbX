"use client";


import * as React from "react";
import {
  differenceInDays,
  differenceInHours,
  differenceInMinutes,
  differenceInSeconds,
  parseISO,
} from "date-fns";
import {
  CheckCircle2,
  Info,
  MessageCircleMore,
  Power,
  RotateCw,
  Search,
  XCircle,
} from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { AppShell } from "@/components/nav/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";


interface CommandEntry {
  name: string;
  usage: string;
  description: string;
  explanation: string;
  group: "read" | "control" | "destructive" | "meta";
  destructive: boolean;
  enabled: boolean;
  callCount: number;
}

interface CommandsApiPayload {
  commands: CommandEntry[];
  configured: boolean;
  running: boolean;
  updatedAt: string | null;
}

interface HistoryEntry {
  at: string;
  command: string;
  text: string;
  fromUserId: number | null;
  outcome: "ok" | "denied" | "unknown" | "error";
  durationMs: number;
  error?: string | null;
}

interface HistoryApiPayload {
  entries: HistoryEntry[];
  stats: {
    total: number;
    ok: number;
    denied: number;
    unknown: number;
    error: number;
    topCommands: Array<{ name: string; count: number }>;
  };
  counts: Record<string, number>;
}

type GroupKey = "all" | CommandEntry["group"];

const GROUP_PILLS: Array<{
  key: GroupKey;
  label: string;
  icon: string;
  tone: string;
}> = [
  { key: "all", label: "All", icon: "✦", tone: "border-foreground/40" },
  { key: "meta", label: "Meta", icon: "📖", tone: "border-sky-500/40" },
  { key: "read", label: "Read", icon: "📊", tone: "border-emerald-500/40" },
  {
    key: "control",
    label: "Control",
    icon: "🎛",
    tone: "border-amber-500/40",
  },
  {
    key: "destructive",
    label: "Destructive",
    icon: "⚠️",
    tone: "border-rose-500/40",
  },
];

function relativeTime(iso: string): string {
  const date = parseISO(iso);
  if (Number.isNaN(date.getTime())) return "now";
  const now = new Date();
  const seconds = differenceInSeconds(now, date);
  if (seconds < 0) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = differenceInMinutes(now, date);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = differenceInHours(now, date);
  if (hours < 24) return `${hours}h ago`;
  return `${differenceInDays(now, date)}d ago`;
}


export default function TelegramConfigPage() {
  const [data, setData] = React.useState<CommandsApiPayload | null>(null);
  const [history, setHistory] = React.useState<HistoryApiPayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [savingNames, setSavingNames] = React.useState<Set<string>>(new Set());
  const [starting, setStarting] = React.useState(false);
  const [filter, setFilter] = React.useState<GroupKey>("all");
  const [search, setSearch] = React.useState("");

  const load = React.useCallback(async () => {
    try {
      const [cmdRes, histRes] = await Promise.all([
        fetch("/api/telegram/commands", { cache: "no-store" }),
        fetch("/api/telegram/history?limit=50", { cache: "no-store" }),
      ]);
      if (!cmdRes.ok) throw new Error(`commands: HTTP ${cmdRes.status}`);
      if (!histRes.ok) throw new Error(`history: HTTP ${histRes.status}`);
      setData((await cmdRes.json()) as CommandsApiPayload);
      setHistory((await histRes.json()) as HistoryApiPayload);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      await load();
      if (cancelled) return;
      timer = setTimeout(tick, 10_000);
    };

    const onVisibility = () => {
      if (cancelled) return;
      if (document.hidden) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      } else {
        if (timer) clearTimeout(timer);
        void tick();
      }
    };

    void tick();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  const toggleCommand = React.useCallback(
    async (name: string, next: boolean) => {
      setSavingNames((prev) => new Set(prev).add(name));
      setData((prev) =>
        prev
          ? {
              ...prev,
              commands: prev.commands.map((c) =>
                c.name === name ? { ...c, enabled: next } : c,
              ),
            }
          : prev,
      );
      try {
        const res = await fetch("/api/telegram/commands", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ updates: { [name]: next } }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        setError((err as Error).message);
        void load();
      } finally {
        setSavingNames((prev) => {
          const next = new Set(prev);
          next.delete(name);
          return next;
        });
      }
    },
    [load],
  );

  const setBulk = React.useCallback(
    async (enabled: boolean) => {
      if (!data) return;
      const updates: Record<string, boolean> = {};
      for (const c of data.commands) updates[c.name] = enabled;
      setData({
        ...data,
        commands: data.commands.map((c) => ({ ...c, enabled })),
      });
      try {
        await fetch("/api/telegram/commands", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ updates }),
        });
      } catch (err) {
        setError((err as Error).message);
        void load();
      }
    },
    [data, load],
  );

  const startBot = React.useCallback(async () => {
    setStarting(true);
    try {
      await fetch("/api/telegram/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      await load();
    } finally {
      setStarting(false);
    }
  }, [load]);

  const filteredRows = React.useMemo(() => {
    const all = data?.commands ?? [];
    const q = search.trim().toLowerCase();
    return all.filter((c) => {
      if (filter !== "all" && c.group !== filter) return false;
      if (
        q &&
        !c.name.includes(q) &&
        !c.description.toLowerCase().includes(q) &&
        !c.usage.toLowerCase().includes(q)
      )
        return false;
      return true;
    });
  }, [data, filter, search]);

  const totalEnabled = data?.commands.filter((c) => c.enabled).length ?? 0;
  const totalCommands = data?.commands.length ?? 0;

  const columns = React.useMemo<ColumnDef<CommandEntry, unknown>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: () => "Command",
        cell: ({ row }) => (
          <code className="font-mono text-[12px] font-semibold text-cyan-300">
            /{row.original.name}
          </code>
        ),
        meta: {
          hint: "Slash command name. Type this in Telegram exactly as shown.",
          initialSize: 130,
        },
      },
      {
        id: "usage",
        accessorKey: "usage",
        header: () => "Usage",
        cell: ({ row }) => (
          <span
            className="block font-mono text-[11px] text-muted-foreground/85 leading-snug whitespace-normal break-all"
            title={row.original.usage}
          >
            {row.original.usage}
          </span>
        ),
        meta: {
          hint: "Argument syntax. Long usage lines wrap onto a second row. Square brackets are optional, angle brackets are required.",
          initialSize: 280,
        },
      },
      {
        id: "group",
        accessorKey: "group",
        header: () => "Type",
        cell: ({ row }) => {
          const meta = GROUP_PILLS.find((p) => p.key === row.original.group);
          return (
            <Badge
              variant="outline"
              className={cn(
                "h-4 px-1.5 text-[10px] uppercase tracking-wider",
                meta?.tone,
              )}
            >
              {meta?.icon} {row.original.group}
            </Badge>
          );
        },
        meta: {
          hint: "Read = info only · Control = safe writes · Destructive = real-money / persistent state changes (require Telegram confirm tap).",
          initialSize: 110,
        },
        enableSorting: true,
      },
      {
        id: "description",
        accessorKey: "description",
        header: () => "Description",
        cell: ({ row }) => (
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="truncate">{row.original.description}</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="size-3.5 shrink-0 text-muted-foreground/60 hover:text-foreground/80 cursor-help" />
              </TooltipTrigger>
              <TooltipContent
                className="max-w-md text-sm leading-relaxed whitespace-pre-line"
                side="top"
              >
                <span
                  dangerouslySetInnerHTML={{ __html: row.original.explanation }}
                />
              </TooltipContent>
            </Tooltip>
            {row.original.destructive && (
              <Badge
                variant="outline"
                className="h-4 px-1 text-[9px] uppercase tracking-wider border-rose-500/40 bg-rose-500/10 text-rose-300 shrink-0"
              >
                confirm
              </Badge>
            )}
          </div>
        ),
        meta: {
          hint: "One-line summary. Hover the info icon for the full plain-language explanation with a betting example.",
        },
      },
      {
        id: "calls",
        accessorKey: "callCount",
        header: () => "Calls",
        cell: ({ row }) => {
          const n = row.original.callCount;
          return (
            <span
              className={cn(
                "inline-block font-mono tabular-nums text-[11px]",
                n === 0
                  ? "text-muted-foreground/40"
                  : "text-cyan-300 font-semibold",
              )}
            >
              {n.toLocaleString()}
            </span>
          );
        },
        meta: {
          hint: "How many times this command has been triggered from Telegram since the server booted. Resets on server restart.",
          align: "right",
          initialSize: 80,
        },
        enableSorting: true,
      },
      {
        id: "enabled",
        accessorKey: "enabled",
        header: () => "Enabled",
        cell: ({ row }) => (
          <Switch
            checked={row.original.enabled}
            disabled={
              row.original.name === "help" || savingNames.has(row.original.name)
            }
            onCheckedChange={(v) => void toggleCommand(row.original.name, v)}
          />
        ),
        meta: {
          hint: "Disabled commands return a 🚫 reply on Telegram. /help is always on so you can never lock yourself out.",
          align: "right",
          initialSize: 90,
          fixed: "right",
        },
        enableSorting: false,
      },
    ],
    [savingNames, toggleCommand],
  );

  const getRowHeight = React.useCallback(
    (row: CommandEntry) => (row.usage.length > 38 ? 56 : 30),
    [],
  );

  return (
    <AppShell
      title="Telegram Control"
      titleBadge={
        data ? (
          <Badge
            variant="outline"
            className={cn(
              "h-5 text-[10px] uppercase tracking-wider font-semibold",
              data.running
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                : "border-amber-500/40 bg-amber-500/10 text-amber-300",
            )}
          >
            {data.running ? "🟢 polling" : "⚪ stopped"}
          </Badge>
        ) : null
      }
      actions={
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            className="h-7 px-2.5 text-[11px]"
          >
            <RotateCw className="size-3 mr-1" /> Refresh
          </Button>
          {data && !data.running && data.configured && (
            <Button
              size="sm"
              onClick={() => void startBot()}
              disabled={starting}
              className="h-7 px-2.5 text-[11px]"
            >
              <Power className="size-3 mr-1" /> Start bot
            </Button>
          )}
        </div>
      }
      edgeToEdge
    >
      <TooltipProvider delayDuration={150}>
        <div className="flex flex-col flex-1 min-h-0">
          <div className="px-4 py-3 border-b border-border/40 bg-muted/20 backdrop-blur-sm">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3 text-sm">
                <MessageCircleMore className="size-5 text-cyan-400 shrink-0" />
                <div>
                  <div className="font-semibold text-foreground/90">
                    Bot · {data?.running ? "running" : "stopped"}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    Listens for slash commands from your Telegram chat. Turn off
                    any command with the toggle — disabled ones show a 🚫 reply
                    when you try them.
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-[11px] text-muted-foreground tabular-nums">
                  <span className="text-foreground font-semibold">
                    {totalEnabled}
                  </span>
                  /{totalCommands} enabled
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void setBulk(true)}
                  className="h-7 px-2.5 text-[11px]"
                >
                  Enable all
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void setBulk(false)}
                  className="h-7 px-2.5 text-[11px]"
                >
                  Disable all
                </Button>
              </div>
            </div>
            {data && !data.configured && (
              <div className="mt-3 text-[12px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-1.5">
                ⚠️ <b>TELEGRAM_BOT_TOKEN</b> and/or <b>TELEGRAM_CHAT_ID</b> are
                not set. Add them to <code>.env</code> and restart the server.
              </div>
            )}
            {error && (
              <div className="mt-3 text-[12px] text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-md px-3 py-1.5">
                ⚠️ {error}
              </div>
            )}
          </div>

          <div className="px-4 py-2.5 border-b border-border/40 bg-muted/10">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/60" />
                <Input
                  placeholder="Search commands…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-7 pl-7 pr-2 text-[12px] w-56 bg-background"
                />
              </div>
              <div className="flex items-center gap-1">
                {GROUP_PILLS.map((p) => {
                  const count =
                    data?.commands.filter(
                      (c) => p.key === "all" || c.group === p.key,
                    ).length ?? 0;
                  const active = filter === p.key;
                  return (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => setFilter(p.key)}
                      className={cn(
                        "h-7 px-3 py-1.5 rounded-md border bg-muted/40 text-[11px] font-medium transition-colors",
                        active
                          ? cn(
                              "border-foreground/40 bg-foreground/10 text-foreground",
                              p.tone,
                            )
                          : "border-border/40 text-muted-foreground hover:text-foreground hover:bg-muted/60",
                      )}
                    >
                      <span className="mr-1">{p.icon}</span>
                      {p.label}
                      <span className="ml-1.5 text-muted-foreground/70 tabular-nums">
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="ml-auto text-[11px] text-muted-foreground tabular-nums">
                {filteredRows.length} shown
              </div>
            </div>
          </div>

          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-0">
            <div className="flex flex-col min-h-0 border-r border-border/40">
              <DataTable<CommandEntry>
                data={filteredRows}
                columns={columns}
                getRowId={(row) => row.name}
                getRowHeight={getRowHeight}
                enableSorting
                enableColumnResizing
                enableVirtualization
                density="compact"
                persistenceKey="telegram-commands"
                className="bg-background [&_table]:table-fixed [&_td]:!whitespace-normal [&_td]:align-top [&_td]:py-1.5"
              />
            </div>

            <HistorySidebar history={history} />
          </div>
        </div>
      </TooltipProvider>
    </AppShell>
  );
}


function HistorySidebar({ history }: { history: HistoryApiPayload | null }) {
  return (
    <aside className="flex flex-col min-h-0 bg-muted/10">
      <div className="px-3 py-2 border-b border-border/40 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground/90">
            Command history
          </h3>
          <p className="text-[10px] text-muted-foreground">
            Last 50 commands · live updating
          </p>
        </div>
        {history && (
          <div className="flex items-center gap-1.5 text-[10px] tabular-nums">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-0.5 text-emerald-300">
                  <CheckCircle2 className="size-3" />
                  {history.stats.ok}
                </span>
              </TooltipTrigger>
              <TooltipContent>Successful dispatches.</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-0.5 text-rose-300">
                  <XCircle className="size-3" />
                  {history.stats.error + history.stats.denied}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                Errors + denied (disabled command).
              </TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      {history?.stats.topCommands.length ? (
        <div className="px-3 py-2 border-b border-border/40 bg-background/40">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
            Most used
          </div>
          <div className="flex flex-wrap gap-1">
            {history.stats.topCommands.slice(0, 6).map((t) => (
              <Badge
                key={t.name}
                variant="outline"
                className="h-5 text-[10px] tabular-nums"
              >
                /{t.name} <span className="ml-1 opacity-70">×{t.count}</span>
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex-1 overflow-auto">
        {!history?.entries.length ? (
          <div className="p-6 text-center text-[12px] text-muted-foreground">
            No commands received yet. Send a slash command from Telegram to see
            it here.
          </div>
        ) : (
          <ul className="divide-y divide-border/30">
            {history.entries.map((e, i) => (
              <HistoryRow key={`${e.at}-${i}`} entry={e} />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

const OUTCOME_META: Record<
  HistoryEntry["outcome"],
  { icon: string; tone: string }
> = {
  ok: { icon: "🟢", tone: "text-emerald-300" },
  denied: { icon: "🚫", tone: "text-amber-300" },
  unknown: { icon: "❓", tone: "text-sky-300" },
  error: { icon: "🔴", tone: "text-rose-300" },
};

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const meta = OUTCOME_META[entry.outcome];
  return (
    <li className="px-3 py-2 hover:bg-muted/30 transition-colors">
      <div className="flex items-center justify-between gap-2 min-w-0">
        <code className="font-mono text-[11px] font-semibold text-cyan-300 truncate">
          /{entry.command}
        </code>
        <span className={cn("text-[10px] shrink-0", meta.tone)}>
          {meta.icon} {entry.outcome}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 mt-0.5 text-[10px] text-muted-foreground">
        <span className="truncate">{entry.text}</span>
        <span className="tabular-nums shrink-0">
          {entry.durationMs}ms · {relativeTime(entry.at)}
        </span>
      </div>
      {entry.error && (
        <div className="mt-1 text-[10px] text-rose-300 truncate font-mono">
          {entry.error}
        </div>
      )}
    </li>
  );
}
