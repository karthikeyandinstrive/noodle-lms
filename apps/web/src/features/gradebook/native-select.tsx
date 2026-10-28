"use client";

import { cn } from "@/lib/utils";

/**
 * Styled native <select>: fully keyboard/screen-reader accessible and works well on mobile.
 * Shared by the gradebook, completion, calendar and report screens.
 */
export function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30",
        className,
      )}
      {...props}
    />
  );
}
