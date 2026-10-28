"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { HtmlContent, formatDate } from "@/components/common";
import { NativeSelect } from "@/features/gradebook/native-select";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { TYPE_LABELS, TYPE_STYLES, calendarKey, type CalendarItem, type CalendarPermissions } from "./types";
import { toLocalInput } from "./utils";

export function useCalendarPermissions() {
  return useQuery({ queryKey: [...calendarKey, "permissions"], queryFn: () => api<CalendarPermissions>("/calendar/permissions"), staleTime: 5 * 60_000 });
}

type FormState = { type: "user" | "site" | "course"; courseId: string; name: string; startsAt: string; durationMinutes: string; description: string };

/** Create (event = undefined) or edit an event. */
export function EventFormDialog({ open, onClose, initialDate, event }: { open: boolean; onClose: () => void; initialDate?: Date; event?: CalendarItem }) {
  const qc = useQueryClient();
  const perms = useCalendarPermissions();
  const start = initialDate ?? new Date();
  const [form, setForm] = useState<FormState>(() => ({
    type: (event?.type as FormState["type"]) ?? "user",
    courseId: event?.courseId ?? "",
    name: event?.name ?? "",
    startsAt: toLocalInput(event ? new Date(event.startsAt) : new Date(start.getFullYear(), start.getMonth(), start.getDate(), 9, 0)),
    durationMinutes: String(event?.durationMinutes ?? 60),
    description: event?.description?.replace(/<[^>]+>/g, "") ?? "",
  }));
  const save = useMutation({
    mutationFn: () => {
      const base = {
        name: form.name,
        startsAt: new Date(form.startsAt).toISOString(),
        durationMinutes: Number(form.durationMinutes) || 0,
        description: form.description.trim() ? form.description.trim().replace(/\n/g, "<br>") : null,
      };
      return event
        ? api(`/calendar/events/${event.id}`, { method: "PATCH", body: base })
        : api("/calendar/events", { body: { ...base, type: form.type, courseId: form.type === "course" ? form.courseId : null } });
    },
    onSuccess: () => {
      toast.success(event ? "Event updated" : "Event added");
      void qc.invalidateQueries({ queryKey: calendarKey });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const courses = perms.data?.courses ?? [];
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{event ? "Edit event" : "New event"}</DialogTitle>
          <DialogDescription>{event ? TYPE_LABELS[event.type] : "Personal events are visible only to you."}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!form.startsAt || Number.isNaN(new Date(form.startsAt).getTime())) return toast.error("Choose a valid date and time");
            if (!event && form.type === "course" && !form.courseId) return toast.error("Choose a course");
            save.mutate();
          }}
        >
          {!event && (perms.data?.site || courses.length > 0) && (
            <div className="space-y-1.5">
              <Label htmlFor="ev-type">Type</Label>
              <NativeSelect id="ev-type" className="w-full" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as FormState["type"] })}>
                <option value="user">Personal</option>
                {courses.length > 0 && <option value="course">Course</option>}
                {perms.data?.site && <option value="site">Site (everyone)</option>}
              </NativeSelect>
            </div>
          )}
          {!event && form.type === "course" && (
            <div className="space-y-1.5">
              <Label htmlFor="ev-course">Course</Label>
              <NativeSelect id="ev-course" className="w-full" value={form.courseId} onChange={(e) => setForm({ ...form, courseId: e.target.value })} required>
                <option value="">Choose a course…</option>
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.fullname}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="ev-name">Title</Label>
            <Input id="ev-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={255} />
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
            <div className="space-y-1.5">
              <Label htmlFor="ev-start">Starts</Label>
              <Input id="ev-start" type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ev-duration">Minutes</Label>
              <Input id="ev-duration" type="number" min={0} max={10080} value={form.durationMinutes} onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ev-desc">Description</Label>
            <Textarea id="ev-desc" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={10000} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {event ? "Save" : "Add event"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EventDetailsDialog({ event, onClose, onEdit }: { event: CalendarItem | null; onClose: () => void; onEdit: (e: CalendarItem) => void }) {
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: string) => api(`/calendar/events/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Event deleted");
      void qc.invalidateQueries({ queryKey: calendarKey });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!event) return null;
  const start = new Date(event.startsAt);
  const end = new Date(start.getTime() + event.durationMinutes * 60_000);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{event.name}</DialogTitle>
          <DialogDescription>
            {formatDate(start)}
            {event.durationMinutes > 0 && ` – ${end.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Badge className={cn("border-0", TYPE_STYLES[event.type])}>{TYPE_LABELS[event.type]}</Badge>
            {event.courseName && <Badge variant="outline">{event.courseName}</Badge>}
          </div>
          <HtmlContent html={event.description} />
        </div>
        <DialogFooter>
          {event.editable && (
            <>
              <Button
                variant="destructive"
                disabled={remove.isPending}
                onClick={() => {
                  if (confirm(`Delete "${event.name}"?`)) remove.mutate(event.id);
                }}
              >
                Delete
              </Button>
              <Button variant="outline" onClick={() => onEdit(event)}>
                Edit
              </Button>
            </>
          )}
          {event.link && <Button render={<Link href={event.link} />}>{event.activityId ? "Open activity" : "Open course"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
