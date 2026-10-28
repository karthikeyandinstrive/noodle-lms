"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

/** ISO string → value of <input type="datetime-local"> in the viewer's timezone. */
export const toLocalInput = (iso: unknown) => {
  if (typeof iso !== "string" || !iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
/** datetime-local value → ISO string (null when empty). */
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

export const selectClass = "h-8 w-full rounded-lg border bg-background px-2 text-sm";

export function DateField({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: unknown;
  onChange: (iso: string | null) => void;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="datetime-local" value={toLocalInput(value)} onChange={(e) => onChange(fromLocalInput(e.target.value))} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function NumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  step,
  nullable,
  hint,
}: {
  id: string;
  label: string;
  value: unknown;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  step?: number | "any";
  nullable?: boolean;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step ?? "any"}
        value={typeof value === "number" ? value : ""}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") onChange(nullable ? null : (min ?? 0));
          else onChange(Number(raw));
        }}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function SwitchField({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <Switch className="mt-0.5" checked={checked} onCheckedChange={(c) => onChange(c)} />
      <span>
        {label}
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Human "in 3 days" / "2 hours ago" relative to now. */
export function relativeTime(iso: string | null, now = Date.now()) {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  for (const [ms, name] of units) {
    if (abs >= ms) {
      const n = Math.round(abs / ms);
      return diff > 0 ? `in ${n} ${name}${n > 1 ? "s" : ""}` : `${n} ${name}${n > 1 ? "s" : ""} ago`;
    }
  }
  return diff > 0 ? "in less than a minute" : "just now";
}
