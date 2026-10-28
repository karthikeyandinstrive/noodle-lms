import { GraduationCap } from "lucide-react";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-muted/40 px-4 py-10">
      <div className="mb-6 flex items-center gap-2 text-lg font-semibold">
        <GraduationCap className="size-6 text-primary" /> LMS
      </div>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
