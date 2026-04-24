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
  Settings,
  TrendingUp,
  Command as CmdIcon,
  RefreshCw,
  KeySquare,
  Sparkles,
  ChevronRight,
  Zap,
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
        feature: "diagnostics",
      },
      {
        href: "/lab/alphasearch",
        label: "AlphaSearch",
        icon: FlaskConical,
      },
    ],
  },
];

// Flat list for the Cmd-K palette — skip coming-soon entries so the
// palette only routes to real pages.
const NAV_FLAT: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items).filter(
  (i) => !i.comingSoon,
);

const SIDEBAR_COOKIE_NAME = "sidebar_state";

// Read the persisted sidebar state from the cookie once on mount so the
// user's expand/collapse choice follows them across routes. Falls back to
// `true` (expanded) when no cookie is set.
function readSidebarCookie(): boolean {
  if (typeof document === "undefined") return true;
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

  const defaultOpen = React.useMemo(() => readSidebarCookie(), []);

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
        {/* ─── Sidebar Header: Logo + Brand ─── */}
        <SidebarHeader className="appshell-sidebar-header">
          <Link
            href="/dashboard"
            className="appshell-logo-link flex items-center gap-2.5 px-2 py-2 group"
          >
            {/* Glowing icon mark */}
            <div className="appshell-logo-mark">
              <LineChart className="size-4 text-cyan-400" />
            </div>
            <span className="group-data-[collapsible=icon]:hidden">
              <BrandLogo size="sm" />
            </span>
          </Link>
        </SidebarHeader>

        {/* ─── Nav Sections ─── */}
        <SidebarContent>
          {NAV_SECTIONS.map((section, sectionIdx) => (
            <SidebarGroup key={section.label}>
              <SidebarGroupLabel className="appshell-group-label">
                <span className="appshell-group-label-dot" />
                {section.label}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {section.items.map((item, itemIdx) => {
                    const Icon = item.icon;
                    const active =
                      pathname === item.href ||
                      (item.href !== "/" && pathname.startsWith(item.href));
                    const delay = (sectionIdx * 3 + itemIdx) * 40;
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
                      <SidebarMenuItem
                        key={item.href}
                        className="appshell-nav-item"
                        style={
                          {
                            "--nav-delay": `${delay}ms`,
                          } as React.CSSProperties
                        }
                      >
                        <SidebarMenuButton
                          asChild
                          isActive={active}
                          tooltip={item.label}
                          className={
                            active
                              ? "appshell-nav-btn--active"
                              : "appshell-nav-btn"
                          }
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
        <SidebarFooter className="appshell-sidebar-footer">
          {/* Expanded mode: unified control dock */}
          <div className="appshell-control-dock group-data-[collapsible=icon]:hidden">
            {/* Search trigger row */}
            <button
              type="button"
              onClick={() => setCmdOpen(true)}
              className="appshell-search-trigger"
            >
              <Search className="size-3 appshell-search-icon" />
              <span>Search…</span>
              <kbd className="appshell-kbd">⌘K</kbd>
            </button>

            {/* Profile + status row */}
            <div className="appshell-dock-profile-row">
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
        <header className="appshell-topbar">
          {/* Accent gradient line at top edge */}
          <div className="appshell-topbar-accent" />

          <div className="flex h-12 items-center gap-2 px-3">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="h-4 bg-border/40" />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbPage className="appshell-breadcrumb-page">
                    {title}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            {titleBadge}
            <div className="ml-auto flex items-center gap-2">{actions}</div>
          </div>
        </header>

        <div className={edgeToEdge ? "" : "p-4"}>{children}</div>
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
