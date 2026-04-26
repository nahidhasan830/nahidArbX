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
 * Sidebar open/collapsed state persists via the shadcn `sidebar_state`
 * cookie — the choice follows the user across routes rather than resetting
 * per-page. ⌘B toggles the rail; the toggle writes the cookie.
 *
 * Cmd-K opens a command palette with three groups:
 *   Navigate · Actions · (future) Jump to event
 */
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Brain,
  FlaskConical,
  History,
  LayoutDashboard,
  LineChart,
  MessageCircleMore,
  Settings,
  TrendingUp,
  RefreshCw,
  KeySquare,
  Sparkles,
  ChevronRight,
  Search,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Feature } from "@/components/auth/AuthProvider";
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
import { ProfileMenu } from "@/components/auth/ProfileMenu";
import { UserManagementModal } from "@/components/auth/UserManagementModal";
import { cn } from "@/lib/utils";

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Optional AuthProvider Feature id — hides the entry when denied. */
  feature?: string;
  /** When true, renders as a disabled entry with a "soon" badge. */
  comingSoon?: boolean;
};

type NavSection = {
  label: string;
  items: NavItem[];
};

const NAV_SECTIONS: NavSection[] = [
  {
    label: "Main",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/value-bets", label: "Value Bets", icon: TrendingUp },
      { href: "/bets", label: "Bets", icon: History },
    ],
  },
  {
    label: "Lab",
    items: [
      {
        href: "/matcher-lab",
        label: "Matcher Lab",
        icon: Brain,
        feature: "matcher-lab",
      },
      {
        href: "/lab/optimisation",
        label: "Optimisation",
        icon: FlaskConical,
      },
    ],
  },
  {
    label: "Control",
    items: [{ href: "/telegram", label: "Telegram", icon: MessageCircleMore }],
  },
];

// Flat list for the Cmd-K palette — skip coming-soon entries so the
// palette only routes to real pages.
const NAV_FLAT: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items).filter(
  (i) => !i.comingSoon,
);

const SIDEBAR_COOKIE_NAME = "sidebar_state";

function readSidebarCookie(): boolean {
  const entry = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${SIDEBAR_COOKIE_NAME}=`));
  if (!entry) return true;
  return entry.slice(SIDEBAR_COOKIE_NAME.length + 1) === "true";
}

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
  const [showUserManagement, setShowUserManagement] = React.useState(false);

  const [sidebarOpen, setSidebarOpen] = React.useState(true);
  React.useEffect(() => {
    setSidebarOpen(readSidebarCookie());
  }, []);

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
      console.log(`[cmd-k] ${label}:`, res.status);
    } catch (err) {
      console.error(`[cmd-k] ${label} failed`, err);
    }
  };

  return (
    <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
      <Sidebar variant="inset" collapsible="icon">
        {/* ─── Sidebar Header: Logo + Brand ─── */}
        <SidebarHeader className="relative border-b border-sidebar-border">
          <Link
            href="/dashboard"
            className="flex items-center gap-2.5 px-2 py-2 group"
          >
            {/* Glowing icon mark */}
            <div className="flex items-center justify-center size-7 rounded-lg shrink-0 bg-cyan-500/[0.08] border border-cyan-400/[0.25] shadow-[0_0_12px_rgba(34,211,238,0.12),inset_0_1px_0_rgba(255,255,255,0.06)] transition-all duration-300 group-hover:border-cyan-400/50 group-hover:shadow-[0_0_20px_rgba(34,211,238,0.25),0_0_40px_rgba(34,211,238,0.10),inset_0_1px_0_rgba(255,255,255,0.10)] group-hover:scale-105">
              <LineChart className="size-4 text-cyan-400" />
            </div>
            <span className="group-data-[collapsible=icon]:hidden">
              <BrandLogo size="sm" />
            </span>
          </Link>
        </SidebarHeader>

        {/* ─── Nav Sections ─── */}
        <SidebarContent>
          {NAV_SECTIONS.map((section) => (
            <SidebarGroup key={section.label}>
              <SidebarGroupLabel className="!flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.08em] uppercase text-muted-foreground/70">
                <span className="size-1 rounded-full shrink-0 bg-cyan-400/50" />
                {section.label}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {section.items.map((item) => {
                    const Icon = item.icon;
                    const active =
                      pathname === item.href ||
                      (item.href !== "/" && pathname.startsWith(item.href));
                    const entry = item.comingSoon ? (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton
                          disabled
                          tooltip={`${item.label} (soon)`}
                          className="opacity-40 cursor-not-allowed"
                        >
                          <Icon className="size-4" />
                          <span>{item.label}</span>
                          <span className="ml-auto text-[8px] uppercase tracking-wider text-muted-foreground/60 font-semibold group-data-[collapsible=icon]:hidden px-1.5 py-0.5 rounded-full bg-muted/30">
                            soon
                          </span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ) : (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton
                          asChild
                          isActive={active}
                          tooltip={item.label}
                          className={cn(
                            "relative transition-colors",
                            active &&
                              "before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:w-[3px] before:h-3/5 before:rounded-r-[3px] before:bg-gradient-to-b before:from-cyan-400 before:to-blue-500 before:shadow-[0_0_8px_rgba(34,211,238,0.5),0_0_16px_rgba(34,211,238,0.2)]",
                            !active &&
                              "hover:before:absolute hover:before:left-0 hover:before:top-1/2 hover:before:-translate-y-1/2 hover:before:w-[3px] hover:before:h-3/5 hover:before:rounded-r-[3px] hover:before:bg-cyan-400/40",
                          )}
                        >
                          <Link href={item.href}>
                            <Icon className="size-4" />
                            <span>{item.label}</span>
                            {active && (
                              <ChevronRight className="ml-auto size-3 text-cyan-400/60 group-data-[collapsible=icon]:hidden" />
                            )}
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                    return item.feature ? (
                      <Feature key={item.href} id={item.feature}>
                        {entry}
                      </Feature>
                    ) : (
                      entry
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>

        {/* ─── Sidebar Footer: Unified Control Dock ─── */}
        <SidebarFooter className="!p-0 !gap-0">
          {/* Expanded mode: unified control dock */}
          <div className="m-2 rounded-[10px] overflow-hidden border border-sidebar-border bg-gradient-to-b from-card/80 to-background/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_-1px_3px_rgba(0,0,0,0.10)] group-data-[collapsible=icon]:hidden">
            {/* Search trigger row */}
            <button
              type="button"
              onClick={() => setCmdOpen(true)}
              className="group/search flex items-center gap-1.5 w-full px-2.5 py-2 border-b border-sidebar-border bg-transparent text-[11.5px] text-muted-foreground/60 cursor-pointer transition-colors hover:bg-foreground/5 hover:text-foreground/70"
            >
              <Search className="size-3 shrink-0 text-muted-foreground/40 transition-colors group-hover/search:text-cyan-400" />
              <span>Search…</span>
              <kbd className="ml-auto font-mono text-[9px] leading-none tracking-wider px-1 py-0.5 rounded-[3px] bg-background border border-sidebar-border text-cyan-400/60">
                ⌘K
              </kbd>
            </button>

            {/* Profile + status row */}
            <div className="border-b border-sidebar-border [&_[data-sidebar=menu-button][data-size=lg]]:h-11 [&_[data-sidebar=menu-button][data-size=lg]]:px-2 [&_[data-sidebar=menu-button][data-size=lg]]:py-1.5 [&_[data-sidebar=menu-button]>div:first-child]:size-7 [&_[data-sidebar=menu-button]>div:first-child_svg]:size-3.5">
              <ProfileMenu
                onOpenUserManagement={() => setShowUserManagement(true)}
              />
            </div>

            {/* Ambient status strip */}
            <SessionPill />
          </div>

          {/* Collapsed mode: icon-only controls */}
          <div className="hidden group-data-[collapsible=icon]:flex flex-col gap-1 px-1 py-1.5">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="Quick nav (⌘K)"
                  onClick={() => setCmdOpen(true)}
                >
                  <Search className="size-4" />
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <ProfileMenu
                  onOpenUserManagement={() => setShowUserManagement(true)}
                />
              </SidebarMenuItem>
            </SidebarMenu>
            <SessionPill />
          </div>
        </SidebarFooter>
      </Sidebar>

      {/* ─── Main Content Area ─── */}
      <SidebarInset>
        <header className="sticky top-0 z-20 border-b border-sidebar-border bg-background/90 backdrop-blur-xl backdrop-saturate-150">
          {/* Accent gradient line at top edge */}
          <div className="h-px bg-[linear-gradient(90deg,transparent_0%,oklch(0.72_0.16_190/0.4)_20%,oklch(0.6_0.2_230/0.3)_50%,oklch(0.72_0.16_190/0.4)_80%,transparent_100%)]" />

          <div className="flex h-12 items-center gap-2 px-3">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="h-4 bg-border/40" />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbPage className="text-[13px] font-semibold tracking-tight text-foreground/85">
                    {title}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            {titleBadge}
            <div className="ml-auto flex items-center gap-2">{actions}</div>
          </div>
        </header>

        <div
          className={
            edgeToEdge ? "flex flex-col flex-1 min-h-0 overflow-hidden" : "p-4"
          }
        >
          {children}
        </div>
      </SidebarInset>

      {/* ─── Command Palette (⌘K) ─── */}
      <CommandDialog open={cmdOpen} onOpenChange={setCmdOpen}>
        <CommandInput placeholder="Jump to page or run an action…" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          <CommandGroup heading="Navigate">
            {NAV_FLAT.map((item) => {
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
                  fetch("/api/accounts", { cache: "no-store" }),
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

      <UserManagementModal
        isOpen={showUserManagement}
        onClose={() => setShowUserManagement(false)}
      />
    </SidebarProvider>
  );
}
