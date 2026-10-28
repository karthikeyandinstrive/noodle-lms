"use client";

import { WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

/** Shown by the service worker when a page can't be loaded without a connection. */
export default function OfflinePage() {
  const t = useT();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <WifiOff aria-hidden className="size-10 text-muted-foreground" />
      <h1 className="text-xl font-semibold">{t("offline.title", "You're offline")}</h1>
      <p className="max-w-sm text-sm text-muted-foreground">{t("offline.body", "This page needs a connection. Check your network and try again; anything you saved before going offline is safe.")}</p>
      <Button onClick={() => window.location.reload()}>{t("offline.retry", "Try again")}</Button>
    </main>
  );
}
