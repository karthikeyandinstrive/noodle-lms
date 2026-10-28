"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ErrorAlert } from "@/components/common";
import { api } from "@/lib/api";
import { attendanceKeys, type Session } from "./api";

const toLocalInput = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const selectClass = "h-8 w-full rounded-lg border bg-background px-2 text-sm";

/**
 * Create (optionally weekly-repeating) or edit a session. When editing, an
 * empty code keeps the current one unless "remove code" is ticked.
 */
export function SessionDialog({
  activityId,
  groups,
  open,
  onOpenChange,
  session,
}: {
  activityId: string;
  groups: { id: string; name: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session?: Pick<Session, "id" | "startsAt" | "durationMinutes" | "description" | "groupId" | "hasCode">;
}) {
  const qc = useQueryClient();
  const editing = !!session;
  const [startsAt, setStartsAt] = useState(() => toLocalInput(session?.startsAt));
  const [duration, setDuration] = useState(String(session?.durationMinutes ?? 60));
  const [description, setDescription] = useState(session?.description ?? "");
  const [groupId, setGroupId] = useState(session?.groupId ?? "");
  const [code, setCode] = useState("");
  const [removeCode, setRemoveCode] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [until, setUntil] = useState("");

  const save = useMutation({
    mutationFn: async () => {
      const common = {
        startsAt: new Date(startsAt).toISOString(),
        durationMinutes: Number(duration),
        description: description.trim() || null,
        groupId: groupId || null,
      };
      if (editing) {
        return api(`/attendance/${activityId}/sessions/${session!.id}`, {
          method: "PATCH",
          body: { ...common, ...(removeCode ? { selfMarkCode: null } : code.trim() ? { selfMarkCode: code.trim() } : {}) },
        });
      }
      return api<{ created: number }>(`/attendance/${activityId}/sessions`, {
        body: {
          ...common,
          ...(code.trim() ? { selfMarkCode: code.trim() } : {}),
          ...(repeat && until ? { repeatUntil: new Date(`${until}T23:59:59`).toISOString() } : {}),
        },
      });
    },
    onSuccess: async (r) => {
      const created = (r as { created?: number } | undefined)?.created;
      toast.success(editing ? "Session updated" : `${created ?? 1} session${created === 1 ? "" : "s"} added`);
      onOpenChange(false);
      await qc.invalidateQueries({ queryKey: attendanceKeys.all(activityId) });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{editing ? "Edit session" : "Add sessions"}</DialogTitle>
            <DialogDescription>Sessions appear in the course calendar.</DialogDescription>
          </DialogHeader>
          {save.isError && <ErrorAlert error={save.error} />}
          <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
            <div className="space-y-1.5">
              <Label htmlFor="s-start">Starts</Label>
              <Input id="s-start" type="datetime-local" required value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s-dur">Minutes</Label>
              <Input id="s-dur" type="number" min={5} max={1440} required value={duration} onChange={(e) => setDuration(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-desc">Description</Label>
            <Input id="s-desc" maxLength={1000} placeholder="e.g. Lecture 3 — Room B12" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          {groups.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="s-group">Audience</Label>
              <select id="s-group" className={selectClass} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                <option value="">All students</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="s-code">Self-marking code {editing && session?.hasCode && <span className="font-normal text-muted-foreground">(a code is set)</span>}</Label>
            <Input
              id="s-code"
              minLength={4}
              maxLength={32}
              autoComplete="off"
              placeholder={editing && session?.hasCode ? "Leave empty to keep the current code" : "Optional, 4–32 characters"}
              value={code}
              disabled={removeCode}
              onChange={(e) => setCode(e.target.value)}
            />
            {editing && session?.hasCode && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={removeCode} onChange={(e) => setRemoveCode(e.target.checked)} /> Remove the code
              </label>
            )}
            <p className="text-xs text-muted-foreground">Students enter it to mark themselves present. It is stored hashed and can&apos;t be shown again.</p>
          </div>
          {!editing && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Switch id="s-repeat" checked={repeat} onCheckedChange={setRepeat} />
                <Label htmlFor="s-repeat" className="font-normal">
                  Repeat weekly
                </Label>
              </div>
              {repeat && (
                <div className="space-y-1.5">
                  <Label htmlFor="s-until">Until</Label>
                  <Input id="s-until" type="date" required value={until} min={startsAt.slice(0, 10)} onChange={(e) => setUntil(e.target.value)} />
                  <p className="text-xs text-muted-foreground">Up to 52 sessions.</p>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending || !startsAt}>
              {save.isPending ? "Saving…" : editing ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
