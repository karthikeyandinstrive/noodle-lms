"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError } from "@/lib/api";
import { LocaleProvider, useLocale } from "@/lib/i18n";
import { useSession } from "@/lib/session";

/** Keeps `<html lang>` in sync with the active locale (the server renders "en"). */
function HtmlLang() {
  const locale = useLocale();
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return null;
}

/** Registers the service worker (installable app + offline page). Production only: it would cache dev builds. */
function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
      /* unsupported or blocked: the app works without it */
    });
  }, []);
  return null;
}

/** Applies the signed-in user's locale (needs the query client, so it sits inside the provider). */
function SessionLocale({ children }: { children: React.ReactNode }) {
  const { user } = useSession();
  return (
    <LocaleProvider userLocale={user?.locale}>
      <HtmlLang />
      <ServiceWorker />
      {children}
    </LocaleProvider>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            refetchOnWindowFocus: false,
            // Don't retry client errors (401/403/404…).
            retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
          },
        },
      }),
  );
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={client}>
        <SessionLocale>
          <TooltipProvider>
            {children}
            <Toaster richColors position="top-right" />
          </TooltipProvider>
        </SessionLocale>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
