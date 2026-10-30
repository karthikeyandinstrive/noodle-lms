"use client";

import {
  Activity,
  Award,
  BarChart3,
  Bell,
  BookOpen,
  Building2,
  CalendarDays,
  ClipboardList,
  CreditCard,
  FolderTree,
  GraduationCap,
  HardDrive,
  KeyRound,
  Languages,
  LayoutDashboard,
  LibraryBig,
  LogOut,
  Medal,
  MessageSquare,
  Plug,
  Search,
  ScrollText,
  ShieldCheck,
  User,
  Users,
  UsersRound,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { LOCALES, type Locale, setStoredLocale, useLocale, useT } from "@/lib/i18n";
import { meKey, useLogout, useSession } from "@/lib/session";
import { messagingKeys } from "@/features/messaging/types";
import { notificationsKey } from "@/features/notifications/types";

type NavItem = { href: string; key: string; label: string; icon: React.ComponentType<{ className?: string }>; capability?: string; badge?: "messages" };

const LEARN: NavItem[] = [
  { href: "/dashboard", key: "nav.dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/courses?mine=1", key: "nav.myCourses", label: "My courses", icon: BookOpen },
  { href: "/catalog", key: "nav.catalog", label: "Course catalog", icon: LibraryBig },
  { href: "/messages", key: "nav.messages", label: "Messages", icon: MessageSquare, badge: "messages" },
  { href: "/calendar", key: "nav.calendar", label: "Calendar", icon: CalendarDays },
  { href: "/grades", key: "nav.grades", label: "My grades", icon: ClipboardList },
  { href: "/achievements", key: "nav.achievements", label: "Certificates & badges", icon: Medal },
];

const ADMIN: NavItem[] = [
  { href: "/admin/users", key: "nav.admin.users", label: "Users", icon: Users, capability: "user:view" },
  { href: "/admin/cohorts", key: "nav.admin.cohorts", label: "Cohorts", icon: UsersRound, capability: "cohort:manage" },
  { href: "/admin/roles", key: "nav.admin.roles", label: "Roles & permissions", icon: ShieldCheck, capability: "role:manage" },
  { href: "/admin/categories", key: "nav.admin.categories", label: "Categories", icon: FolderTree, capability: "category:manage" },
  { href: "/admin/reports", key: "nav.admin.reports", label: "Reports", icon: BarChart3, capability: "report:view_site" },
  { href: "/admin/certificates", key: "nav.admin.certificates", label: "Certificate templates", icon: Award, capability: "certificate:manage_templates" },
  { href: "/admin/badges", key: "nav.admin.badges", label: "Site badges", icon: Medal, capability: "badge:manage" },
  { href: "/admin/organization", key: "nav.admin.organization", label: "Organization", icon: Building2, capability: "site:config" },
  { href: "/admin/storage", key: "nav.admin.storage", label: "File storage", icon: HardDrive, capability: "storage:manage" },
  { href: "/admin/payments", key: "nav.admin.payments", label: "Payments", icon: CreditCard, capability: "payment:manage" },
  { href: "/admin/billing", key: "nav.admin.billing", label: "Subscription", icon: Wallet, capability: "billing:manage" },
  { href: "/admin/sso", key: "nav.admin.sso", label: "Single sign-on", icon: KeyRound, capability: "site:manage_sso" },
  { href: "/admin/lti", key: "nav.admin.lti", label: "External tools (LTI)", icon: Plug, capability: "lti:manage_tools" },
  { href: "/admin/system", key: "nav.admin.system", label: "System status", icon: Activity, capability: "site:view_system" },
  { href: "/admin/audit-log", key: "nav.admin.auditLog", label: "Audit log", icon: ScrollText, capability: "site:view_audit_log" },
];

/**
 * Live updates: the API streams "a conversation changed" / "my notifications changed" hints
 * (server-sent events) and we refetch through the normal API. Polling stays on as the fallback
 * if the stream drops.
 */
function useLiveUpdates(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    const source = new EventSource("/api/v1/messages/stream");
    const onMessage = () => void qc.invalidateQueries({ queryKey: messagingKeys.all });
    const onNotification = () => void qc.invalidateQueries({ queryKey: notificationsKey });
    source.addEventListener("message", onMessage);
    source.addEventListener("notification", onNotification);
    return () => {
      source.removeEventListener("message", onMessage);
      source.removeEventListener("notification", onNotification);
      source.close();
    };
  }, [enabled, qc]);
}

function NotificationBell() {
  const t = useT();
  const { data } = useQuery({
    queryKey: [...notificationsKey, "unread-count"],
    queryFn: () => api<{ count: number }>("/notifications/unread-count").catch(() => ({ count: 0 })),
    refetchInterval: 60_000,
  });
  const count = data?.count ?? 0;
  const label = count
    ? t("nav.notificationsUnread", "Notifications ({count} unread)", { count: count > 99 ? "99+" : count })
    : t("nav.notifications", "Notifications");
  return (
    <Link href="/notifications" aria-label={label} title={label} className={buttonVariants({ variant: "ghost", size: "icon" })}>
      <span className="relative">
        <Bell aria-hidden />
        {!!count && (
          <span aria-hidden className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] text-white">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </span>
    </Link>
  );
}

/** Account-menu language picker: remembers the choice locally and saves it to the profile. */
function LanguageMenu({ signedIn }: { signedIn: boolean }) {
  const t = useT();
  const locale = useLocale();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (next: Locale) => api("/users/me", { method: "PATCH", body: { locale: next } }),
    onSettled: () => qc.invalidateQueries({ queryKey: meKey }),
  });
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Languages /> {t("nav.language", "Language")}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup
          value={locale}
          onValueChange={(v) => {
            const next = v as Locale;
            setStoredLocale(next);
            if (signedIn) save.mutate(next);
          }}
        >
          {(Object.keys(LOCALES) as Locale[]).map((l) => (
            <DropdownMenuRadioItem key={l} value={l} lang={l}>
              {LOCALES[l]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const logout = useLogout();
  const t = useT();
  useLiveUpdates(!!session.user);
  const unreadMessages = useQuery({
    queryKey: messagingKeys.unread,
    queryFn: () => api<{ count: number }>("/messages/unread-count").catch(() => ({ count: 0 })),
    enabled: !!session.user,
    refetchInterval: 60_000,
  }).data?.count ?? 0;

  useEffect(() => {
    if (session.isSuccess && !session.user) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    else if (session.data?.mfaEnrollmentRequired) router.replace(`/mfa-setup?next=${encodeURIComponent(pathname)}`);
  }, [session.isSuccess, session.user, session.data?.mfaEnrollmentRequired, pathname, router]);

  if (!session.user) {
    return (
      <div className="flex min-h-screen items-center justify-center" aria-busy="true">
        <span className="sr-only">{t("common.loading", "Loading…")}</span>
        <Skeleton className="h-10 w-40" />
      </div>
    );
  }

  const admin = ADMIN.filter((i) => !i.capability || session.can(i.capability));
  const isActive = (href: string) => pathname === href.split("?")[0] || (href !== "/dashboard" && pathname.startsWith(href.split("?")[0]!));
  const initials = `${session.user.firstName[0] ?? ""}${session.user.lastName[0] ?? ""}`;

  const renderItem = (item: NavItem) => {
    const active = isActive(item.href);
    const badge = item.badge === "messages" ? unreadMessages : 0;
    const label = t(item.key, item.label);
    const fullLabel = badge ? t("nav.messagesUnread", "Messages ({count} unread)", { count: badge > 99 ? "99+" : badge }) : label;
    return (
      <SidebarMenuItem key={item.href}>
        <SidebarMenuButton
          isActive={active}
          tooltip={fullLabel}
          aria-label={badge ? fullLabel : undefined}
          render={<Link href={item.href} aria-current={active ? "page" : undefined} />}
        >
          <item.icon />
          <span>{label}</span>
        </SidebarMenuButton>
        {!!badge && <SidebarMenuBadge aria-hidden>{badge > 99 ? "99+" : badge}</SidebarMenuBadge>}
      </SidebarMenuItem>
    );
  };

  return (
    <SidebarProvider>
      <a
        href="#main-content"
        className="sr-only z-50 rounded-md bg-background px-3 py-2 text-sm font-medium shadow focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:ring-2 focus:ring-ring"
      >
        {t("nav.skipToContent", "Skip to content")}
      </a>
      <Sidebar collapsible="icon" aria-label={t("nav.mainNavigation", "Main navigation")}>
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" render={<Link href="/dashboard" />}>
                <GraduationCap className="text-primary" aria-hidden />
                <span className="truncate font-semibold">{session.organization?.name ?? "LMS"}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>{t("nav.learning", "Learning")}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>{LEARN.map(renderItem)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          {admin.length > 0 && (
            <SidebarGroup>
              <SidebarGroupLabel>{t("nav.administration", "Administration")}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>{admin.map(renderItem)}</SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname === "/profile"}
                render={<Link href="/profile" aria-current={pathname === "/profile" ? "page" : undefined} />}
                tooltip={t("nav.profile", "Profile")}
              >
                <User />
                <span className="truncate">
                  {session.user.firstName} {session.user.lastName}
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur">
          <SidebarTrigger aria-label={t("nav.toggleSidebar", "Toggle sidebar")} />
          <div className="flex-1" />
          <Link href="/search" aria-label={t("common.search", "Search")} title={t("common.search", "Search")} className={buttonVariants({ variant: "ghost", size: "icon" })}>
            <Search aria-hidden />
          </Link>
          <NotificationBell />
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={t("nav.accountMenu", "Account menu")} />}>
              <Avatar className="size-7">
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="truncate">{session.user.email}</DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => router.push("/profile")}>
                <User /> {t("nav.profileSecurity", "Profile & security")}
              </DropdownMenuItem>
              <LanguageMenu signedIn={!!session.user} />
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void logout()}>
                <LogOut /> {t("nav.signOut", "Sign out")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 p-4 outline-none md:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
