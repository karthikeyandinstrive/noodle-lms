"use client";

import { Medal } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { badgeImageUrl } from "./types";

/** Badge artwork (public URL) with an icon fallback. Decorative: the badge name is always shown next to it. */
export function BadgeImage({ badgeId, hasImage, className, muted }: { badgeId: string; hasImage: boolean; className?: string; muted?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (!hasImage || failed) {
    return (
      <span className={cn("flex shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300", muted && "opacity-40 grayscale", className)} aria-hidden>
        <Medal className="size-1/2" />
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={badgeImageUrl(badgeId)}
      alt=""
      onError={() => setFailed(true)}
      className={cn("shrink-0 rounded-full object-cover", muted && "opacity-40 grayscale", className)}
    />
  );
}
