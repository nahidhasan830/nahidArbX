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
          {NAV_SECTIONS.map((section) => (
            <SidebarGroup key={section.label}>
              <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
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
                          className="opacity-60 cursor-not-allowed"
                        >
                          <Icon className="size-4" />
                          <span>{item.label}</span>
                          <span className="ml-auto text-[9px] uppercase tracking-wide text-muted-foreground group-data-[collapsible=icon]:hidden">
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
                        >
                          <Link href={item.href}>
                            <Icon className="size-4" />
                            <span>{item.label}</span>
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

        <SidebarFooter>
          <SidebarMenu className="gap-1 border-t border-sidebar-border pt-2">
            <SidebarMenuItem>
              <ProfileMenu
                onOpenUserManagement={() => setShowUserManagement(true)}
              />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Quick nav (⌘K)"
                onClick={() => setCmdOpen(true)}
              >
                <CmdIcon />
                <span>Quick nav</span>
                <kbd className="ml-auto text-[10px] font-mono bg-muted px-1 py-0.5 rounded border border-border group-data-[collapsible=icon]:hidden">
                  ⌘K
                </kbd>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SessionPill />
            </SidebarMenuItem>
          </SidebarMenu>
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
