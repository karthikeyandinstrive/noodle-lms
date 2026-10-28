"use client";

import {
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
  LayoutDashboard,
  LibraryBig,
  LogOut,
  Medal,
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
import { useQuery } from "@tanstack/react-query";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useLogout, useSession } from "@/lib/session";

type NavItem = { href: string; label: string; icon: React.ComponentType<{ className?: string }>; capability?: string };

const LEARN: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/courses?mine=1", label: "My courses", icon: BookOpen },
  { href: "/catalog", label: "Course catalog", icon: LibraryBig },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/grades", label: "My grades", icon: ClipboardList },
  { href: "/achievements", label: "Certificates & badges", icon: Medal },
];

const ADMIN: NavItem[] = [
  { href: "/admin/users", label: "Users", icon: Users, capability: "user:view" },
  { href: "/admin/cohorts", label: "Cohorts", icon: UsersRound, capability: "cohort:manage" },
  { href: "/admin/roles", label: "Roles & permissions", icon: ShieldCheck, capability: "role:manage" },
  { href: "/admin/categories", label: "Categories", icon: FolderTree, capability: "category:manage" },
  { href: "/admin/reports", label: "Reports", icon: BarChart3, capability: "report:view_site" },
  { href: "/admin/certificates", label: "Certificate templates", icon: Award, capability: "certificate:manage_templates" },
  { href: "/admin/badges", label: "Site badges", icon: Medal, capability: "badge:manage" },
  { href: "/admin/organization", label: "Organization", icon: Building2, capability: "site:config" },
  { href: "/admin/storage", label: "File storage", icon: HardDrive, capability: "storage:manage" },
  { href: "/admin/payments", label: "Payments", icon: CreditCard, capability: "payment:manage" },
  { href: "/admin/billing", label: "Subscription", icon: Wallet, capability: "billing:manage" },
  { href: "/admin/audit-log", label: "Audit log", icon: ScrollText, capability: "site:view_audit_log" },
];

function NotificationBell() {
  const { data } = useQuery({
    queryKey: ["notifications", "unread-count"],
    queryFn: () => api<{ count: number }>("/notifications/unread-count").catch(() => ({ count: 0 })),
    refetchInterval: 60_000,
  });
  return (
    <Button variant="ghost" size="icon" render={<Link href="/notifications" aria-label="Notifications" />}>
      <span className="relative">
        <Bell />
        {!!data?.count && (
          <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] text-white">
            {data.count > 99 ? "99+" : data.count}
          </span>
        )}
      </span>
    </Button>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const logout = useLogout();

  useEffect(() => {
    if (session.isSuccess && !session.user) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [session.isSuccess, session.user, pathname, router]);

  if (!session.user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Skeleton className="h-10 w-40" />
      </div>
    );
  }

  const admin = ADMIN.filter((i) => !i.capability || session.can(i.capability));
  const isActive = (href: string) => pathname === href.split("?")[0] || (href !== "/dashboard" && pathname.startsWith(href.split("?")[0]!));
  const initials = `${session.user.firstName[0] ?? ""}${session.user.lastName[0] ?? ""}`;

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" render={<Link href="/dashboard" />}>
                <GraduationCap className="text-primary" />
                <span className="truncate font-semibold">{session.organization?.name ?? "LMS"}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Learning</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {LEARN.map((item) => (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton isActive={isActive(item.href)} tooltip={item.label} render={<Link href={item.href} />}>
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          {admin.length > 0 && (
            <SidebarGroup>
              <SidebarGroupLabel>Administration</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {admin.map((item) => (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton isActive={isActive(item.href)} tooltip={item.label} render={<Link href={item.href} />}>
                        <item.icon />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton render={<Link href="/profile" />} tooltip="Profile">
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
          <SidebarTrigger />
          <div className="flex-1" />
          <NotificationBell />
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="Account menu" />}>
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
                <User /> Profile & security
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void logout()}>
                <LogOut /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 p-4 md:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
