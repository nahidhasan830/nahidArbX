"use client";

/**
 * Global app shell — collapsible left rail + per-page top bar + Cmd-K
 * quick-nav. Every authed page wraps its content in `<AppShell>` and
 * passes a `title` plus optional `actions` (the right-side controls
 * that used to live in each page's custom header).
 *
 *   <AppShell title="Dashboard" actions={<Button>Refresh</Button>}>
 *     <DashboardContent />
 *   </AppShell>
 *
 * The rail is:
 *   - icon-collapsed by default on `/value-bets` and `/backtest`
 *     (data-dense pages that need horizontal real-estate)
 *   - expanded by default on `/dashboard`
 *   - toggled via the header's SidebarTrigger OR ⌘B
 *
 * Cmd-K opens a command palette with three groups:
 *   Navigate · Actions · (future) Jump to event
 */
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  History,
  LayoutDashboard,
  LineChart,
  Settings,
  TrendingUp,
  Command as CmdIcon,
  RefreshCw,
  KeySquare,
  Sparkles,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { SessionPill } from "./SessionPill";

const NAV: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/value-bets", label: "Value Bets", icon: TrendingUp },
  { href: "/backtest", label: "Backtest", icon: History },
];

// Pages where the rail starts icon-collapsed (they need max horizontal
// space for tables). Users can still expand with ⌘B or the trigger.
const DENSE_PAGES = ["/value-bets", "/backtest"];

export interface AppShellProps {
  title: string;
  /** Optional pill/badge rendered next to the title. */
  titleBadge?: React.ReactNode;
  /** Page-scoped right-side controls in the top bar. */
  actions?: React.ReactNode;
  /** When true, main content gets no padding (for edge-to-edge spreadsheets). */
  edgeToEdge?: boolean;
  children: React.ReactNode;
}

export function AppShell({
  title,
  titleBadge,
  actions,
  edgeToEdge,
  children,
}: AppShellProps) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const [cmdOpen, setCmdOpen] = React.useState(false);

  const defaultOpen = !DENSE_PAGES.some((p) => pathname.startsWith(p));

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (href: string) => {
    setCmdOpen(false);
    router.push(href);
  };

  const runAction = async (
    label: string,
    req: () => Promise<Response>,
  ): Promise<void> => {
    setCmdOpen(false);
    try {
      const res = await req();
      // eslint-disable-next-line no-console
      console.log(`[cmd-k] ${label}:`, res.status);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[cmd-k] ${label} failed`, err);
    }
  };

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <Sidebar variant="inset" collapsible="icon">
        <SidebarHeader>
          <Link
            href="/dashboard"
            className="flex items-center gap-2 px-2 py-1.5 group"
          >
            <LineChart className="size-5 text-primary" />
            <span className="group-data-[collapsible=icon]:hidden">
              <BrandLogo size="sm" />
            </span>
          </Link>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV.map((item) => {
                  const Icon = item.icon;
                  const active =
                    pathname === item.href ||
                    (item.href !== "/" && pathname.startsWith(item.href));
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        tooltip={item.label}
                      >
                        <Link href={item.href}>
                          <Icon className="size-4" />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <SessionPill />
          <button
            type="button"
            onClick={() => setCmdOpen(true)}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
          >
            <CmdIcon className="size-3.5 shrink-0" />
            <span className="group-data-[collapsible=icon]:hidden flex-1 text-left">
              Quick nav
            </span>
            <kbd className="group-data-[collapsible=icon]:hidden ml-auto text-[10px] font-mono bg-muted px-1 py-0.5 rounded border border-border">
              ⌘K
            </kbd>
          </button>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background/80 backdrop-blur px-3">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage className="text-sm font-medium">
                  {title}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          {titleBadge}
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        </header>

        <div className={edgeToEdge ? "" : "p-4"}>{children}</div>
      </SidebarInset>

      <CommandDialog open={cmdOpen} onOpenChange={setCmdOpen}>
        <CommandInput placeholder="Jump to page or run an action…" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          <CommandGroup heading="Navigate">
            {NAV.map((item) => {
              const Icon = item.icon;
              return (
                <CommandItem
                  key={item.href}
                  value={`navigate ${item.label}`}
                  onSelect={() => go(item.href)}
                >
                  <Icon className="mr-2 size-4" />
                  {item.label}
                </CommandItem>
              );
            })}
            <CommandItem
              value="navigate settings"
              onSelect={() => go("/settings")}
            >
              <Settings className="mr-2 size-4" />
              Settings
              <span className="ml-auto text-[10px] text-muted-foreground">
                soon
              </span>
            </CommandItem>
          </CommandGroup>

          <CommandSeparator />

          <CommandGroup heading="Actions">
            <CommandItem
              value="sync now"
              onSelect={() =>
                runAction("sync-now", () =>
                  fetch("/api/value-bets", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "syncNow" }),
                  }),
                )
              }
            >
              <RefreshCw className="mr-2 size-4" />
              Sync now
            </CommandItem>
            <CommandItem
              value="refresh balances"
              onSelect={() =>
                runAction("refresh-balances", () =>
                  fetch("/api/betting-accounts", { cache: "no-store" }),
                )
              }
            >
              <Sparkles className="mr-2 size-4" />
              Refresh betting balances
            </CommandItem>
            <CommandItem
              value="capture pinnacle token"
              onSelect={() =>
                runAction("pinnacle-token", () =>
                  fetch("/api/auth/refresh-pinnacle", { method: "POST" }),
                )
              }
            >
              <KeySquare className="mr-2 size-4" />
              Capture Pinnacle token
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </SidebarProvider>
  );
}
